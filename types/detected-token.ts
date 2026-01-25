import { PublicKey } from '@solana/web3.js';

/**
 * Source platform for a detected token/pool
 */
export type TokenSource = 'pumpfun' | 'raydium-ammv4' | 'raydium-cpmm' | 'meteora-dlmm';

/**
 * Unified interface for a detected token across all platforms
 *
 * This interface provides a common structure for tokens detected
 * on any supported platform, enabling a unified processing pipeline.
 */
export interface DetectedToken {
  /** Platform where the token was detected */
  source: TokenSource;

  /** Token mint address */
  mint: PublicKey;

  /** Pool ID (for Raydium/Meteora) */
  poolId?: PublicKey;

  /** Bonding curve address (for pump.fun) */
  bondingCurve?: PublicKey;

  /** Associated bonding curve token account (for pump.fun) */
  associatedBondingCurve?: PublicKey;

  /** Quote token mint (e.g., WSOL) */
  quoteMint?: PublicKey;

  /** Token creator wallet (if available) */
  creator?: PublicKey;

  /** Token name (if available) */
  name?: string;

  /** Token symbol (if available) */
  symbol?: string;

  /** Token metadata URI (if available) */
  uri?: string;

  /** Unix timestamp (ms) when the token was detected */
  detectedAt: number;

  /** Whether the token was found in the mint cache */
  inMintCache: boolean;

  /** Verification status (for cache misses) */
  verified?: boolean;

  /** Token age in seconds (if known) */
  ageSeconds?: number;

  /** Initial liquidity in SOL (for pools) */
  initialLiquiditySol?: number;

  /** Pool open time (Unix timestamp) */
  poolOpenTime?: number;

  /** Whether the pool is currently active/tradeable */
  isActive?: boolean;

  /** Launch confidence score (if using scoring) */
  launchScore?: number;

  /** How the token was verified */
  verificationSource?: 'mint-cache' | 'dexscreener' | 'on-chain' | 'none';

  /** Transaction signature that created the token/pool */
  signature?: string;

  /** Raw pool state data (platform-specific) */
  rawState?: any;
}

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
  verificationSource: 'mint-cache' | 'dexscreener' | 'on-chain' | 'none';
}

/**
 * Filter result for a detected token
 */
export interface FilterResult {
  passed: boolean;
  failedFilter?: string;
  reason?: string;
}

/**
 * Complete pipeline result for a detected token
 */
export interface TokenPipelineResult {
  token: DetectedToken;
  verification: VerificationResult;
  filters?: FilterResult;
  buy?: BuyResult;
  processingTimeMs: number;
}

/**
 * Statistics for token detection by platform
 */
export interface PlatformStats {
  detected: number;
  alreadyCached: number;
  isNew: number;
  tokenTooOld: number;
  verificationFailed: number;
  filterFailed: number;
  buyAttempted: number;
  buySucceeded: number;
  buyFailed: number;
  errors: number;
}

/**
 * Aggregate statistics across all platforms
 */
export interface DetectionStats {
  pumpfun: PlatformStats;
  raydiumAmmv4: PlatformStats;
  raydiumCpmm: PlatformStats;
  meteoraDlmm: PlatformStats;
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

/**
 * Event types emitted by the unified token detection system
 */
export interface TokenDetectionEvents {
  /** Emitted when a new token is detected (before verification) */
  'token-detected': (token: DetectedToken) => void;

  /** Emitted when a token passes verification */
  'token-verified': (token: DetectedToken, result: VerificationResult) => void;

  /** Emitted when a token fails verification */
  'token-rejected': (token: DetectedToken, result: VerificationResult) => void;

  /** Emitted when a token passes all filters */
  'token-approved': (token: DetectedToken, filters: FilterResult) => void;

  /** Emitted when a buy is attempted */
  'buy-attempted': (token: DetectedToken) => void;

  /** Emitted when a buy succeeds */
  'buy-succeeded': (token: DetectedToken, result: BuyResult) => void;

  /** Emitted when a buy fails */
  'buy-failed': (token: DetectedToken, result: BuyResult) => void;

  /** Emitted for pipeline statistics */
  'pipeline-stats': (stats: DetectionStats) => void;
}

/**
 * Helper function to create an empty PlatformStats object
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
 * Helper function to create an empty DetectionStats object
 */
export function createEmptyDetectionStats(): DetectionStats {
  return {
    pumpfun: createEmptyPlatformStats(),
    raydiumAmmv4: createEmptyPlatformStats(),
    raydiumCpmm: createEmptyPlatformStats(),
    meteoraDlmm: createEmptyPlatformStats(),
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
