/**
 * Pipeline Orchestrator
 *
 * Coordinates the execution of pipeline stages for pump.fun token processing.
 * Each stage is executed in order, and the pipeline stops on first rejection.
 *
 * Design principles:
 * - Clear stage boundaries
 * - Every rejection logged with reason
 * - Accumulated context passed between stages
 * - Easy to add/remove stages
 */

import { Connection, Keypair } from '@solana/web3.js';
import {
  DetectionEvent,
  PipelineContext,
  StageResult,
  CheapGatesData,
  DeepFiltersData,
  SniperGateData,
  ResearchScoreGateData,
  StableGateData,
} from './types';
import { CheapGatesStage, CheapGatesConfig } from './cheap-gates';
import { DeepFiltersStage, DeepFiltersConfig } from './deep-filters';
import { SniperGateStage, SniperGateConfig } from './sniper-gate';
import { ResearchScoreGateStage, ResearchScoreGateConfig } from './research-score-gate';
import { StableGateStage, StableGateConfig } from './stable-gate';
import { logger } from '../helpers';
import { TokenLogBuffer } from '../helpers/token-log-buffer';

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE RESULT
// ═══════════════════════════════════════════════════════════════════════════════

export interface PipelineResult {
  /** Did all stages pass? */
  success: boolean;

  /** Final context with all accumulated data */
  context: PipelineContext;

  /** Array of stage results for debugging */
  stageResults: StageResult[];

  /** Total pipeline duration */
  totalDurationMs: number;

  /** If rejected, which stage rejected? */
  rejectedAt?: string;

  /** If rejected, why? */
  rejectionReason?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface PipelineConfig {
  /** Cheap gates configuration */
  cheapGates: Partial<CheapGatesConfig>;

  /** Deep filters configuration */
  deepFilters: Partial<DeepFiltersConfig>;

  /** Sniper gate configuration (Stage 4) */
  sniperGate: Partial<SniperGateConfig>;

  /** Research score gate configuration (Stage 5) */
  researchScoreGate: Partial<ResearchScoreGateConfig>;

  /** Stable gate configuration (Stage 6) */
  stableGate: Partial<StableGateConfig>;

  /** Enable verbose logging */
  verbose: boolean;
}

const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  cheapGates: {},
  deepFilters: {},
  sniperGate: {},
  researchScoreGate: {},
  stableGate: {},
  verbose: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PumpFunPipeline - Orchestrates token processing stages
 *
 * Stage order:
 * 1. Detection (external - produces DetectionEvent)
 * 2. Cheap Gates (dedupe, blacklist, exposure, mint info)
 * 3. Deep Filters (bonding curve state, SOL filters, scoring)
 * 4. Sniper Gate (bot exit monitoring + organic demand validation)
 * 5. Research Score Gate (research bot model scoring)
   * 6. Stable Gate (price stabilization, curve re-validation, sell ratio)
   * 7. Execute (external - buys the token)
 */
export class PumpFunPipeline {
  private connection: Connection;
  private wallet: Keypair;
  private config: PipelineConfig;

  private cheapGatesStage: CheapGatesStage;
  private deepFiltersStage: DeepFiltersStage;
  private sniperGateStage: SniperGateStage;
  private researchScoreGateStage: ResearchScoreGateStage;
  private stableGateStage: StableGateStage;

  constructor(
    connection: Connection,
    wallet: Keypair,
    config: Partial<PipelineConfig> = {}
  ) {
    this.connection = connection;
    this.wallet = wallet;
    this.config = { ...DEFAULT_PIPELINE_CONFIG, ...config };

    // Initialize stages
    this.cheapGatesStage = new CheapGatesStage(connection, this.config.cheapGates);
    this.deepFiltersStage = new DeepFiltersStage(connection, this.config.deepFilters);
    this.sniperGateStage = new SniperGateStage(connection, this.config.sniperGate);
    this.researchScoreGateStage = new ResearchScoreGateStage(connection, this.config.researchScoreGate);
    this.stableGateStage = new StableGateStage(connection, this.config.stableGate);

    logger.info(
      {
        stages: ['cheap-gates', 'deep-filters', 'sniper-gate', 'research-score-gate', 'stable-gate'],
        cheapGatesConfig: this.config.cheapGates,
        deepFiltersConfig: this.config.deepFilters,
        sniperGateConfig: this.config.sniperGate,
        researchScoreGateConfig: this.config.researchScoreGate,
        stableGateConfig: this.config.stableGate,
      },
      '[pipeline] Initialized'
    );
  }

  /**
   * Process a detection event through all pipeline stages
   */
  async process(detection: DetectionEvent): Promise<PipelineResult> {
    const pipelineStart = Date.now();
    const stageResults: StageResult[] = [];
    const mintStr = detection.mint.toString();

    // Create log buffer for non-interleaved output
    const logBuffer = new TokenLogBuffer(mintStr, detection.symbol);

    // Initialize context
    const context: PipelineContext = {
      detection,
      logBuffer,
    };

    if (this.config.verbose) {
      logBuffer.debug('Starting processing', {
        mint: mintStr,
        signature: detection.signature,
        slot: detection.slot,
        creator: detection.creator?.toString(),
      });
    }

    try {
      // ═══════════════════════════════════════════════════════════════════════════
      // STAGE 2: Cheap Gates
      // ═══════════════════════════════════════════════════════════════════════════
      const cheapGatesResult = await this.cheapGatesStage.execute(context);
      stageResults.push(cheapGatesResult);

      if (!cheapGatesResult.pass) {
        context.rejection = {
          stage: cheapGatesResult.stage,
          reason: cheapGatesResult.reason,
          timestamp: Date.now(),
        };

        return this.buildResult(false, context, stageResults, pipelineStart, cheapGatesResult);
      }

      // Add cheap gates data to context
      context.cheapGates = cheapGatesResult.data as CheapGatesData;

      // ═══════════════════════════════════════════════════════════════════════════
      // STAGE 3: Deep Filters
      // ═══════════════════════════════════════════════════════════════════════════
      const deepFiltersResult = await this.deepFiltersStage.execute(context);
      stageResults.push(deepFiltersResult);

      if (!deepFiltersResult.pass) {
        context.rejection = {
          stage: deepFiltersResult.stage,
          reason: deepFiltersResult.reason,
          timestamp: Date.now(),
        };

        return this.buildResult(false, context, stageResults, pipelineStart, deepFiltersResult);
      }

      // Add deep filters data to context
      context.deepFilters = deepFiltersResult.data as DeepFiltersData;

      // ═══════════════════════════════════════════════════════════════════════════
      // STAGE 4: Sniper Gate
      // ═══════════════════════════════════════════════════════════════════════════
      const sniperResult = await this.sniperGateStage.execute(context);
      stageResults.push(sniperResult);

      if (!sniperResult.pass) {
        context.rejection = {
          stage: sniperResult.stage,
          reason: sniperResult.reason,
          timestamp: Date.now(),
        };
        return this.buildResult(false, context, stageResults, pipelineStart, sniperResult);
      }

      context.sniperGate = sniperResult.data as SniperGateData;

      // ═══════════════════════════════════════════════════════════════════════════
      // STAGE 5: Research Score Gate
      // ═══════════════════════════════════════════════════════════════════════════
      const researchScoreResult = await this.researchScoreGateStage.execute(context);
      stageResults.push(researchScoreResult);

      if (!researchScoreResult.pass) {
        context.rejection = {
          stage: researchScoreResult.stage,
          reason: researchScoreResult.reason,
          timestamp: Date.now(),
        };
        return this.buildResult(false, context, stageResults, pipelineStart, researchScoreResult);
      }

      context.researchScore = researchScoreResult.data as ResearchScoreGateData;

      // ═══════════════════════════════════════════════════════════════════════════
      // STAGE 6: Stable Gate
      // ═══════════════════════════════════════════════════════════════════════════
      const stableGateResult = await this.stableGateStage.execute(context);
      stageResults.push(stableGateResult);

      if (!stableGateResult.pass) {
        context.rejection = {
          stage: stableGateResult.stage,
          reason: stableGateResult.reason,
          timestamp: Date.now(),
        };
        return this.buildResult(false, context, stageResults, pipelineStart, stableGateResult);
      }

      context.stableGate = stableGateResult.data as StableGateData;

      // ═══════════════════════════════════════════════════════════════════════════
      // ALL STAGES PASSED
      // ═══════════════════════════════════════════════════════════════════════════
      return this.buildResult(true, context, stageResults, pipelineStart);
    } finally {
      // Flush the log buffer atomically regardless of outcome
      const totalMs = Date.now() - pipelineStart;
      if (context.rejection) {
        logBuffer.flush({
          result: 'REJECTED',
          stage: context.rejection.stage,
          reason: context.rejection.reason,
          totalMs,
        });
      } else {
        logBuffer.flush({ result: 'BOUGHT', totalMs });
      }
    }
  }

  /**
   * Build the final pipeline result
   */
  private buildResult(
    success: boolean,
    context: PipelineContext,
    stageResults: StageResult[],
    startTime: number,
    rejectionResult?: StageResult
  ): PipelineResult {
    return {
      success,
      context,
      stageResults,
      totalDurationMs: Date.now() - startTime,
      rejectedAt: rejectionResult?.stage,
      rejectionReason: rejectionResult?.reason,
    };
  }

  /**
   * Quick check - just returns pass/fail without full result
   */
  async check(detection: DetectionEvent): Promise<boolean> {
    const result = await this.process(detection);
    return result.success;
  }

  /**
   * Get pipeline configuration
   */
  getConfig(): PipelineConfig {
    return { ...this.config };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

let pipelineInstance: PumpFunPipeline | null = null;

/**
 * Initialize the pipeline singleton
 */
export function initPipeline(
  connection: Connection,
  wallet: Keypair,
  config: Partial<PipelineConfig> = {}
): PumpFunPipeline {
  pipelineInstance = new PumpFunPipeline(connection, wallet, config);
  return pipelineInstance;
}

/**
 * Get the pipeline singleton (must be initialized first)
 */
export function getPipeline(): PumpFunPipeline | null {
  return pipelineInstance;
}
