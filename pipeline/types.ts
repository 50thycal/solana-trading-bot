/**
 * Pipeline Types
 *
 * Core interfaces for the pump.fun token processing pipeline.
 * Designed for clarity, explicit stage boundaries, and easy debugging.
 */

import { PublicKey } from '@solana/web3.js';
import { BondingCurveState } from '../helpers/pumpfun';
import { TokenLogBuffer } from '../helpers/token-log-buffer';

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE 1: DETECTION EVENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DetectionEvent - The output of Stage 1 (Detection)
 *
 * This is the ONLY data structure that downstream stages receive from detection.
 * Everything downstream should consume only this object.
 */
export interface DetectionEvent {
  /** Transaction signature where token was detected */
  signature: string;

  /** Slot number of the detection */
  slot: number;

  /** Token mint address */
  mint: PublicKey;

  /** Bonding curve PDA */
  bondingCurve: PublicKey;

  /** Associated bonding curve token account */
  associatedBondingCurve: PublicKey;

  /** Creator/deployer wallet (if derivable from logs) */
  creator: PublicKey | null;

  /** Token name from metadata (if available at detection) */
  name?: string;

  /** Token symbol from metadata (if available at detection) */
  symbol?: string;

  /** Raw log lines for debugging */
  rawLogs: string[];

  /** Timestamp when event was detected */
  detectedAt: number;

  /** Whether this token uses Token-2022 (CreateV2) vs SPL Token (Create) */
  isToken2022?: boolean;

  /** Detection source identifier */
  source: 'websocket' | 'webhook';
}

// ═══════════════════════════════════════════════════════════════════════════════
// STAGE RESULT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * StageResult - Standard result from any pipeline stage
 *
 * Every stage returns this structure for consistent handling.
 */
export interface StageResult<T = unknown> {
  /** Did this stage pass? */
  pass: boolean;

  /** Human-readable reason (especially important for rejections) */
  reason: string;

  /** Stage name for logging */
  stage: string;

  /** Additional data produced by this stage (passed to next stage) */
  data?: T;

  /** Timing information */
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHEAP GATES DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Data produced by cheap gates stage
 */
export interface CheapGatesData {
  /** Mint info from getMint() call */
  mintInfo: {
    /** Mint authority (null = renounced) */
    mintAuthority: PublicKey | null;
    /** Freeze authority (null = no freeze) */
    freezeAuthority: PublicKey | null;
    /** Token decimals */
    decimals: number;
    /** Total supply */
    supply: bigint;
    /** Is this Token-2022? */
    isToken2022: boolean;
  };

  /** Pattern check results */
  patternCheck: {
    /** Did name/symbol pass pattern check? */
    passed: boolean;
    /** Reason if failed */
    reason?: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEEP FILTERS DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Data produced by deep filters stage
 */
export interface DeepFiltersData {
  /** Bonding curve state */
  bondingCurveState: BondingCurveState;

  /** Filter results */
  filterResults: {
    allPassed: boolean;
    score: number;
    summary: string;
    details: Array<{
      name: string;
      passed: boolean;
      reason: string;
    }>;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOMENTUM GATE DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Data produced by momentum gate stage
 *
 * The momentum gate validates buy activity before allowing purchase.
 * It uses retry-based polling to check if a token has sufficient buys.
 */
export interface MomentumGateData {
  /** Number of buy transactions detected */
  buyCount: number;

  /** Number of sell transactions detected (tracked for future use) */
  sellCount: number;

  /** Number of checks performed before pass/fail */
  checksPerformed: number;

  /** Total time spent in momentum gate (ms) */
  totalWaitMs: number;

  /** When the momentum check started */
  checkStartedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPER GATE DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Data produced by sniper gate stage
 *
 * The sniper gate classifies early wallets as bots vs organic buyers,
 * monitors for bot exits, and only passes when bots have dumped and
 * organic demand remains.
 */
export interface SniperGateData {
  /** How many bot wallets identified (bought within sniperSlotThreshold) */
  sniperWalletCount: number;

  /** How many bots exited (sold) */
  sniperExitCount: number;

  /** % of bots that exited */
  sniperExitPercent: number;

  /** Unique wallets from later slots (organic buyers) */
  organicBuyerCount: number;

  /** Total buy transactions seen */
  totalBuys: number;

  /** Total sell transactions seen */
  totalSells: number;

  /** Unique buyer wallets total */
  uniqueBuyWalletCount: number;

  /** How many polls before decision */
  checksPerformed: number;

  /** Total time spent in gate (ms) */
  totalWaitMs: number;

  /** Timestamp when gate check started */
  checkStartedAt: number;

  /** Identified bot wallet addresses */
  sniperWallets: string[];

  /** Organic wallet addresses */
  organicWallets: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE CONTEXT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PipelineContext - Accumulated state as token moves through pipeline
 *
 * Each stage can read from previous stages and add its own data.
 */
export interface PipelineContext {
  /** Original detection event */
  detection: DetectionEvent;

  /** Data from cheap gates (if passed) */
  cheapGates?: CheapGatesData;

  /** Data from deep filters (if passed) */
  deepFilters?: DeepFiltersData;

  /** Data from momentum gate (if passed) */
  momentumGate?: MomentumGateData;

  /** Data from sniper gate (if passed) */
  sniperGate?: SniperGateData;

  /** Log buffer for non-interleaved output */
  logBuffer?: TokenLogBuffer;

  /** Rejection info (if pipeline stopped) */
  rejection?: {
    stage: string;
    reason: string;
    timestamp: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE STAGE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PipelineStage - Interface for a single pipeline stage
 */
export interface PipelineStage<TInput = PipelineContext, TOutput = unknown> {
  /** Stage name for logging */
  name: string;

  /** Execute the stage */
  execute(context: TInput): Promise<StageResult<TOutput>>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REJECTION REASONS (for consistent logging)
// ═══════════════════════════════════════════════════════════════════════════════

export const RejectionReasons = {
  // Dedupe
  ALREADY_PROCESSED: 'Already processed (signature seen)',
  ALREADY_OWNED: 'Already have open position for this token',
  PENDING_TRADE: 'Pending trade exists for this token',

  // Blacklist
  MINT_BLACKLISTED: 'Token mint is blacklisted',
  CREATOR_BLACKLISTED: 'Creator wallet is blacklisted',

  // Exposure
  EXPOSURE_LIMIT: 'Would exceed max exposure limit',
  TRADES_PER_HOUR: 'Exceeded max trades per hour',
  INSUFFICIENT_BALANCE: 'Insufficient wallet balance',

  // Mint info
  MINT_NOT_RENOUNCED: 'Mint authority not renounced',
  HAS_FREEZE_AUTHORITY: 'Token has freeze authority',
  INVALID_DECIMALS: 'Invalid token decimals',

  // Pattern
  JUNK_NAME: 'Token name matches junk pattern',
  JUNK_SYMBOL: 'Token symbol matches junk pattern',

  // Bonding curve
  CURVE_NOT_FOUND: 'Bonding curve account not found',
  ALREADY_GRADUATED: 'Token already graduated from curve',

  // Filters
  FILTER_FAILED: 'Failed filter check',
  SCORE_TOO_LOW: 'Score below minimum threshold',

  // Suspicious instruction
  SUSPICIOUS_INSTRUCTION: 'Suspicious instruction detected in transaction logs',

  // Momentum Gate
  MOMENTUM_THRESHOLD_NOT_MET: 'Momentum threshold not met',
  MOMENTUM_RPC_FETCH_FAILED: 'Failed to fetch transactions for momentum check',

  // Sniper Gate
  SNIPER_GATE_TIMEOUT: 'Sniper gate timeout - bots did not exit in time',
  SNIPER_GATE_LOW_ORGANIC: 'Insufficient organic buyers after bot exit',
  SNIPER_GATE_RPC_FAILED: 'Failed to fetch transactions for sniper gate',
} as const;

export type RejectionReason = typeof RejectionReasons[keyof typeof RejectionReasons];
