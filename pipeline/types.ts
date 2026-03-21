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
// RESEARCH SCORE GATE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Token feature vector — MUST match research bot's TokenFeatureVector exactly.
 * The model rules reference these field names directly.
 */
export interface TokenFeatureVector {
  mint: string;
  checkpointSeconds: number;

  // Raw features
  priceSol: number;
  priceChangeFromInitial: number;
  realSolReserves: number;
  totalTxCount: number;
  buyCount: number;
  sellCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buyVelocity: number;
  sellRatio: number;
  buyerTxRatio: number;
  marketCapSol: number;

  // Derived momentum features
  priceAcceleration: number;
  buyAcceleration: number;
  txBurst: number;
  holderConcentration: number;

  // Momentum freshness features
  timeSincePeakVelocity: number; // seconds between peak buy_velocity and checkpoint — shorter = momentum is live
  buyVelocityTrend: number;      // slope of buy_velocity across last 2-3 snapshots — positive = accelerating, negative = decelerating
}

/**
 * A single scoring rule from the research bot's model.
 * MUST match solana_research_bot/src/analysis/scoring-model.ts
 */
export interface ScoringRule {
  featureName: string;
  weight: number;
  direction: 'above' | 'below';
  threshold: number;
  min: number;
  max: number;
}

/**
 * The complete scoring model fetched from the research bot.
 */
export interface ScoringModel {
  /** Schema version for validation by consumers (trading bot) */
  schemaVersion: number;
  checkpointSeconds: number;
  rules: ScoringRule[];
  sampleCount: number;
  baseRate2x: number;
}

/**
 * Data produced by the research score gate stage.
 */
export interface ResearchScoreGateData {
  /** Computed score 0-100 */
  score: number;
  /** Signal classification */
  signal: 'strong_buy' | 'buy' | 'neutral' | 'avoid';
  /** Threshold used for pass/fail */
  scoreThreshold: number;
  /** How many tokens the model was trained on */
  modelSampleCount: number;
  /** Base 2x hit rate before filtering */
  modelBaseRate2x: number;
  /** The computed features (for logging/debugging) */
  features: TokenFeatureVector;
  /** Per-feature score breakdown */
  featureScores: Array<{ name: string; score: number; raw: number }>;
  /** Fresh bonding curve state fetched at scoring time (for price drift baseline) */
  freshBondingCurveState?: BondingCurveState;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STABLE GATE DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Data produced by the stable gate stage (Stage 6).
 * Contains results from all three sub-checks plus retry metadata.
 */
export interface StableGateData {
  /** Which attempt succeeded (1-based), or total attempts if rejected */
  attemptNumber: number;
  /** Total attempts made */
  totalAttempts: number;
  /** Price stabilization sub-check results */
  priceStabilization: {
    passed: boolean;
    snapshots: Array<{ priceSol: number; timestamp: number }>;
    priceChangePct: number;
  };
  /** Bonding curve re-validation sub-check results */
  curveReValidation: {
    passed: boolean;
    freshSolInCurve: number;
    minRequired: number;
  };
  /** Sell ratio hard gate sub-check results */
  sellRatioCheck: {
    passed: boolean;
    sellRatio: number;
    maxAllowed: number;
    totalBuys: number;
    totalSells: number;
  };
  /** Total time spent in this gate including retries (ms) */
  totalWaitMs: number;
  /** Fresh bonding curve state from the last fetch (for price drift baseline) */
  freshBondingCurveState?: BondingCurveState;
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

  /** Data from research score gate (if passed) */
  researchScore?: ResearchScoreGateData;

  /** Data from stable gate (if passed) */
  stableGate?: StableGateData;

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

  // Research Score Gate
  RESEARCH_SCORE_LOW: 'Research score below threshold',

  // Stable Gate
  STABLE_GATE_PRICE_FALLING: 'Price still falling after max retries',
  STABLE_GATE_CURVE_DEPLETED: 'Bonding curve SOL below minimum after dump',
  STABLE_GATE_HIGH_SELL_RATIO: 'Sell ratio exceeds maximum threshold',
  STABLE_GATE_TIMEOUT: 'Stable gate exhausted all retry attempts',
} as const;

export type RejectionReason = typeof RejectionReasons[keyof typeof RejectionReasons];
