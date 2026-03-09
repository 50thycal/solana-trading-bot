/**
 * Research Score Gate Stage
 *
 * Stage 5 of the pipeline — runs AFTER the sniper gate. Fetches a scoring
 * model from the research bot, computes token features from pipeline context,
 * and applies the model's rules to produce a 0-100 score. Only passes if
 * the score exceeds the configured threshold.
 *
 * Design:
 * - Fetch model from research bot on startup + periodic refresh
 * - Build TokenFeatureVector from BondingCurveState + SniperGateData
 * - Score token using same algorithm as research bot
 * - PASS when score >= threshold (or logOnly mode)
 * - Graceful degradation: if no model available, pass with warning
 */

import { Connection } from '@solana/web3.js';
import BN from 'bn.js';
import {
  PipelineContext,
  StageResult,
  PipelineStage,
  RejectionReasons,
  TokenFeatureVector,
  ScoringRule,
  ScoringModel,
  ResearchScoreGateData,
} from './types';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface ResearchScoreGateConfig {
  /** Enable/disable the research score gate (default: true) */
  enabled: boolean;
  /** URL of the research bot API */
  researchBotUrl: string;
  /** How often to re-fetch the model in ms (default: 300000 = 5 min) */
  modelRefreshIntervalMs: number;
  /** Minimum score to pass (default: 50) */
  scoreThreshold: number;
  /** If true, always pass but log the score (default: false) */
  logOnly: boolean;
  /** Which checkpoint model to use in seconds (default: 30) */
  checkpoint: number;
}

const DEFAULT_CONFIG: ResearchScoreGateConfig = {
  enabled: true,
  researchBotUrl: '',
  modelRefreshIntervalMs: 300000,
  scoreThreshold: 50,
  logOnly: false,
  checkpoint: 30,
};

// ═══════════════════════════════════════════════════════════════════════════════
// LAMPORT CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

const LAMPORTS_PER_SOL = 1_000_000_000;

function bnToSol(bn: BN): number {
  return bn.toNumber() / LAMPORTS_PER_SOL;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE VECTOR BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a TokenFeatureVector from pipeline context data.
 * Uses BondingCurveState from deep filters and SniperGateData from sniper gate.
 * Derives momentum features from sniper gate checkHistory where possible.
 */
function buildFeatureVector(ctx: PipelineContext): TokenFeatureVector {
  const bcs = ctx.deepFilters!.bondingCurveState;
  const sniper = ctx.sniperGate;
  const detection = ctx.detection;

  // Time since detection
  const secondsSinceCreation = (Date.now() - detection.detectedAt) / 1000;

  // Price from bonding curve: virtualSolReserves / virtualTokenReserves
  const virtualSol = bnToSol(bcs.virtualSolReserves);
  const virtualTokens = bcs.virtualTokenReserves.toNumber();
  const priceSol = virtualTokens > 0 ? virtualSol / virtualTokens : 0;

  // Transaction data from sniper gate
  const buyCount = sniper ? sniper.totalBuys : 0;
  const sellCount = sniper ? sniper.totalSells : 0;
  const totalTxCount = buyCount + sellCount;
  const uniqueBuyers = sniper ? sniper.organicBuyerCount : 0;
  const uniqueSellers = sniper ? sniper.sniperExitCount : 0;

  // Derived features
  const buyVelocity = secondsSinceCreation > 0 ? buyCount / secondsSinceCreation : 0;
  const sellRatio = totalTxCount > 0 ? sellCount / totalTxCount : 0;
  const buyerTxRatio = buyCount > 0 ? uniqueBuyers / buyCount : 0;

  const realTokenReserves = bcs.realTokenReserves.toNumber();
  const marketCapSol = priceSol * (virtualTokens + realTokenReserves);

  // Momentum features derived from sniper gate checkHistory
  let buyAcceleration = 0;
  let txBurst = 0;

  if (sniper && sniper.checkHistory.length >= 2) {
    const first = sniper.checkHistory[0];
    const last = sniper.checkHistory[sniper.checkHistory.length - 1];
    const timeDelta = (last.checkedAt - first.checkedAt) / 1000;
    if (timeDelta > 0) {
      buyAcceleration = (last.totalBuys - first.totalBuys) / timeDelta;
    }

    // txBurst: max new transactions between consecutive polls
    for (let i = 1; i < sniper.checkHistory.length; i++) {
      const prevTotal = sniper.checkHistory[i - 1].totalBuys + sniper.checkHistory[i - 1].totalSells;
      const currTotal = sniper.checkHistory[i].totalBuys + sniper.checkHistory[i].totalSells;
      const delta = currTotal - prevTotal;
      if (delta > txBurst) {
        txBurst = delta;
      }
    }
  }

  const holderConcentration = buyCount > 0 ? uniqueBuyers / buyCount : 0;

  return {
    mint: detection.mint.toString(),
    checkpointSeconds: secondsSinceCreation,
    priceSol,
    priceChangeFromInitial: 0, // Single price point — cannot compute
    realSolReserves: bnToSol(bcs.realSolReserves),
    totalTxCount,
    buyCount,
    sellCount,
    uniqueBuyers,
    uniqueSellers,
    buyVelocity,
    sellRatio,
    buyerTxRatio,
    marketCapSol,
    priceAcceleration: 0, // Requires two bonding curve reads
    buyAcceleration,
    txBurst,
    holderConcentration,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCORING FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Score a token using the research bot's scoring model.
 * MUST match the research bot's scoreToken() implementation.
 */
function scoreToken(
  model: ScoringModel,
  features: TokenFeatureVector,
): { score: number; featureScores: Array<{ name: string; score: number; raw: number }> } {
  let totalScore = 0;
  const featureScores: Array<{ name: string; score: number; raw: number }> = [];

  for (const rule of model.rules) {
    const raw = features[rule.featureName as keyof TokenFeatureVector] as number;
    if (typeof raw !== 'number') continue;

    const range = rule.max - rule.min;

    // Normalize to 0-1
    let normalized = range > 0 ? (raw - rule.min) / range : 0.5;
    normalized = Math.max(0, Math.min(1, normalized));

    // Flip if lower is better
    if (rule.direction === 'below') {
      normalized = 1 - normalized;
    }

    const featureScore = normalized * rule.weight * 100;
    totalScore += featureScore;

    featureScores.push({
      name: rule.featureName,
      score: Math.round(featureScore * 100) / 100,
      raw,
    });
  }

  return {
    score: Math.round(totalScore * 100) / 100,
    featureScores,
  };
}

/**
 * Classify score into signal buckets
 */
function classifySignal(score: number): 'strong_buy' | 'buy' | 'neutral' | 'avoid' {
  if (score >= 70) return 'strong_buy';
  if (score >= 50) return 'buy';
  if (score >= 30) return 'neutral';
  return 'avoid';
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESEARCH SCORE GATE STAGE
// ═══════════════════════════════════════════════════════════════════════════════

export class ResearchScoreGateStage implements PipelineStage<PipelineContext, ResearchScoreGateData> {
  name = 'research-score-gate';

  private config: ResearchScoreGateConfig;
  private cachedModel: ScoringModel | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastFetchError: string | null = null;
  private noModelSkipCount: number = 0;

  constructor(config: Partial<ResearchScoreGateConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    if (this.config.enabled && this.config.researchBotUrl) {
      // Fetch model on startup (non-blocking)
      this.fetchModel().catch((err) => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          '[research-score-gate] Initial model fetch failed — will retry on refresh',
        );
      });

      // Set up periodic refresh
      if (this.config.modelRefreshIntervalMs > 0) {
        this.refreshTimer = setInterval(() => {
          this.fetchModel().catch((err) => {
            logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              '[research-score-gate] Model refresh failed — using cached model',
            );
          });
        }, this.config.modelRefreshIntervalMs);
      }
    }
  }

  /**
   * Fetch the scoring model from the research bot API.
   */
  async fetchModel(): Promise<void> {
    const baseUrl = this.config.researchBotUrl.replace(/\/+$/, '');
    const url = `${baseUrl}/api/analysis/model?checkpoint=${this.config.checkpoint}&full=true`;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errorMsg = `HTTP ${response.status}: ${response.statusText}`;
      this.lastFetchError = errorMsg;
      throw new Error(errorMsg);
    }

    const data = await response.json() as Record<string, unknown>;

    // The API returns { model: { rules, checkpointSeconds, ... }, correlations, datasetStats }
    // Extract the model object first
    const model = (data.model as Record<string, unknown>) || data;

    // Extract the scoring model from the response
    if (!model.rules || !Array.isArray(model.rules)) {
      throw new Error('Invalid model response: missing rules array');
    }

    // Validate each rule has required fields with correct types
    const validatedRules: ScoringRule[] = [];
    for (let i = 0; i < (model.rules as unknown[]).length; i++) {
      const rule = (model.rules as unknown[])[i] as Record<string, unknown>;
      if (
        typeof rule?.featureName !== 'string' ||
        typeof rule?.weight !== 'number' ||
        typeof rule?.direction !== 'string' ||
        typeof rule?.min !== 'number' ||
        typeof rule?.max !== 'number'
      ) {
        logger.warn(
          { ruleIndex: i, rule },
          '[research-score-gate] Skipping invalid rule — missing or wrong-typed fields',
        );
        continue;
      }
      if (rule.direction !== 'above' && rule.direction !== 'below') {
        logger.warn(
          { ruleIndex: i, direction: rule.direction },
          '[research-score-gate] Skipping rule with invalid direction (must be "above" or "below")',
        );
        continue;
      }
      validatedRules.push(rule as unknown as ScoringRule);
    }

    if (validatedRules.length === 0) {
      throw new Error('Invalid model response: no valid rules after validation');
    }

    this.cachedModel = {
      checkpointSeconds: (model.checkpointSeconds as number) || this.config.checkpoint,
      rules: validatedRules,
      sampleCount: (model.sampleCount as number) || 0,
      baseRate2x: (model.baseRate2x as number) || 0,
    };

    this.lastFetchError = null;

    logger.info(
      {
        checkpoint: this.cachedModel.checkpointSeconds,
        ruleCount: this.cachedModel.rules.length,
        sampleCount: this.cachedModel.sampleCount,
        baseRate2x: this.cachedModel.baseRate2x,
      },
      '[research-score-gate] Model fetched successfully',
    );
  }

  async execute(context: PipelineContext): Promise<StageResult<ResearchScoreGateData>> {
    const startTime = Date.now();
    const mintStr = context.detection.mint.toString();
    const buf = context.logBuffer;

    // If disabled, pass through immediately
    if (!this.config.enabled) {
      if (buf) {
        buf.info('Research score gate: SKIPPED (disabled)');
      }
      return {
        pass: true,
        reason: 'Research score gate disabled',
        stage: this.name,
        durationMs: Date.now() - startTime,
      };
    }

    // If no model URL configured, pass with warning
    if (!this.config.researchBotUrl) {
      if (buf) {
        buf.info('Research score gate: SKIPPED (no RESEARCH_BOT_URL configured)');
      }
      return {
        pass: true,
        reason: 'No research bot URL configured',
        stage: this.name,
        durationMs: Date.now() - startTime,
      };
    }

    // If no model available (fetch failed), graceful degradation — pass
    if (!this.cachedModel) {
      this.noModelSkipCount++;
      const reason = `No model available (last error: ${this.lastFetchError || 'not yet fetched'})`;
      if (buf) {
        buf.info(`Research score gate: PASSED (graceful degradation) - ${reason}`);
      } else {
        logger.warn(
          { stage: this.name, mint: mintStr, lastFetchError: this.lastFetchError, noModelSkipCount: this.noModelSkipCount },
          '[research-score-gate] No model available — passing token (graceful degradation)',
        );
      }
      return {
        pass: true,
        reason,
        stage: this.name,
        durationMs: Date.now() - startTime,
      };
    }

    // Build feature vector from pipeline context
    const features = buildFeatureVector(context);

    // Score the token
    const { score, featureScores } = scoreToken(this.cachedModel, features);
    const signal = classifySignal(score);

    const gateData: ResearchScoreGateData = {
      score,
      signal,
      scoreThreshold: this.config.scoreThreshold,
      modelSampleCount: this.cachedModel.sampleCount,
      modelBaseRate2x: this.cachedModel.baseRate2x,
      features,
      featureScores,
    };

    // Log the score
    logger.debug(
      {
        stage: this.name,
        mint: mintStr,
        score,
        signal,
        threshold: this.config.scoreThreshold,
        passed: score >= this.config.scoreThreshold,
        logOnly: this.config.logOnly,
        topFeatures: featureScores
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((f) => `${f.name}=${f.raw}(${f.score})`),
      },
      '[research-score-gate] Score result',
    );

    const passed = score >= this.config.scoreThreshold;

    // In log-only mode, always pass
    if (this.config.logOnly) {
      const passReason = `Log-only mode: score=${score} signal=${signal} threshold=${this.config.scoreThreshold}`;
      if (buf) {
        buf.info(`Research score gate: PASSED (log-only) - ${passReason}`);
      }
      return {
        pass: true,
        reason: passReason,
        stage: this.name,
        data: gateData,
        durationMs: Date.now() - startTime,
      };
    }

    if (passed) {
      const passReason = `Score ${score} >= ${this.config.scoreThreshold} (${signal})`;
      if (buf) {
        buf.info(`Research score gate: PASSED - ${passReason}`);
      } else {
        logger.info(
          { stage: this.name, mint: mintStr, score, signal, threshold: this.config.scoreThreshold },
          '[pipeline] Research score gate passed',
        );
      }
      return {
        pass: true,
        reason: passReason,
        stage: this.name,
        data: gateData,
        durationMs: Date.now() - startTime,
      };
    }

    // Rejected
    const rejectReason = `${RejectionReasons.RESEARCH_SCORE_LOW}: score=${score} < threshold=${this.config.scoreThreshold} (${signal})`;
    if (buf) {
      buf.info(`Research score gate: REJECTED - ${rejectReason}`);
    } else {
      logger.info(
        { stage: this.name, mint: mintStr, score, signal, threshold: this.config.scoreThreshold },
        `[pipeline] Rejected: ${rejectReason}`,
      );
    }

    return {
      pass: false,
      reason: rejectReason,
      stage: this.name,
      data: gateData,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<ResearchScoreGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): ResearchScoreGateConfig {
    return { ...this.config };
  }

  /**
   * Get the cached model (for testing/debugging)
   */
  getModel(): ScoringModel | null {
    return this.cachedModel;
  }

  /**
   * Get the number of tokens that bypassed scoring due to no model being available.
   */
  getNoModelSkipCount(): number {
    return this.noModelSkipCount;
  }

  /**
   * Clean up refresh timer
   */
  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}
