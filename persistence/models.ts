/**
 * Phase 3: Persistence Layer - TypeScript Models
 *
 * Defines the data structures for SQLite persistence.
 */

/**
 * Position status in the database
 */
export type PositionStatus = 'open' | 'closed' | 'pending';

/**
 * Trade status in the database
 */
export type TradeStatus = 'pending' | 'confirmed' | 'failed';

/**
 * Trade type
 */
export type TradeType = 'buy' | 'sell';

/**
 * Blacklist entry type
 */
export type BlacklistType = 'token' | 'creator';

/**
 * Action taken on a seen pool
 */
export type PoolAction = 'bought' | 'filtered' | 'blacklisted' | 'skipped' | 'error' | 'buy_attempted' | 'buy_failed';

/**
 * Pool type identifier.
 * 'pumpfun' is the only actively used type. Legacy values ('AmmV4', 'CPMM', 'DLMM')
 * are retained for backward compatibility with historical database records.
 */
export type PoolType = 'pumpfun' | 'AmmV4' | 'CPMM' | 'DLMM';

/**
 * Persisted position record
 */
export interface PositionRecord {
  id: string;
  tokenMint: string;
  entryPrice: number;
  amountToken: number;
  amountSol: number;
  entryTimestamp: number;
  poolId: string;
  status: PositionStatus;
  closedTimestamp?: number;
  closedReason?: string;
  // Additional fields for recovery
  takeProfitSol?: number;
  stopLossSol?: number;
  lastPriceSol?: number;
  lastCheckTimestamp?: number;
}

/**
 * Persisted trade record
 */
export interface TradeRecord {
  id: string;
  positionId?: string;
  type: TradeType;
  tokenMint: string;
  amountSol: number;
  amountToken: number;
  price: number;
  timestamp: number;
  txSignature?: string;
  status: TradeStatus;
  poolId: string;
  // For idempotent recording
  intentTimestamp?: number;
  confirmedTimestamp?: number;
  errorMessage?: string;
}

/**
 * Seen pool record to prevent reprocessing
 */
export interface SeenPoolRecord {
  poolId: string;
  tokenMint: string;
  firstSeen: number;
  actionTaken: PoolAction;
  filterReason?: string;
}

/**
 * Blacklist entry record
 */
export interface BlacklistRecord {
  address: string;
  type: BlacklistType;
  reason?: string;
  addedTimestamp: number;
}

/**
 * Schema version for migrations
 */
export interface SchemaVersion {
  version: number;
  appliedAt: number;
}

/**
 * Session stats stored in DB
 */
export interface SessionStatsRecord {
  id: number;
  startTime: number;
  endTime?: number;
  totalBuys: number;
  totalSells: number;
  realizedPnlSol: number;
}

/**
 * Input for creating a new position
 */
export interface CreatePositionInput {
  tokenMint: string;
  entryPrice: number;
  amountToken: number;
  amountSol: number;
  poolId: string;
  takeProfitSol?: number;
  stopLossSol?: number;
}

/**
 * Input for recording a trade intent (before execution)
 */
export interface RecordTradeIntentInput {
  type: TradeType;
  tokenMint: string;
  amountSol: number;
  amountToken: number;
  poolId: string;
  positionId?: string;
}

/**
 * Input for confirming a trade
 */
export interface ConfirmTradeInput {
  tradeId: string;
  txSignature: string;
  actualAmountSol?: number;
  actualAmountToken?: number;
}

/**
 * Input for marking a trade as failed
 */
export interface FailTradeInput {
  tradeId: string;
  errorMessage: string;
}

/**
 * Input for recording a seen pool
 */
export interface RecordSeenPoolInput {
  poolId: string;
  tokenMint: string;
  actionTaken: PoolAction;
  filterReason?: string;
}

/**
 * Input for adding to blacklist
 */
export interface AddBlacklistInput {
  address: string;
  type: BlacklistType;
  reason?: string;
}

/**
 * Configuration for pending trade timeout
 */
export const PENDING_TRADE_TIMEOUT_MS = 60000; // 60 seconds

// ============================================================
// POOL DETECTION MODELS (Phase 5 - Dashboard)
// ============================================================

/**
 * Detailed filter result stored in database
 */
export interface StoredFilterResult {
  name: string;           // Filter identifier: 'burn', 'renounced', 'freezable', 'mutable', 'socials', 'pool_size'
  displayName: string;    // Human-readable name
  passed: boolean;
  checked: boolean;
  reason: string;
  expectedValue?: string;
  actualValue?: string;
  numericValue?: number;
}

/**
 * Pool detection record for dashboard display
 */
export interface PoolDetectionRecord {
  id: string;
  poolId: string;
  tokenMint: string;
  detectedAt: number;
  action: PoolAction;

  poolType: PoolType;

  // Detailed filter results stored as JSON
  filterResults: StoredFilterResult[];

  // Risk check results
  riskCheckPassed: boolean;
  riskCheckReason?: string;

  // Pool metadata
  poolQuoteReserve?: number;

  // Summary
  summary: string;
}

/**
 * Input for recording a pool detection with detailed filter results
 */
export interface RecordPoolDetectionInput {
  poolId: string;
  tokenMint: string;
  action: PoolAction;
  poolType?: PoolType;  // Defaults to 'pumpfun'
  filterResults: StoredFilterResult[];
  riskCheckPassed?: boolean;
  riskCheckReason?: string;
  poolQuoteReserve?: number;
  summary: string;
}

/**
 * Query options for pool detections
 */
export interface PoolDetectionQueryOptions {
  limit?: number;
  offset?: number;
  action?: PoolAction;
  poolType?: PoolType;
  fromTimestamp?: number;
  toTimestamp?: number;
}

/**
 * Aggregated statistics for pool detections
 */
export interface PoolDetectionStats {
  totalDetected: number;
  totalBought: number;
  totalFiltered: number;
  totalSkipped: number;
  totalBlacklisted: number;
  filterRejectionCounts: Record<string, number>;
  // Pool type breakdown (dynamic — includes all pool types found in data)
  byPoolType: Record<string, { total: number; bought: number }>;
}

// ============================================================
// SNIPER GATE OBSERVATION MODELS
// ============================================================

/**
 * Input for bulk-inserting sniper gate poll observations.
 * Each item in `checks` corresponds to one poll cycle within the gate's
 * polling loop and contains the full wallet classification snapshot.
 */
export interface RecordSniperGateObservationsInput {
  tokenMint: string;
  bondingCurve: string;
  /** Slot from the token creation transaction (used to derive slotDelta) */
  creationSlot: number;
  /** Whether the gate was running in log-only mode */
  logOnly: boolean;
  checks: Array<{
    checkNumber: number;
    checkedAt: number;
    botCount: number;
    botExitCount: number;
    botExitPercent: number;
    organicCount: number;
    totalBuys: number;
    totalSells: number;
    uniqueBuyWallets: number;
    passConditionsMet: boolean;
    sniperWallets: string[];
    organicWallets: string[];
  }>;
}

// ============================================================
// PAPER TRADE MODELS
// ============================================================

/**
 * Persisted paper trade record (dry_run mode)
 */
export interface PaperTradeRecord {
  id: string;
  tokenMint: string;
  bondingCurve: string;
  name?: string;
  symbol?: string;
  entryVirtualSolReserves: string;
  entryVirtualTokenReserves: string;
  entryTimestamp: number;
  hypotheticalSolSpent: number;
  entryPricePerToken: number;
  hypotheticalTokensReceived: number;
  pipelineDurationMs: number;
  signature: string;
  status: string;
  closedTimestamp?: number;
  closedReason?: string;
  exitPricePerToken?: number;
  exitSolReceived?: number;
  realizedPnlSol?: number;
  realizedPnlPercent?: number;
  // Sniper gate snapshot at entry (for correlating trade outcomes with gate metrics)
  sniperBotCount?: number;
  sniperExitPercent?: number;
  organicBuyerCount?: number;
  sniperGateChecks?: number;
  sniperGateWaitMs?: number;
}

/**
 * Input for recording a new paper trade entry
 */
export interface RecordPaperTradeEntryInput {
  id: string;
  tokenMint: string;
  bondingCurve: string;
  name?: string;
  symbol?: string;
  entryVirtualSolReserves: string;
  entryVirtualTokenReserves: string;
  hypotheticalSolSpent: number;
  entryPricePerToken: number;
  hypotheticalTokensReceived: number;
  pipelineDurationMs: number;
  signature: string;
  // Optional sniper gate snapshot (available when sniper gate is enabled)
  sniperBotCount?: number;
  sniperExitPercent?: number;
  organicBuyerCount?: number;
  sniperGateChecks?: number;
  sniperGateWaitMs?: number;
}

/**
 * Input for updating a paper trade when it closes (TP / SL / time exit / graduated)
 */
export interface UpdatePaperTradeExitInput {
  id: string;
  status: string;
  closedReason: string;
  exitPricePerToken: number;
  exitSolReceived: number;
  realizedPnlSol: number;
  realizedPnlPercent: number;
}
