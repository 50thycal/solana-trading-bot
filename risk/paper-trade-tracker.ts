/**
 * Paper Trade Tracker
 *
 * Tracks hypothetical trades that would have been executed in dry run mode.
 * Allows checking P&L on-demand without continuous RPC polling.
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
  status: 'active' | 'graduated' | 'error';
  errorMessage?: string;
  entryTimestamp: number;
}

export interface PaperPnLSummary {
  totalTrades: number;
  activeTrades: number;
  graduatedTrades: number;
  errorTrades: number;
  totalEntrySol: number;
  totalCurrentSol: number | null;
  totalPnlSol: number | null;
  totalPnlPercent: number | null;
  trades: PaperPnLResult[];
  checkedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_PAPER_TRADES = 100;

// ═══════════════════════════════════════════════════════════════════════════════
// PAPER TRADE TRACKER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class PaperTradeTracker {
  private trades: Map<string, PaperTrade> = new Map();
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
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
    };

    // Evict oldest if at limit
    if (this.trades.size >= MAX_PAPER_TRADES) {
      const oldestKey = this.trades.keys().next().value;
      if (oldestKey) this.trades.delete(oldestKey);
    }

    this.trades.set(trade.mint, trade);

    logger.info(
      {
        mint: trade.mint,
        name,
        symbol,
        entrySol: hypotheticalSolSpent,
        tokensReceived: tokensOut.toNumber(),
        entryPrice: entryPrice.toExponential(4),
      },
      '[paper-trade] Recorded paper trade'
    );
  }

  /**
   * Check P&L for all paper trades (called on button press)
   * Fetches current bonding curve state for each trade
   */
  async checkPnL(): Promise<PaperPnLSummary> {
    const results: PaperPnLResult[] = [];
    const tradesList = Array.from(this.trades.values());

    if (tradesList.length === 0) {
      return {
        totalTrades: 0,
        activeTrades: 0,
        graduatedTrades: 0,
        errorTrades: 0,
        totalEntrySol: 0,
        totalCurrentSol: null,
        totalPnlSol: null,
        totalPnlPercent: null,
        trades: [],
        checkedAt: Date.now(),
      };
    }

    // Batch fetch bonding curve states (up to 100)
    const bondingCurves = tradesList.map((t) => new PublicKey(t.bondingCurve));

    // Fetch all at once for efficiency
    const accountInfos = await this.connection.getMultipleAccountsInfo(bondingCurves);

    let totalEntrySol = 0;
    let totalCurrentSol = 0;
    let activeTrades = 0;
    let graduatedTrades = 0;
    let errorTrades = 0;

    const TOKEN_DECIMALS = 6;

    for (let i = 0; i < tradesList.length; i++) {
      const trade = tradesList[i];
      const accountInfo = accountInfos[i];

      totalEntrySol += trade.hypotheticalSolSpent;

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
        });
        errorTrades++;
        continue;
      }

      // Check if graduated
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
        });
        graduatedTrades++;
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
      activeTrades++;

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
      });
    }

    // Calculate totals only from active trades
    const activeEntrySol = results
      .filter((r) => r.status === 'active')
      .reduce((sum, r) => sum + r.entrySol, 0);

    const totalPnlSol = activeTrades > 0 ? totalCurrentSol - activeEntrySol : null;
    const totalPnlPercent =
      totalPnlSol !== null && activeEntrySol > 0 ? (totalPnlSol / activeEntrySol) * 100 : null;

    return {
      totalTrades: tradesList.length,
      activeTrades,
      graduatedTrades,
      errorTrades,
      totalEntrySol,
      totalCurrentSol: activeTrades > 0 ? totalCurrentSol : null,
      totalPnlSol,
      totalPnlPercent,
      trades: results.sort((a, b) => b.entryTimestamp - a.entryTimestamp),
      checkedAt: Date.now(),
    };
  }

  /** Get all paper trades without P&L calculation */
  getPaperTrades(): PaperTrade[] {
    return Array.from(this.trades.values());
  }

  /** Clear all paper trades */
  clearPaperTrades(): void {
    this.trades.clear();
    logger.info('[paper-trade] All paper trades cleared');
  }

  /** Get trade count */
  getTradeCount(): number {
    return this.trades.size;
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

export function initPaperTradeTracker(connection: Connection): PaperTradeTracker {
  if (!paperTradeTrackerInstance) {
    paperTradeTrackerInstance = new PaperTradeTracker(connection);
    logger.info('[paper-trade] Paper trade tracker initialized');
  }
  return paperTradeTrackerInstance;
}

export function getPaperTradeTracker(): PaperTradeTracker | null {
  return paperTradeTrackerInstance;
}
