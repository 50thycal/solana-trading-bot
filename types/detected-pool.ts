/**
 * Pool-specific types for token detection
 */

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
  getSourceDisplayName,
} from './detected-token';

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
