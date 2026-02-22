import { PublicKey } from '@solana/web3.js';

// ══════════════════════════════════════════════════════════════════════════════
// Core Types
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Source platform for a detected token/pool
 */
export type TokenSource = 'pumpfun';

/**
 * How the token's age was verified
 */
export type VerificationSource = 'mint-cache' | 'on-chain' | 'not-indexed' | 'none';

/**
 * Pool state types - pump.fun bonding curve
 */
export type PoolState = { type: 'pumpfun'; state: PumpFunState };

/**
 * pump.fun bonding curve state
 */
export interface PumpFunState {
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  virtualSolReserves?: bigint;
  virtualTokenReserves?: bigint;
  complete: boolean;
}

// ══════════════════════════════════════════════════════════════════════════════
// Unified Detection Interface
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Unified interface for a detected token across all platforms
 *
 * This is the primary interface emitted by the 'new-token' event,
 * providing a consistent structure for the token detection pipeline.
 *
 * @example
 * ```typescript
 * listeners.on('new-token', async (token: DetectedToken) => {
 *   if (token.source === 'pumpfun') {
 *     await buyOnPumpFun(token);
 *   }
 * });
 * ```
 */
export interface DetectedToken {
  // ────────────────────────────────────────────────────────────────────────────
  // Identity (required for all sources)
  // ────────────────────────────────────────────────────────────────────────────

  /** Platform where the token was detected */
  source: TokenSource;

  /** Token mint address */
  mint: PublicKey;

  // ────────────────────────────────────────────────────────────────────────────
  // Pool/Curve Identity (platform-specific)
  // ────────────────────────────────────────────────────────────────────────────

  /** Pool account ID (optional, platform-specific) */
  poolId?: PublicKey;

  /** Bonding curve address (pump.fun only) */
  bondingCurve?: PublicKey;

  /** Associated bonding curve token account (pump.fun only) */
  associatedBondingCurve?: PublicKey;

  /** Quote token mint - typically WSOL */
  quoteMint: PublicKey;

  // ────────────────────────────────────────────────────────────────────────────
  // Token Metadata (optional, when available)
  // ────────────────────────────────────────────────────────────────────────────

  /** Token name */
  name?: string;

  /** Token symbol */
  symbol?: string;

  /** Token metadata URI */
  uri?: string;

  /** Token creator wallet */
  creator?: PublicKey;

  // ────────────────────────────────────────────────────────────────────────────
  // Timing Information
  // ────────────────────────────────────────────────────────────────────────────

  /** Unix timestamp (seconds) when detected */
  detectedAt: number;

  /** Pool open time / activation time (Unix timestamp in seconds) */
  poolOpenTime?: number;

  /** Token age in seconds (if verified) */
  ageSeconds?: number;

  // ────────────────────────────────────────────────────────────────────────────
  // Verification Status
  // ────────────────────────────────────────────────────────────────────────────

  /** Whether the token was found in the mint cache (Helius-detected) */
  inMintCache: boolean;

  /** How the token age was verified */
  verificationSource: VerificationSource;

  /** Whether the token passed verification */
  verified: boolean;

  /** Reason for rejection (if verified === false) */
  rejectionReason?: string;

  // ────────────────────────────────────────────────────────────────────────────
  // Pool State (for buy execution)
  // ────────────────────────────────────────────────────────────────────────────

  /** Typed pool state for buy execution */
  poolState: PoolState;

  // ────────────────────────────────────────────────────────────────────────────
  // Optional Enrichment Data
  // ────────────────────────────────────────────────────────────────────────────

  /** Initial liquidity in SOL (if available) */
  initialLiquiditySol?: number;

  /** Launch confidence score (future: for scoring system) */
  launchScore?: number;

  /** Whether this token uses Token-2022 (CreateV2) vs SPL Token (Create) */
  isToken2022?: boolean;

  /** Transaction signature that triggered detection */
  signature?: string;

  /** Slot number of the creation transaction (used by sniper gate for slotDelta classification) */
  slot?: number;

  /** Raw log messages from the creation transaction */
  rawLogs?: string[];
}

// ══════════════════════════════════════════════════════════════════════════════
// Pipeline Results
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Result of attempting to buy a detected token
 */
export interface BuyResult {
  success: boolean;
  signature?: string;
  error?: string;
  tokensReceived?: number;
  solSpent?: number;
  pricePerToken?: number;
}

/**
 * Result of token verification
 */
export interface VerificationResult {
  isValid: boolean;
  reason?: string;
  ageSeconds?: number;
  source: VerificationSource;
}

/**
 * Complete pipeline result for a detected token
 */
export interface TokenPipelineResult {
  token: DetectedToken;
  verification: VerificationResult;
  buy?: BuyResult;
  processingTimeMs: number;
}

// ══════════════════════════════════════════════════════════════════════════════
// Statistics
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Statistics for token detection by platform
 */
export interface PlatformStats {
  /** Total tokens detected */
  detected: number;
  /** Tokens already in mint cache (duplicates) */
  alreadyCached: number;
  /** Tokens that passed newness check */
  isNew: number;
  /** Tokens rejected - too old */
  tokenTooOld: number;
  /** Tokens rejected - verification failed */
  verificationFailed: number;
  /** Tokens rejected - filter failed */
  filterFailed: number;
  /** Buy attempts made */
  buyAttempted: number;
  /** Successful buys */
  buySucceeded: number;
  /** Failed buys */
  buyFailed: number;
  /** Errors during processing */
  errors: number;
  /** pump.fun specific: graduated from bonding curve */
  graduated?: number;
}

/**
 * Aggregate statistics across all platforms
 */
export interface UnifiedDetectionStats {
  pumpfun: PlatformStats;
  mintCache: {
    size: number;
    heliusDetected: number;
    fallbackDetected: number;
    hitRate: number;
  };
  totals: {
    detected: number;
    isNew: number;
    tokenTooOld: number;
    buyAttempted: number;
    buySucceeded: number;
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Event Type Definitions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Event types emitted by the unified token detection system
 */
export interface UnifiedTokenEvents {
  /**
   * Emitted when a new token is detected and verified.
   * This is the primary event for the unified handler.
   */
  'new-token': (token: DetectedToken) => void;

  /**
   * Emitted when a token is rejected during verification.
   * Useful for debugging and stats.
   */
  'token-rejected': (token: Partial<DetectedToken>, reason: string) => void;

  /**
   * Emitted when a buy is attempted
   */
  'buy-attempted': (token: DetectedToken) => void;

  /**
   * Emitted when a buy succeeds
   */
  'buy-succeeded': (token: DetectedToken, result: BuyResult) => void;

  /**
   * Emitted when a buy fails
   */
  'buy-failed': (token: DetectedToken, result: BuyResult) => void;

  /**
   * Emitted periodically with pipeline statistics
   */
  'stats-update': (stats: UnifiedDetectionStats) => void;
}

// ══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create an empty PlatformStats object
 */
export function createEmptyPlatformStats(): PlatformStats {
  return {
    detected: 0,
    alreadyCached: 0,
    isNew: 0,
    tokenTooOld: 0,
    verificationFailed: 0,
    filterFailed: 0,
    buyAttempted: 0,
    buySucceeded: 0,
    buyFailed: 0,
    errors: 0,
  };
}

/**
 * Create an empty UnifiedDetectionStats object
 */
export function createEmptyUnifiedStats(): UnifiedDetectionStats {
  return {
    pumpfun: createEmptyPlatformStats(),
    mintCache: {
      size: 0,
      heliusDetected: 0,
      fallbackDetected: 0,
      hitRate: 0,
    },
    totals: {
      detected: 0,
      isNew: 0,
      tokenTooOld: 0,
      buyAttempted: 0,
      buySucceeded: 0,
    },
  };
}

/**
 * Type guard to check if a DetectedToken is from pump.fun
 */
export function isPumpFunToken(token: DetectedToken): token is DetectedToken & {
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  poolState: { type: 'pumpfun'; state: PumpFunState };
} {
  return token.source === 'pumpfun' && token.bondingCurve !== undefined;
}

/**
 * Get a human-readable source name
 */
export function getSourceDisplayName(source: TokenSource): string {
  return 'pump.fun';
}
