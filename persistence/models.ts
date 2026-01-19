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
export type PoolAction = 'bought' | 'filtered' | 'blacklisted' | 'skipped' | 'error';

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
