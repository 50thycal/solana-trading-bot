import { logger } from '../helpers';
import { getStateStore, TradeRecord as DbTradeRecord } from '../persistence';

/**
 * Trade record structure (for API compatibility)
 */
export interface TradeRecord {
  id: string;
  type: 'buy' | 'sell';
  tokenMint: string;
  tokenSymbol?: string;
  amountSol: number;
  amountToken: number;
  pricePerToken: number;
  timestamp: number;
  txSignature?: string;
  poolId: string;
  positionId?: string;
}

/**
 * Session statistics
 */
export interface SessionStats {
  startTime: number | null;
  totalBuys: number;
  totalSells: number;
  realizedPnlSol: number;
}

/**
 * Position P&L record
 */
export interface PositionPnl {
  tokenMint: string;
  entryAmountSol: number;
  currentValueSol: number;
  unrealizedPnlSol: number;
  unrealizedPnlPercent: number;
}

/**
 * P&L Tracker for recording trades and calculating profit/loss.
 * Uses SQLite persistence via StateStore (Phase 3).
 *
 * Session stats are tracked in memory for the current session,
 * while trades are persisted to SQLite for recovery.
 */
export class PnlTracker {
  private sessionStats: SessionStats;
  private initialized: boolean = false;

  constructor() {
    this.sessionStats = {
      startTime: null,
      totalBuys: 0,
      totalSells: 0,
      realizedPnlSol: 0,
    };
  }

  /**
   * Initialize tracker by loading stats from SQLite database
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const stateStore = getStateStore();
      if (stateStore) {
        // Load cumulative stats from database
        const stats = stateStore.getTradeStats();
        this.sessionStats.realizedPnlSol = stats.realizedPnlSol;
      }

      this.sessionStats.startTime = Date.now();
      this.initialized = true;

      const tradeCount = this.getAllTrades().length;
      logger.info(
        {
          existingTrades: tradeCount,
          sessionStart: new Date(this.sessionStats.startTime).toISOString(),
          cumulativeRealizedPnl: this.sessionStats.realizedPnlSol.toFixed(4),
        },
        'P&L tracker initialized',
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to load P&L data, starting fresh');
      this.sessionStats.startTime = Date.now();
      this.initialized = true;
    }
  }

  /**
   * Force immediate save (for shutdown) - now a no-op since SQLite is synchronous
   */
  async forceSave(): Promise<void> {
    // SQLite writes are synchronous, no need to flush
    logger.debug('P&L data saved (SQLite)');
  }

  /**
   * Record a buy trade
   */
  recordBuy(params: {
    tokenMint: string;
    tokenSymbol?: string;
    amountSol: number;
    amountToken: number;
    poolId: string;
    txSignature?: string;
  }): TradeRecord {
    const stateStore = getStateStore();

    // Record trade intent if we have a state store
    let tradeId: string;
    if (stateStore) {
      const dbTrade = stateStore.recordTradeIntent({
        type: 'buy',
        tokenMint: params.tokenMint,
        amountSol: params.amountSol,
        amountToken: params.amountToken,
        poolId: params.poolId,
        positionId: params.tokenMint, // Use token mint as position ID
      });
      tradeId = dbTrade.id;

      // Confirm immediately if we have a signature
      if (params.txSignature) {
        stateStore.confirmTrade({
          tradeId,
          txSignature: params.txSignature,
        });
      }
    } else {
      tradeId = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const trade: TradeRecord = {
      id: tradeId,
      type: 'buy',
      tokenMint: params.tokenMint,
      tokenSymbol: params.tokenSymbol,
      amountSol: params.amountSol,
      amountToken: params.amountToken,
      pricePerToken: params.amountToken > 0 ? params.amountSol / params.amountToken : 0,
      timestamp: Date.now(),
      txSignature: params.txSignature,
      poolId: params.poolId,
      positionId: params.tokenMint,
    };

    this.sessionStats.totalBuys++;

    logger.info(
      {
        type: 'buy',
        tokenMint: params.tokenMint,
        amountSol: params.amountSol.toFixed(4),
        sessionBuys: this.sessionStats.totalBuys,
      },
      'Trade recorded',
    );

    return trade;
  }

  /**
   * Record a sell trade and calculate realized P&L
   */
  recordSell(params: {
    tokenMint: string;
    tokenSymbol?: string;
    amountSol: number;
    amountToken: number;
    poolId: string;
    txSignature?: string;
  }): { trade: TradeRecord; realizedPnl: number } {
    const stateStore = getStateStore();

    // Get entry cost for P&L calculation
    let entryAmountSol = 0;
    let positionId: string | undefined;

    if (stateStore) {
      // Look up the position to get entry cost
      const position = stateStore.getPositionByMint(params.tokenMint);
      if (position) {
        entryAmountSol = position.amountSol;
        positionId = position.id;
      } else {
        // Fallback: calculate from buy trades
        const buyTrades = stateStore.getTradesForToken(params.tokenMint)
          .filter(t => t.type === 'buy' && t.status === 'confirmed');
        for (const buy of buyTrades) {
          entryAmountSol += buy.amountSol;
        }
      }
    }

    // Calculate realized P&L
    const realizedPnl = params.amountSol - entryAmountSol;

    // Record trade
    let tradeId: string;
    if (stateStore) {
      const dbTrade = stateStore.recordTradeIntent({
        type: 'sell',
        tokenMint: params.tokenMint,
        amountSol: params.amountSol,
        amountToken: params.amountToken,
        poolId: params.poolId,
        positionId,
      });
      tradeId = dbTrade.id;

      // Confirm immediately if we have a signature
      if (params.txSignature) {
        stateStore.confirmTrade({
          tradeId,
          txSignature: params.txSignature,
        });
      }
    } else {
      tradeId = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    const trade: TradeRecord = {
      id: tradeId,
      type: 'sell',
      tokenMint: params.tokenMint,
      tokenSymbol: params.tokenSymbol,
      amountSol: params.amountSol,
      amountToken: params.amountToken,
      pricePerToken: params.amountToken > 0 ? params.amountSol / params.amountToken : 0,
      timestamp: Date.now(),
      txSignature: params.txSignature,
      poolId: params.poolId,
      positionId,
    };

    this.sessionStats.totalSells++;
    this.sessionStats.realizedPnlSol += realizedPnl;

    logger.info(
      {
        type: 'sell',
        tokenMint: params.tokenMint,
        amountSol: params.amountSol.toFixed(4),
        realizedPnl: realizedPnl.toFixed(4),
        totalRealizedPnl: this.sessionStats.realizedPnlSol.toFixed(4),
        sessionSells: this.sessionStats.totalSells,
      },
      'Trade recorded',
    );

    return { trade, realizedPnl };
  }

  /**
   * Get all trades for a specific token
   */
  getTradesForToken(tokenMint: string): TradeRecord[] {
    const stateStore = getStateStore();
    if (!stateStore) {
      return [];
    }

    return stateStore.getTradesForToken(tokenMint)
      .filter(t => t.status === 'confirmed')
      .map(t => this.dbTradeToTradeRecord(t));
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 10): TradeRecord[] {
    const stateStore = getStateStore();
    if (!stateStore) {
      return [];
    }

    return stateStore.getRecentTrades(limit)
      .map(t => this.dbTradeToTradeRecord(t));
  }

  /**
   * Calculate unrealized P&L for a position
   */
  calculateUnrealizedPnl(
    tokenMint: string,
    currentValueSol: number,
  ): PositionPnl | null {
    const stateStore = getStateStore();
    if (!stateStore) {
      return null;
    }

    const position = stateStore.getPositionByMint(tokenMint);
    if (!position) {
      return null;
    }

    const entryAmountSol = position.amountSol;
    const unrealizedPnlSol = currentValueSol - entryAmountSol;
    const unrealizedPnlPercent =
      entryAmountSol > 0 ? (unrealizedPnlSol / entryAmountSol) * 100 : 0;

    return {
      tokenMint,
      entryAmountSol,
      currentValueSol,
      unrealizedPnlSol,
      unrealizedPnlPercent,
    };
  }

  /**
   * Get session summary
   */
  getSessionSummary(): {
    sessionDuration: string;
    totalBuys: number;
    totalSells: number;
    realizedPnlSol: number;
    totalTrades: number;
    winRate: number;
  } {
    const sessionDurationMs = this.sessionStats.startTime
      ? Date.now() - this.sessionStats.startTime
      : 0;

    const hours = Math.floor(sessionDurationMs / (1000 * 60 * 60));
    const minutes = Math.floor((sessionDurationMs % (1000 * 60 * 60)) / (1000 * 60));
    const sessionDuration = `${hours}h ${minutes}m`;

    // Calculate win rate from database
    const stateStore = getStateStore();
    let winRate = 0;

    if (stateStore) {
      const allTrades = stateStore.getAllConfirmedTrades();
      const sellTrades = allTrades.filter(t => t.type === 'sell');
      let wins = 0;

      for (const sell of sellTrades) {
        // Find corresponding buy trades
        const buyTrades = allTrades.filter(
          t => t.type === 'buy' && t.tokenMint === sell.tokenMint && t.timestamp < sell.timestamp
        );

        if (buyTrades.length > 0) {
          const totalBuyCost = buyTrades.reduce((sum, b) => sum + b.amountSol, 0);
          if (sell.amountSol > totalBuyCost) {
            wins++;
          }
        }
      }

      winRate = sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0;
    }

    return {
      sessionDuration,
      totalBuys: this.sessionStats.totalBuys,
      totalSells: this.sessionStats.totalSells,
      realizedPnlSol: this.sessionStats.realizedPnlSol,
      totalTrades: this.sessionStats.totalBuys + this.sessionStats.totalSells,
      winRate,
    };
  }

  /**
   * Log session summary
   */
  logSessionSummary(): void {
    const summary = this.getSessionSummary();
    logger.info(
      {
        duration: summary.sessionDuration,
        buys: summary.totalBuys,
        sells: summary.totalSells,
        realizedPnl: `${summary.realizedPnlSol.toFixed(4)} SOL`,
        winRate: `${summary.winRate.toFixed(1)}%`,
      },
      'Session P&L summary',
    );
  }

  /**
   * Get all trades
   */
  getAllTrades(): TradeRecord[] {
    const stateStore = getStateStore();
    if (!stateStore) {
      return [];
    }

    return stateStore.getAllConfirmedTrades()
      .map(t => this.dbTradeToTradeRecord(t));
  }

  /**
   * Get session stats
   */
  getSessionStats(): SessionStats {
    return { ...this.sessionStats };
  }

  /**
   * Clear old trades (keep last N days)
   */
  async pruneOldTrades(daysToKeep: number = 7): Promise<number> {
    const stateStore = getStateStore();
    if (!stateStore) {
      return 0;
    }

    // Note: This would require adding a prune method to state-store
    // For now, we'll skip this since SQLite storage is efficient
    logger.info({ daysToKeep }, 'Trade pruning not implemented for SQLite');
    return 0;
  }

  /**
   * Convert database trade record to API trade record
   */
  private dbTradeToTradeRecord(dbTrade: DbTradeRecord): TradeRecord {
    return {
      id: dbTrade.id,
      type: dbTrade.type,
      tokenMint: dbTrade.tokenMint,
      amountSol: dbTrade.amountSol,
      amountToken: dbTrade.amountToken,
      pricePerToken: dbTrade.price,
      timestamp: dbTrade.timestamp,
      txSignature: dbTrade.txSignature,
      poolId: dbTrade.poolId,
      positionId: dbTrade.positionId,
    };
  }
}

/**
 * Singleton instance
 */
let pnlTrackerInstance: PnlTracker | null = null;

/**
 * Get the P&L tracker instance (creates if not exists)
 */
export function getPnlTracker(): PnlTracker {
  if (!pnlTrackerInstance) {
    pnlTrackerInstance = new PnlTracker();
  }
  return pnlTrackerInstance;
}
