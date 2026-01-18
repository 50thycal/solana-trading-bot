import fs from 'fs';
import path from 'path';
import { logger } from '../helpers';
import { getConfig } from '../helpers/config-validator';

/**
 * Trade record structure
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
 * Data structure stored in JSON
 */
interface PnlData {
  trades: TradeRecord[];
  sessionStats: SessionStats;
}

/**
 * P&L Tracker for recording trades and calculating profit/loss.
 * Persists to JSON file in data directory.
 */
export class PnlTracker {
  private trades: TradeRecord[] = [];
  private sessionStats: SessionStats;
  private filePath: string;
  private initialized: boolean = false;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor() {
    const config = getConfig();
    this.filePath = path.join(config.dataDir, 'trades.json');
    this.sessionStats = {
      startTime: null,
      totalBuys: 0,
      totalSells: 0,
      realizedPnlSol: 0,
    };
  }

  /**
   * Initialize tracker by loading from JSON file
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.load();
      this.sessionStats.startTime = Date.now();
      this.initialized = true;
      logger.info(
        {
          existingTrades: this.trades.length,
          sessionStart: new Date(this.sessionStats.startTime).toISOString(),
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
   * Load data from JSON file
   */
  private async load(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(this.filePath)) {
        await this.save();
        return;
      }

      const data = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: PnlData = JSON.parse(data);

      this.trades = parsed.trades || [];
      // Keep cumulative realized P&L, reset session counts
      this.sessionStats = {
        startTime: Date.now(),
        totalBuys: 0,
        totalSells: 0,
        realizedPnlSol: parsed.sessionStats?.realizedPnlSol || 0,
      };
    } catch (error) {
      throw new Error(`Failed to load P&L data: ${error}`);
    }
  }

  /**
   * Save data to JSON file (debounced)
   */
  private async save(): Promise<void> {
    // Debounce saves to avoid excessive disk I/O
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }

    this.saveDebounceTimer = setTimeout(async () => {
      try {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        const data: PnlData = {
          trades: this.trades,
          sessionStats: this.sessionStats,
        };

        fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
      } catch (error) {
        logger.error({ error }, 'Failed to save P&L data');
      }
    }, 1000);
  }

  /**
   * Force immediate save (for shutdown)
   */
  async forceSave(): Promise<void> {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }

    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: PnlData = {
        trades: this.trades,
        sessionStats: this.sessionStats,
      };

      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
      logger.debug('P&L data force saved');
    } catch (error) {
      logger.error({ error }, 'Failed to force save P&L data');
    }
  }

  /**
   * Generate a unique trade ID
   */
  private generateTradeId(): string {
    return `trade_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
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
    const trade: TradeRecord = {
      id: this.generateTradeId(),
      type: 'buy',
      tokenMint: params.tokenMint,
      tokenSymbol: params.tokenSymbol,
      amountSol: params.amountSol,
      amountToken: params.amountToken,
      pricePerToken: params.amountToken > 0 ? params.amountSol / params.amountToken : 0,
      timestamp: Date.now(),
      txSignature: params.txSignature,
      poolId: params.poolId,
      positionId: params.tokenMint, // Use token mint as position ID for simplicity
    };

    this.trades.push(trade);
    this.sessionStats.totalBuys++;
    this.save();

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
    // Find the corresponding buy trade(s) for this token
    const buyTrades = this.trades.filter(
      (t) => t.type === 'buy' && t.tokenMint === params.tokenMint,
    );

    // Calculate average entry cost
    let totalBuyCost = 0;
    let totalBuyTokens = 0;
    for (const buy of buyTrades) {
      totalBuyCost += buy.amountSol;
      totalBuyTokens += buy.amountToken;
    }

    // Calculate realized P&L
    const avgEntryPrice = totalBuyTokens > 0 ? totalBuyCost / totalBuyTokens : 0;
    const entryCostForSold = avgEntryPrice * params.amountToken;
    const realizedPnl = params.amountSol - entryCostForSold;

    const trade: TradeRecord = {
      id: this.generateTradeId(),
      type: 'sell',
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

    this.trades.push(trade);
    this.sessionStats.totalSells++;
    this.sessionStats.realizedPnlSol += realizedPnl;
    this.save();

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
    return this.trades.filter((t) => t.tokenMint === tokenMint);
  }

  /**
   * Get recent trades
   */
  getRecentTrades(limit: number = 10): TradeRecord[] {
    return this.trades.slice(-limit);
  }

  /**
   * Calculate unrealized P&L for a position
   */
  calculateUnrealizedPnl(
    tokenMint: string,
    currentValueSol: number,
  ): PositionPnl | null {
    const buyTrades = this.trades.filter(
      (t) => t.type === 'buy' && t.tokenMint === tokenMint,
    );

    if (buyTrades.length === 0) {
      return null;
    }

    // Calculate total entry cost
    let entryAmountSol = 0;
    for (const buy of buyTrades) {
      entryAmountSol += buy.amountSol;
    }

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

    // Calculate win rate from sell trades
    const sellTrades = this.trades.filter((t) => t.type === 'sell');
    let wins = 0;

    for (const sell of sellTrades) {
      const buyTrades = this.trades.filter(
        (t) =>
          t.type === 'buy' &&
          t.tokenMint === sell.tokenMint &&
          t.timestamp < sell.timestamp,
      );

      if (buyTrades.length > 0) {
        const avgEntryPrice =
          buyTrades.reduce((sum, b) => sum + b.pricePerToken, 0) / buyTrades.length;
        if (sell.pricePerToken > avgEntryPrice) {
          wins++;
        }
      }
    }

    const winRate = sellTrades.length > 0 ? (wins / sellTrades.length) * 100 : 0;

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
    return [...this.trades];
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
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const originalCount = this.trades.length;
    this.trades = this.trades.filter((t) => t.timestamp > cutoff);
    const prunedCount = originalCount - this.trades.length;

    if (prunedCount > 0) {
      await this.save();
      logger.info({ prunedCount, daysToKeep }, 'Pruned old trades');
    }

    return prunedCount;
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
