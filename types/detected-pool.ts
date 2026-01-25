import { PublicKey } from '@solana/web3.js';
import { LiquidityStateV4 } from '@raydium-io/raydium-sdk';
import { CpmmPoolState } from '../helpers/cpmm';
import { DlmmPoolState } from '../helpers/dlmm';

/**
 * Pool types supported by the detection system
 */
export type PoolType = 'AMMV4' | 'CPMM' | 'DLMM';

/**
 * Result of token age validation
 */
export interface TokenAgeResult {
  /** Age of the token in seconds since first transaction */
  ageSeconds: number;
  /** Unix timestamp of the first transaction for this mint */
  firstTxTime: number;
  /** Signature of the first transaction */
  firstTxSignature: string;
  /** Whether the token is considered "new" (age <= MAX_TOKEN_AGE_SECONDS) */
  isNew: boolean;
}

/**
 * Unified pool detection result
 *
 * This interface standardizes the output from all pool type detectors,
 * providing a consistent structure for downstream processing regardless
 * of whether the pool is AMMV4, CPMM, or DLMM.
 */
export interface DetectedPool {
  // ══════════════════════════════════════════════════════════════════════════
  // Identity
  // ══════════════════════════════════════════════════════════════════════════
  /** The pool account address */
  poolId: PublicKey;
  /** The type of pool (AMMV4, CPMM, or DLMM) */
  poolType: PoolType;

  // ══════════════════════════════════════════════════════════════════════════
  // Token Information
  // ══════════════════════════════════════════════════════════════════════════
  /** The base token mint (the new token being launched) */
  baseMint: PublicKey;
  /** The quote token mint (typically WSOL) */
  quoteMint: PublicKey;
  /** Decimals for the base token */
  baseDecimals: number;
  /** Decimals for the quote token */
  quoteDecimals: number;

  // ══════════════════════════════════════════════════════════════════════════
  // Timing Information
  // ══════════════════════════════════════════════════════════════════════════
  /** When the pool was created/activated (unix timestamp in seconds) */
  poolCreationTime: number;
  /** When we detected this pool (unix timestamp in seconds) */
  detectedAt: number;

  // ══════════════════════════════════════════════════════════════════════════
  // Token Age Validation (Phase 1)
  // ══════════════════════════════════════════════════════════════════════════
  /** Token age validation result */
  tokenAgeResult: TokenAgeResult;

  // ══════════════════════════════════════════════════════════════════════════
  // Pool-Specific Raw Data
  // ══════════════════════════════════════════════════════════════════════════
  /** The raw decoded pool state (pool-type-specific) */
  rawState: LiquidityStateV4 | CpmmPoolState | DlmmPoolState;
}

/**
 * Statistics for pool detection tracking
 *
 * Used to monitor the detection pipeline and identify filtering patterns.
 */
export interface PoolTypeStats {
  /** Total WebSocket events received */
  events: number;
  /** Events with invalid/undecodable structure */
  invalidStructure: number;
  /** Events rejected due to wrong quote token */
  wrongQuoteToken: number;
  /** Events rejected due to pool not enabled */
  poolNotEnabled: number;
  /** Events rejected due to pool not being new (timing check) */
  poolNotNew: number;
  /** Events rejected due to token being too old */
  tokenTooOld: number;
  /** Events that passed all checks and were emitted */
  emitted: number;
}

/**
 * Aggregated detection statistics across all pool types
 */
export interface DetectionStats {
  /** AMMV4 pool detection stats */
  ammv4: PoolTypeStats;
  /** CPMM pool detection stats */
  cpmm: PoolTypeStats;
  /** DLMM pool detection stats */
  dlmm: PoolTypeStats;

  // Totals
  /** Total events across all pool types */
  totalEvents: number;
  /** Total pools emitted across all types */
  totalEmitted: number;
  /** Total rejections due to token age */
  totalRejectedTokenAge: number;
}

/**
 * Create empty stats for a pool type
 */
export function createEmptyPoolTypeStats(): PoolTypeStats {
  return {
    events: 0,
    invalidStructure: 0,
    wrongQuoteToken: 0,
    poolNotEnabled: 0,
    poolNotNew: 0,
    tokenTooOld: 0,
    emitted: 0,
  };
}

/**
 * Create empty detection stats
 */
export function createEmptyDetectionStats(): DetectionStats {
  return {
    ammv4: createEmptyPoolTypeStats(),
    cpmm: createEmptyPoolTypeStats(),
    dlmm: createEmptyPoolTypeStats(),
    totalEvents: 0,
    totalEmitted: 0,
    totalRejectedTokenAge: 0,
  };
}
