/**
 * Paper Trade Tracker
 *
 * Tracks hypothetical trades that would have been executed in dry run mode.
 * Now includes continuous monitoring for TP/SL simulation to provide realistic
 * paper trading results.
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  decodeBondingCurveState,
  calculateBuyTokensOut,
  calculateSellSolOut,
  BondingCurveState,
} from '../helpers/pumpfun';
import { logger } from '../helpers';
import BN from 'bn.js';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type PaperTradeStatus = 'active' | 'closed' | 'graduated' | 'error';
export type PaperCloseReason = 'take_profit' | 'stop_loss' | 'time_exit' | 'graduated';

export interface PaperTrade {
  id: string;
  mint: string;
  bondingCurve: string;
  name?: string;
  symbol?: string;

  // Entry state (from bonding curve at detection)
  entryVirtualSolReserves: string; // BN as string for storage
  entryVirtualTokenReserves: string;
  entryTimestamp: number;
  hypotheticalSolSpent: number; // Config's QUOTE_AMOUNT

  // Calculated at entry
  entryPricePerToken: number; // SOL per token
  hypotheticalTokensReceived: number;

  // For display
  pipelineDurationMs: number;
  signature: string;

  // Position status and close info (for TP/SL simulation)
  status: PaperTradeStatus;
  closedTimestamp?: number;
  closedReason?: PaperCloseReason;
  exitPricePerToken?: number;
  exitSolReceived?: number;
  realizedPnlSol?: number;
  realizedPnlPercent?: number;
}

/**
 * Configuration for paper trade monitoring
 */
export interface PaperMonitorConfig {
  checkIntervalMs: number;
  takeProfit: number; // percentage
  stopLoss: number; // percentage
  maxHoldDurationMs: number; // 0 = disabled
  enabled: boolean;
}

export interface PaperPnLResult {
  mint: string;
  name?: string;
  symbol?: string;
  entryPricePerToken: number;
  currentPricePerToken: number | null; // null if graduated or error
  hypotheticalTokens: number;
  entrySol: number;
  currentSol: number | null;
  pnlSol: number | null;
  pnlPercent: number | null;
  status: PaperTradeStatus;
  errorMessage?: string;
  entryTimestamp: number;
  // For closed trades
  closedTimestamp?: number;
  closedReason?: PaperCloseReason;
  // Pipeline timing (for AI analysis)
  pipelineDurationMs: number;
}

export interface PaperPnLSummary {
  totalTrades: number;
  activeTrades: number;
  closedTrades: number;
  graduatedTrades: number;
  errorTrades: number;
  // Active (unrealized) P&L
  totalEntrySolActive: number;
  totalCurrentSol: number | null;
  unrealizedPnlSol: number | null;
  unrealizedPnlPercent: number | null;
  // Closed (realized) P&L
  realizedPnlSol: number;
  realizedPnlPercent: number | null;
  // Combined
  totalEntrySol: number;
  totalPnlSol: number | null;
  totalPnlPercent: number | null;
  // Trade details
  trades: PaperPnLResult[];
  checkedAt: number;
  // Monitor status
  monitoringEnabled: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_PAPER_TRADES = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// PAPER TRADE TRACKER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class PaperTradeTracker {
  private activeTrades: Map<string, PaperTrade> = new Map();
  private closedTrades: PaperTrade[] = [];
  private connection: Connection;
  private monitorConfig: PaperMonitorConfig | null = null;
  private monitorLoop: NodeJS.Timeout | null = null;
  private isMonitoringActive: boolean = false;

  constructor(connection: Connection, monitorConfig?: PaperMonitorConfig) {
    this.connection = connection;
    if (monitorConfig) {
      this.monitorConfig = monitorConfig;
    }
  }

  /**
   * Start the position monitoring loop
   */
  start(): void {
    if (!this.monitorConfig || !this.monitorConfig.enabled) {
      logger.info('[paper-trade] Monitoring disabled - positions will not be auto-closed');
      return;
    }

    if (this.isMonitoringActive) {
      logger.warn('[paper-trade] Monitor already running');
      return;
    }

    this.isMonitoringActive = true;
    logger.info(
      {
        checkInterval: `${this.monitorConfig.checkIntervalMs}ms`,
        takeProfit: `${this.monitorConfig.takeProfit}%`,
        stopLoss: `${this.monitorConfig.stopLoss}%`,
        maxHoldDuration: this.monitorConfig.maxHoldDurationMs > 0
          ? `${this.monitorConfig.maxHoldDurationMs}ms`
          : 'disabled',
      },
      '[paper-trade] Starting position monitor with TP/SL simulation'
    );

    // Run immediately, then on interval
    this.checkPositions();

    this.monitorLoop = setInterval(() => {
      this.checkPositions();
    }, this.monitorConfig.checkIntervalMs);
  }

  /**
   * Stop the position monitoring loop
   */
  stop(): void {
    if (this.monitorLoop) {
      clearInterval(this.monitorLoop);
      this.monitorLoop = null;
    }
    this.isMonitoringActive = false;
    logger.info('[paper-trade] Position monitor stopped');
  }

  /**
   * Check if monitoring is active
   */
  isMonitoring(): boolean {
    return this.isMonitoringActive;
  }

  /**
   * Check all active positions for TP/SL triggers using batched RPC
   * Uses getMultipleAccountsInfo for a single RPC call instead of N individual calls
   */
  private async checkPositions(): Promise<void> {
    if (this.activeTrades.size === 0) {
      return;
    }

    const tradeList = Array.from(this.activeTrades.values());
    logger.debug({ count: tradeList.length }, '[paper-trade] Checking positions (batched)');

    try {
      // ═══════════════ BATCH FETCH BONDING CURVE STATES ═══════════════
      // Single RPC call for ALL positions instead of N individual calls
      const bondingCurveKeys = tradeList.map(t => new PublicKey(t.bondingCurve));
      const accountInfos = await this.connection.getMultipleAccountsInfo(bondingCurveKeys, 'confirmed');

      for (let i = 0; i < tradeList.length; i++) {
        const trade = tradeList[i];
        const accountInfo = accountInfos[i];

        try {
          this.evaluatePosition(trade, accountInfo?.data || null);
        } catch (error) {
          logger.error(
            { error, mint: trade.mint },
            '[paper-trade] Error evaluating position'
          );
        }
      }
    } catch (error) {
      logger.error({ error }, '[paper-trade] Error fetching bonding curve states (batch)');
    }
  }

  /**
   * Evaluate a single position using pre-fetched bonding curve data
   * No individual RPC calls - all data passed in from batch fetch
   */
  private evaluatePosition(trade: PaperTrade, bondingCurveData: Buffer | null): void {
    if (!this.monitorConfig) return;

    // Check max hold duration first (no RPC needed)
    if (this.monitorConfig.maxHoldDurationMs > 0) {
      const holdDuration = Date.now() - trade.entryTimestamp;
      if (holdDuration >= this.monitorConfig.maxHoldDurationMs) {
        logger.info(
          { mint: trade.mint, name: trade.name, holdDurationMs: holdDuration },
          '[paper-trade] Max hold duration triggered'
        );
        // If we have bonding curve data, calculate exit values; otherwise use entry as fallback
        if (bondingCurveData) {
          const state = decodeBondingCurveState(bondingCurveData);
          if (state && !state.complete) {
            const tokensBN = new BN(trade.hypotheticalTokensReceived);
            const currentSolOutLamports = calculateSellSolOut(state, tokensBN);
            const currentValueSol = currentSolOutLamports.toNumber() / LAMPORTS_PER_SOL;
            const pnlPercent = ((currentValueSol - trade.hypotheticalSolSpent) / trade.hypotheticalSolSpent) * 100;
            this.closePaperTrade(trade, 'time_exit', state, currentValueSol, pnlPercent);
            return;
          }
        }
        // Fallback: close with entry value (0% PnL) if no bonding curve data
        this.closePaperTrade(trade, 'time_exit', null, trade.hypotheticalSolSpent, 0);
        return;
      }
    }

    if (!bondingCurveData) {
      logger.warn({ mint: trade.mint }, '[paper-trade] Bonding curve account not found');
      return;
    }

    const state = decodeBondingCurveState(bondingCurveData);
    if (!state) {
      logger.warn({ mint: trade.mint }, '[paper-trade] Failed to decode bonding curve');
      return;
    }

    // Check if graduated
    if (state.complete) {
      this.closePaperTrade(trade, 'graduated', state);
      return;
    }

    // Calculate current value
    const tokensBN = new BN(trade.hypotheticalTokensReceived);
    const currentSolOutLamports = calculateSellSolOut(state, tokensBN);
    const currentValueSol = currentSolOutLamports.toNumber() / LAMPORTS_PER_SOL;

    // Calculate P&L
    const pnlSol = currentValueSol - trade.hypotheticalSolSpent;
    const pnlPercent = (pnlSol / trade.hypotheticalSolSpent) * 100;

    // Check take profit
    if (pnlPercent >= this.monitorConfig.takeProfit) {
      logger.info(
        { mint: trade.mint, name: trade.name, pnlPercent: pnlPercent.toFixed(2) },
        '[paper-trade] Take profit triggered'
      );
      this.closePaperTrade(trade, 'take_profit', state, currentValueSol, pnlPercent);
      return;
    }

    // Check stop loss
    if (pnlPercent <= -this.monitorConfig.stopLoss) {
      logger.info(
        { mint: trade.mint, name: trade.name, pnlPercent: pnlPercent.toFixed(2) },
        '[paper-trade] Stop loss triggered'
      );
      this.closePaperTrade(trade, 'stop_loss', state, currentValueSol, pnlPercent);
      return;
    }
  }

  /**
   * Close a paper trade (simulate sell)
   */
  private closePaperTrade(
    trade: PaperTrade,
    reason: PaperCloseReason,
    state: BondingCurveState | null,
    currentValueSol?: number,
    pnlPercent?: number
  ): void {
    const TOKEN_DECIMALS = 6;

    // Calculate exit values if not provided (requires valid state)
    if (currentValueSol === undefined && state) {
      const tokensBN = new BN(trade.hypotheticalTokensReceived);
      const solOutLamports = calculateSellSolOut(state, tokensBN);
      currentValueSol = solOutLamports.toNumber() / LAMPORTS_PER_SOL;
    }
    // Fallback if no state and no value provided
    if (currentValueSol === undefined) {
      currentValueSol = trade.hypotheticalSolSpent;
    }

    const pnlSol = currentValueSol - trade.hypotheticalSolSpent;
    if (pnlPercent === undefined) {
      pnlPercent = (pnlSol / trade.hypotheticalSolSpent) * 100;
    }

    // Calculate exit price from bonding curve state, or fall back to entry price
    const exitPrice = state
      ? state.virtualSolReserves.toNumber() /
        LAMPORTS_PER_SOL /
        (state.virtualTokenReserves.toNumber() / Math.pow(10, TOKEN_DECIMALS))
      : trade.entryPricePerToken;

    // Update trade with closed state
    const closedTrade: PaperTrade = {
      ...trade,
      status: reason === 'graduated' ? 'graduated' : 'closed',
      closedTimestamp: Date.now(),
      closedReason: reason,
      exitPricePerToken: exitPrice,
      exitSolReceived: currentValueSol,
      realizedPnlSol: pnlSol,
      realizedPnlPercent: pnlPercent,
    };

    // Move from active to closed
    this.activeTrades.delete(trade.mint);
    this.closedTrades.push(closedTrade);

    const reasonDisplayMap: Record<PaperCloseReason, string> = {
      take_profit: 'TP Hit',
      stop_loss: 'SL Hit',
      time_exit: 'Time Exit',
      graduated: 'Graduated',
    };

    logger.info(
      {
        mint: trade.mint,
        name: trade.name,
        reason: reasonDisplayMap[reason],
        entrySol: trade.hypotheticalSolSpent.toFixed(4),
        exitSol: currentValueSol.toFixed(4),
        pnlSol: pnlSol.toFixed(4),
        pnlPercent: pnlPercent.toFixed(2) + '%',
      },
      '[paper-trade] Position closed'
    );
  }

  /**
   * Record a paper trade when pipeline passes in dry run mode
   */
  recordPaperTrade(params: {
    mint: PublicKey;
    bondingCurve: PublicKey;
    bondingCurveState: BondingCurveState;
    hypotheticalSolSpent: number;
    name?: string;
    symbol?: string;
    signature: string;
    pipelineDurationMs: number;
  }): void {
    const {
      mint,
      bondingCurve,
      bondingCurveState,
      hypotheticalSolSpent,
      name,
      symbol,
      signature,
      pipelineDurationMs,
    } = params;

    // Calculate how many tokens would be received
    const solLamports = new BN(Math.floor(hypotheticalSolSpent * LAMPORTS_PER_SOL));
    const tokensOut = calculateBuyTokensOut(bondingCurveState, solLamports);

    // Calculate entry price (SOL per token, accounting for decimals)
    // pump.fun tokens have 6 decimals
    const TOKEN_DECIMALS = 6;
    const entryPrice =
      bondingCurveState.virtualSolReserves.toNumber() /
      LAMPORTS_PER_SOL /
      (bondingCurveState.virtualTokenReserves.toNumber() / Math.pow(10, TOKEN_DECIMALS));

    const trade: PaperTrade = {
      id: `paper_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      mint: mint.toString(),
      bondingCurve: bondingCurve.toString(),
      name,
      symbol,
      entryVirtualSolReserves: bondingCurveState.virtualSolReserves.toString(),
      entryVirtualTokenReserves: bondingCurveState.virtualTokenReserves.toString(),
      entryTimestamp: Date.now(),
      hypotheticalSolSpent,
      entryPricePerToken: entryPrice,
      hypotheticalTokensReceived: tokensOut.toNumber(),
      pipelineDurationMs,
      signature,
      status: 'active', // New trades start as active
    };

    // Evict oldest active trade if at limit
    if (this.activeTrades.size >= MAX_PAPER_TRADES) {
      const oldestKey = this.activeTrades.keys().next().value;
      if (oldestKey) this.activeTrades.delete(oldestKey);
    }

    this.activeTrades.set(trade.mint, trade);

    logger.info(
      {
        mint: trade.mint,
        name,
        symbol,
        entrySol: hypotheticalSolSpent,
        tokensReceived: tokensOut.toNumber(),
        entryPrice: entryPrice.toExponential(4),
        monitoringEnabled: this.isMonitoringActive,
      },
      '[paper-trade] Recorded paper trade'
    );
  }

  /**
   * Check P&L for all paper trades (called on button press)
   * Fetches current bonding curve state for each active trade
   * Also includes closed trades with their realized P&L
   */
  async checkPnL(): Promise<PaperPnLSummary> {
    const results: PaperPnLResult[] = [];
    const activeTradesList = Array.from(this.activeTrades.values());
    const totalTradeCount = activeTradesList.length + this.closedTrades.length;

    // Handle empty case
    if (totalTradeCount === 0) {
      return {
        totalTrades: 0,
        activeTrades: 0,
        closedTrades: 0,
        graduatedTrades: 0,
        errorTrades: 0,
        totalEntrySolActive: 0,
        totalCurrentSol: null,
        unrealizedPnlSol: null,
        unrealizedPnlPercent: null,
        realizedPnlSol: 0,
        realizedPnlPercent: null,
        totalEntrySol: 0,
        totalPnlSol: null,
        totalPnlPercent: null,
        trades: [],
        checkedAt: Date.now(),
        monitoringEnabled: this.isMonitoringActive,
      };
    }

    // First, add closed trades to results (they already have realized P&L)
    let realizedPnlSol = 0;
    let closedEntrySol = 0;
    let graduatedCount = 0;

    for (const trade of this.closedTrades) {
      realizedPnlSol += trade.realizedPnlSol || 0;
      closedEntrySol += trade.hypotheticalSolSpent;

      if (trade.status === 'graduated') {
        graduatedCount++;
      }

      results.push({
        mint: trade.mint,
        name: trade.name,
        symbol: trade.symbol,
        entryPricePerToken: trade.entryPricePerToken,
        currentPricePerToken: trade.exitPricePerToken || null,
        hypotheticalTokens: trade.hypotheticalTokensReceived,
        entrySol: trade.hypotheticalSolSpent,
        currentSol: trade.exitSolReceived || null,
        pnlSol: trade.realizedPnlSol || null,
        pnlPercent: trade.realizedPnlPercent || null,
        status: trade.status,
        entryTimestamp: trade.entryTimestamp,
        closedTimestamp: trade.closedTimestamp,
        closedReason: trade.closedReason,
        pipelineDurationMs: trade.pipelineDurationMs,
      });
    }

    // Now process active trades
    let activeEntrySol = 0;
    let totalCurrentSol = 0;
    let activeTradeCount = 0;
    let errorTrades = 0;

    if (activeTradesList.length > 0) {
      // Batch fetch bonding curve states (up to 100)
      const bondingCurves = activeTradesList.map((t) => new PublicKey(t.bondingCurve));

      // Fetch all at once for efficiency
      const accountInfos = await this.connection.getMultipleAccountsInfo(bondingCurves, 'confirmed');

      const TOKEN_DECIMALS = 6;

      for (let i = 0; i < activeTradesList.length; i++) {
        const trade = activeTradesList[i];
        const accountInfo = accountInfos[i];

        activeEntrySol += trade.hypotheticalSolSpent;

        if (!accountInfo) {
          results.push({
            mint: trade.mint,
            name: trade.name,
            symbol: trade.symbol,
            entryPricePerToken: trade.entryPricePerToken,
            currentPricePerToken: null,
            hypotheticalTokens: trade.hypotheticalTokensReceived,
            entrySol: trade.hypotheticalSolSpent,
            currentSol: null,
            pnlSol: null,
            pnlPercent: null,
            status: 'error',
            errorMessage: 'Bonding curve not found',
            entryTimestamp: trade.entryTimestamp,
            pipelineDurationMs: trade.pipelineDurationMs,
          });
          errorTrades++;
          continue;
        }

        // Decode bonding curve state
        const state = decodeBondingCurveState(accountInfo.data);

        if (!state) {
          results.push({
            mint: trade.mint,
            name: trade.name,
            symbol: trade.symbol,
            entryPricePerToken: trade.entryPricePerToken,
            currentPricePerToken: null,
            hypotheticalTokens: trade.hypotheticalTokensReceived,
            entrySol: trade.hypotheticalSolSpent,
            currentSol: null,
            pnlSol: null,
            pnlPercent: null,
            status: 'error',
            errorMessage: 'Failed to decode bonding curve',
            entryTimestamp: trade.entryTimestamp,
            pipelineDurationMs: trade.pipelineDurationMs,
          });
          errorTrades++;
          continue;
        }

        // Check if graduated (shouldn't happen if monitor is running, but check anyway)
        if (state.complete) {
          results.push({
            mint: trade.mint,
            name: trade.name,
            symbol: trade.symbol,
            entryPricePerToken: trade.entryPricePerToken,
            currentPricePerToken: null,
            hypotheticalTokens: trade.hypotheticalTokensReceived,
            entrySol: trade.hypotheticalSolSpent,
            currentSol: null,
            pnlSol: null,
            pnlPercent: null,
            status: 'graduated',
            entryTimestamp: trade.entryTimestamp,
            pipelineDurationMs: trade.pipelineDurationMs,
          });
          graduatedCount++;
          continue;
        }

        // Calculate current value - how much SOL we'd get if we sold now
        const tokensBN = new BN(trade.hypotheticalTokensReceived);
        const currentSolOutLamports = calculateSellSolOut(state, tokensBN);
        const currentSol = currentSolOutLamports.toNumber() / LAMPORTS_PER_SOL;

        // Current price
        const currentPrice =
          state.virtualSolReserves.toNumber() /
          LAMPORTS_PER_SOL /
          (state.virtualTokenReserves.toNumber() / Math.pow(10, TOKEN_DECIMALS));

        const pnlSol = currentSol - trade.hypotheticalSolSpent;
        const pnlPercent = (pnlSol / trade.hypotheticalSolSpent) * 100;

        totalCurrentSol += currentSol;
        activeTradeCount++;

        results.push({
          mint: trade.mint,
          name: trade.name,
          symbol: trade.symbol,
          entryPricePerToken: trade.entryPricePerToken,
          currentPricePerToken: currentPrice,
          hypotheticalTokens: trade.hypotheticalTokensReceived,
          entrySol: trade.hypotheticalSolSpent,
          currentSol,
          pnlSol,
          pnlPercent,
          status: 'active',
          entryTimestamp: trade.entryTimestamp,
          pipelineDurationMs: trade.pipelineDurationMs,
        });
      }
    }

    // Calculate unrealized P&L from active trades
    const unrealizedPnlSol = activeTradeCount > 0 ? totalCurrentSol - activeEntrySol : null;
    const unrealizedPnlPercent =
      unrealizedPnlSol !== null && activeEntrySol > 0
        ? (unrealizedPnlSol / activeEntrySol) * 100
        : null;

    // Calculate realized P&L percent
    const realizedPnlPercent =
      closedEntrySol > 0 ? (realizedPnlSol / closedEntrySol) * 100 : null;

    // Calculate total P&L
    const totalEntrySol = activeEntrySol + closedEntrySol;
    const totalPnlSol = (unrealizedPnlSol || 0) + realizedPnlSol;
    const totalPnlPercent = totalEntrySol > 0 ? (totalPnlSol / totalEntrySol) * 100 : null;

    // Sort results: active first (by entry time desc), then closed (by close time desc)
    results.sort((a, b) => {
      // Active trades first
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (a.status !== 'active' && b.status === 'active') return 1;

      // For closed trades, sort by close time
      if (a.closedTimestamp && b.closedTimestamp) {
        return b.closedTimestamp - a.closedTimestamp;
      }

      // Otherwise sort by entry time
      return b.entryTimestamp - a.entryTimestamp;
    });

    return {
      totalTrades: totalTradeCount,
      activeTrades: activeTradeCount,
      closedTrades: this.closedTrades.length,
      graduatedTrades: graduatedCount,
      errorTrades,
      totalEntrySolActive: activeEntrySol,
      totalCurrentSol: activeTradeCount > 0 ? totalCurrentSol : null,
      unrealizedPnlSol,
      unrealizedPnlPercent,
      realizedPnlSol,
      realizedPnlPercent,
      totalEntrySol,
      totalPnlSol,
      totalPnlPercent,
      trades: results,
      checkedAt: Date.now(),
      monitoringEnabled: this.isMonitoringActive,
    };
  }

  /** Get all paper trades (active + closed) without P&L calculation */
  getPaperTrades(): PaperTrade[] {
    return [...Array.from(this.activeTrades.values()), ...this.closedTrades];
  }

  /** Get only active paper trades */
  getActivePaperTrades(): PaperTrade[] {
    return Array.from(this.activeTrades.values());
  }

  /** Get only closed paper trades */
  getClosedPaperTrades(): PaperTrade[] {
    return [...this.closedTrades];
  }

  /** Clear all paper trades (active and closed) */
  clearPaperTrades(): void {
    this.activeTrades.clear();
    this.closedTrades = [];
    logger.info('[paper-trade] All paper trades cleared');
  }

  /** Get total trade count (active + closed) */
  getTradeCount(): number {
    return this.activeTrades.size + this.closedTrades.length;
  }

  /** Get active trade count */
  getActiveTradeCount(): number {
    return this.activeTrades.size;
  }

  /** Get closed trade count */
  getClosedTradeCount(): number {
    return this.closedTrades.length;
  }

  /** Get summary stats without fetching prices */
  getSummaryStats(): {
    activeTrades: number;
    closedTrades: number;
    realizedPnlSol: number;
    monitoringEnabled: boolean;
  } {
    const realizedPnlSol = this.closedTrades.reduce(
      (sum, t) => sum + (t.realizedPnlSol || 0),
      0
    );

    return {
      activeTrades: this.activeTrades.size,
      closedTrades: this.closedTrades.length,
      realizedPnlSol,
      monitoringEnabled: this.isMonitoringActive,
    };
  }

  /** Update connection (for RPC failover) */
  updateConnection(connection: Connection): void {
    this.connection = connection;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

let paperTradeTrackerInstance: PaperTradeTracker | null = null;

export function initPaperTradeTracker(
  connection: Connection,
  monitorConfig?: PaperMonitorConfig
): PaperTradeTracker {
  if (!paperTradeTrackerInstance) {
    paperTradeTrackerInstance = new PaperTradeTracker(connection, monitorConfig);
    logger.info(
      {
        monitoringEnabled: monitorConfig?.enabled ?? false,
        takeProfit: monitorConfig?.takeProfit,
        stopLoss: monitorConfig?.stopLoss,
      },
      '[paper-trade] Paper trade tracker initialized'
    );
  }
  return paperTradeTrackerInstance;
}

export function getPaperTradeTracker(): PaperTradeTracker | null {
  return paperTradeTrackerInstance;
}
