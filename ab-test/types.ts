/**
 * A/B Test Framework - Type Definitions
 *
 * Core types for the A/B paper-trade testing system.
 * Two variant configurations run in parallel on the same token stream,
 * each with independent pipeline + paper trade tracking.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-variant configuration - every tunable trading parameter.
 * Each side of the A/B test gets its own copy.
 */
export interface ABVariantConfig {
  /** Human-readable label ("A" or "B") */
  name: string;

  // ── Exit Strategy ──────────────────────────────────────────────────────────
  /** Profit target percentage (e.g., 40 = exit at +40%) */
  takeProfit: number;
  /** Loss limit percentage (e.g., 20 = exit at -20%) */
  stopLoss: number;
  /** Force-exit after this duration in ms (e.g., 20000 = 20s) */
  maxHoldDurationMs: number;
  /** How often to check price targets in ms (e.g., 2000 = 2s) */
  priceCheckIntervalMs: number;

  // ── Entry Filters ──────────────────────────────────────────────────────────
  /** Minimum buy transactions required to pass momentum gate */
  momentumMinTotalBuys: number;
  /** Minimum SOL in bonding curve to consider buying */
  pumpfunMinSolInCurve: number;
  /** Maximum SOL in bonding curve (avoids near-graduation) */
  pumpfunMaxSolInCurve: number;
  /** Max token age in seconds (reject tokens older than this) */
  maxTokenAgeSeconds: number;

  // ── Momentum Gate Timing ───────────────────────────────────────────────────
  /** Wait before first momentum check in ms */
  momentumInitialDelayMs: number;
  /** Time between momentum rechecks in ms */
  momentumRecheckIntervalMs: number;
  /** Max recheck attempts before rejecting */
  momentumMaxChecks: number;

  // ── Execution (slippage modeling for paper trades) ─────────────────────────
  /** Buy slippage tolerance percentage */
  buySlippage: number;
  /** Sell slippage tolerance percentage */
  sellSlippage: number;

  // ── Risk ────────────────────────────────────────────────────────────────────
  /** Max trades allowed per hour */
  maxTradesPerHour: number;
  /** Amount of SOL to spend per trade */
  quoteAmount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEST SESSION CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Top-level A/B test session configuration
 */
export interface ABTestConfig {
  /** Auto-generated UUID for this session */
  sessionId: string;
  /** How long the test runs in ms */
  durationMs: number;
  /** Config for variant A (typically the "control") */
  variantA: ABVariantConfig;
  /** Config for variant B (the "experiment") */
  variantB: ABVariantConfig;
  /** When the test started */
  startedAt: number;
  /** Optional user-provided description */
  description?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRADE RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-trade result stored in SQLite
 */
export interface ABTradeResult {
  id: string;
  sessionId: string;
  variant: 'A' | 'B';
  tokenMint: string;
  tokenName?: string;
  tokenSymbol?: string;

  // Entry
  entryTimestamp: number;
  hypotheticalSolSpent: number;
  hypotheticalTokensReceived: number;
  entryPricePerToken: number;
  pipelineDurationMs: number;

  // Exit (filled when position closes)
  exitTimestamp?: number;
  exitReason?: string;
  exitPricePerToken?: number;
  exitSolReceived?: number;
  realizedPnlSol?: number;
  realizedPnlPercent?: number;
  holdDurationMs?: number;

  status: 'active' | 'closed';
}

/**
 * Pipeline decision record (every token, pass or fail)
 */
export interface ABPipelineDecision {
  id: string;
  sessionId: string;
  variant: 'A' | 'B';
  tokenMint: string;
  tokenName?: string;
  tokenSymbol?: string;
  timestamp: number;
  passed: boolean;
  rejectionStage?: string;
  rejectionReason?: string;
  pipelineDurationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE RESULT (internal)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ABPipelineResult {
  passed: boolean;
  bondingCurveState?: import('../helpers/pumpfun').BondingCurveState;
  bondingCurve?: import('@solana/web3.js').PublicKey;
  rejectionStage?: string;
  rejectionReason?: string;
  pipelineDurationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Summary statistics for one variant
 */
export interface ABVariantSummary {
  variant: 'A' | 'B';
  config: ABVariantConfig;

  // Pipeline
  totalTokensSeen: number;
  totalPipelinePassed: number;
  totalPipelineRejected: number;

  // Trades
  totalTradesEntered: number;
  totalTradesClosed: number;
  totalTradesActive: number;

  // P&L
  totalSolDeployed: number;
  totalSolReturned: number;
  realizedPnlSol: number;
  realizedPnlPercent: number;

  // Win/Loss
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinPnlPercent: number;
  avgLossPnlPercent: number;
  bestTradePnlPercent: number;
  worstTradePnlPercent: number;

  // Timing
  avgHoldDurationMs: number;

  // Exit breakdown
  takeProfitCount: number;
  stopLossCount: number;
  timeExitCount: number;
  graduatedCount: number;
}

/**
 * Full A/B test comparison report
 */
export interface ABTestReport {
  sessionId: string;
  config: ABTestConfig;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  totalTokensDetected: number;

  variantA: ABVariantSummary;
  variantB: ABVariantSummary;

  winner: 'A' | 'B' | 'tie';
  pnlDifferenceSol: number;
}
