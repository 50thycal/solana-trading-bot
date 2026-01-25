/**
 * Pool-specific types for DEX pool detection
 *
 * These types complement the unified DetectedToken interface
 * with pool-specific structures used during detection/decoding.
 */

import { PublicKey } from '@solana/web3.js';

// Re-export unified types for convenience
export {
  TokenSource,
  VerificationSource,
  PoolState,
  DetectedToken,
  PlatformStats,
  UnifiedDetectionStats,
  createEmptyPlatformStats,
  createEmptyUnifiedStats,
  isPumpFunToken,
  isDexPoolToken,
  getSourceDisplayName,
} from './detected-token';

// ══════════════════════════════════════════════════════════════════════════════
// Pool Type Enum
// ══════════════════════════════════════════════════════════════════════════════

/**
 * DEX pool types (excludes pump.fun which uses bonding curves)
 */
export type PoolType = 'AMMV4' | 'CPMM' | 'DLMM';

// ══════════════════════════════════════════════════════════════════════════════
// Token Age Validation
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Result of on-chain token age validation
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

// ══════════════════════════════════════════════════════════════════════════════
// Per-Pool-Type Statistics (Legacy - for backwards compatibility)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Statistics for a specific pool type
 *
 * @deprecated Use PlatformStats from detected-token.ts instead
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
 * Aggregated detection statistics across pool types
 *
 * @deprecated Use UnifiedDetectionStats from detected-token.ts instead
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
 *
 * @deprecated Use createEmptyPlatformStats from detected-token.ts instead
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
 *
 * @deprecated Use createEmptyUnifiedStats from detected-token.ts instead
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

// ══════════════════════════════════════════════════════════════════════════════
// Pool Detection Helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Map TokenSource to PoolType (for DEX pools only)
 */
export function sourceToPoolType(source: 'raydium-ammv4' | 'raydium-cpmm' | 'meteora-dlmm'): PoolType {
  switch (source) {
    case 'raydium-ammv4':
      return 'AMMV4';
    case 'raydium-cpmm':
      return 'CPMM';
    case 'meteora-dlmm':
      return 'DLMM';
  }
}

/**
 * Map PoolType to TokenSource
 */
export function poolTypeToSource(poolType: PoolType): 'raydium-ammv4' | 'raydium-cpmm' | 'meteora-dlmm' {
  switch (poolType) {
    case 'AMMV4':
      return 'raydium-ammv4';
    case 'CPMM':
      return 'raydium-cpmm';
    case 'DLMM':
      return 'meteora-dlmm';
  }
}
