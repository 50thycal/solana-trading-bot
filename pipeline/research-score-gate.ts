/**
 * Research Score Gate Stage
 *
 * Fetches a scoring model from the research bot, polls transaction data
 * during the checkpoint wait period to build momentum features (txBurst,
 * buyAcceleration), then scores the token using the model's rules.
 * Only passes if the score exceeds the configured threshold.
 *
 * Design:
 * - Fetch model from research bot on startup + periodic refresh
 * - Poll transactions during checkpoint wait to build time-series data
 * - Build TokenFeatureVector from BondingCurveState + polled tx data
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
import { logger, getBondingCurveState, BondingCurveState, sleep } from '../helpers';
import { fetchAndAnalyzeTransactions, WalletAnalysis } from './sniper-gate';

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
  /** How often to poll transactions during checkpoint wait, in seconds (default: 3) */
  pollIntervalSeconds: number;
  /** Sniper slot threshold for wallet classification (default: 3) */
  sniperSlotThreshold: number;
  /** Max signatures to fetch per poll (default: 40) */
  signatureLimit: number;
}

const DEFAULT_CONFIG: ResearchScoreGateConfig = {
  enabled: true,
  researchBotUrl: '',
  modelRefreshIntervalMs: 300000,
  scoreThreshold: 50,
  logOnly: false,
  checkpoint: 30,
  pollIntervalSeconds: 3,
  sniperSlotThreshold: 3,
  signatureLimit: 40,
};

// ═══════════════════════════════════════════════════════════════════════════════
// LAMPORT CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

const LAMPORTS_PER_SOL = 1_000_000_000;

function bnToSol(bn: BN): number {
  return bn.toNumber() / LAMPORTS_PER_SOL;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POLL SNAPSHOT (replaces SniperGateCheckResult for momentum features)
// ═══════════════════════════════════════════════════════════════════════════════

interface PollSnapshot {
  /** Unix timestamp (ms) when this poll completed */
  checkedAt: number;
  /** Total buy transactions seen */
  totalBuys: number;
  /** Total sell transactions seen */
  totalSells: number;
  /** Unique organic buyer wallets */
  uniqueBuyers: number;
  /** Sniper wallets that exited */
  uniqueSellers: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEATURE VECTOR BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a TokenFeatureVector from pipeline context data + polled transaction snapshots.
 * Uses BondingCurveState from deep filters for price data.
 * Uses pollHistory for momentum features (txBurst, buyAcceleration).
 * Uses the final poll snapshot for transaction counts.
 */
function buildFeatureVector(
  ctx: PipelineContext,
  freshBcs: BondingCurveState | undefined,
  pollHistory: PollSnapshot[],
): TokenFeatureVector {
  const initialBcs = ctx.deepFilters!.bondingCurveState;
  const detection = ctx.detection;

  // Time since detection
  const secondsSinceCreation = (Date.now() - detection.detectedAt) / 1000;

  // Use fresh bonding curve state for current values if available, otherwise fall back to initial
  const currentBcs = freshBcs || initialBcs;

  // Initial price from deep filters bonding curve read
  const initialVirtualSol = bnToSol(initialBcs.virtualSolReserves);
  const initialVirtualTokens = initialBcs.virtualTokenReserves.toNumber();
  const initialPriceSol = initialVirtualTokens > 0 ? initialVirtualSol / initialVirtualTokens : 0;

  // Current price from fresh bonding curve read (or initial if unavailable)
  const currentVirtualSol = bnToSol(currentBcs.virtualSolReserves);
  const currentVirtualTokens = currentBcs.virtualTokenReserves.toNumber();
  const currentPriceSol = currentVirtualTokens > 0 ? currentVirtualSol / currentVirtualTokens : 0;

  // Price change from initial (percentage)
  let priceChangeFromInitial = 0;
  if (freshBcs && initialPriceSol > 0) {
    priceChangeFromInitial = ((currentPriceSol - initialPriceSol) / initialPriceSol) * 100;
  }

  // Price acceleration: rate of price change per second
  let priceAcceleration = 0;
  if (freshBcs && secondsSinceCreation > 0) {
    priceAcceleration = priceChangeFromInitial / secondsSinceCreation;
  }

  // Transaction data from the latest poll snapshot (or zeros if no polls)
  const lastPoll = pollHistory.length > 0 ? pollHistory[pollHistory.length - 1] : null;
  const buyCount = lastPoll ? lastPoll.totalBuys : 0;
  const sellCount = lastPoll ? lastPoll.totalSells : 0;
  const totalTxCount = buyCount + sellCount;
  const uniqueBuyers = lastPoll ? lastPoll.uniqueBuyers : 0;
  const uniqueSellers = lastPoll ? lastPoll.uniqueSellers : 0;

  // Derived features
  const buyVelocity = secondsSinceCreation > 0 ? buyCount / secondsSinceCreation : 0;
  const sellRatio = totalTxCount > 0 ? sellCount / totalTxCount : 0;
  const buyerTxRatio = buyCount > 0 ? uniqueBuyers / buyCount : 0;

  const realTokenReserves = currentBcs.realTokenReserves.toNumber();
  const marketCapSol = currentPriceSol * (currentVirtualTokens + realTokenReserves);

  // Momentum features derived from poll history
  let buyAcceleration = 0;
  let txBurst = 0;

  if (pollHistory.length >= 2) {
    const first = pollHistory[0];
    const last = pollHistory[pollHistory.length - 1];
    const timeDelta = (last.checkedAt - first.checkedAt) / 1000;
    if (timeDelta > 0) {
      buyAcceleration = (last.totalBuys - first.totalBuys) / timeDelta;
    }

    // txBurst: max new transactions between consecutive polls
    for (let i = 1; i < pollHistory.length; i++) {
      const prevTotal = pollHistory[i - 1].totalBuys + pollHistory[i - 1].totalSells;
      const currTotal = pollHistory[i].totalBuys + pollHistory[i].totalSells;
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
    priceSol: currentPriceSol,
    priceChangeFromInitial,
    realSolReserves: bnToSol(currentBcs.realSolReserves),
    totalTxCount,
    buyCount,
    sellCount,
    uniqueBuyers,
    uniqueSellers,
    buyVelocity,
    sellRatio,
    buyerTxRatio,
    marketCapSol,
    priceAcceleration,
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

  private connection: Connection;
  private config: ResearchScoreGateConfig;
  private cachedModel: ScoringModel | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastFetchError: string | null = null;
  private noModelSkipCount: number = 0;

  constructor(connection: Connection, config: Partial<ResearchScoreGateConfig> = {}) {
    this.connection = connection;
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

    const totalWeight = this.cachedModel.rules.reduce((sum, r) => sum + r.weight, 0);
    const theoreticalMax = Math.round(totalWeight * 100 * 100) / 100;

    logger.info(
      {
        checkpoint: this.cachedModel.checkpointSeconds,
        ruleCount: this.cachedModel.rules.length,
        sampleCount: this.cachedModel.sampleCount,
        baseRate2x: this.cachedModel.baseRate2x,
        totalWeight: Math.round(totalWeight * 10000) / 10000,
        theoreticalMaxScore: theoreticalMax,
        ruleDetails: this.cachedModel.rules.map(r => ({
          feature: r.featureName,
          weight: r.weight,
          direction: r.direction,
          min: r.min,
          max: r.max,
          maxContribution: Math.round(r.weight * 100 * 100) / 100,
        })),
      },
      '[research-score-gate] Model fetched successfully',
    );
  }

  /**
   * Poll transactions once and return a snapshot.
   */
  private async pollTransactions(context: PipelineContext): Promise<PollSnapshot | null> {
    try {
      const analysis: WalletAnalysis = await fetchAndAnalyzeTransactions(
        this.connection,
        context.detection.bondingCurve,
        context.detection.slot,
        this.config.sniperSlotThreshold,
        this.config.signatureLimit,
      );
      const sniperExitCount = [...analysis.sniperWallets.values()].filter(v => v === 'exited').length;
      return {
        checkedAt: Date.now(),
        totalBuys: analysis.totalBuys,
        totalSells: analysis.totalSells,
        uniqueBuyers: analysis.organicWallets.size,
        uniqueSellers: sniperExitCount,
      };
    } catch (err) {
      logger.debug(
        { stage: this.name, mint: context.detection.mint.toString(), error: err instanceof Error ? err.message : String(err) },
        '[research-score-gate] Transaction poll failed — skipping this snapshot',
      );
      return null;
    }
  }

  /**
   * Wait for checkpoint age while polling transactions to build momentum data.
   * Returns the accumulated poll history.
   */
  private async waitAndPoll(context: PipelineContext): Promise<PollSnapshot[]> {
    const pollHistory: PollSnapshot[] = [];
    const mintStr = context.detection.mint.toString();
    const buf = context.logBuffer;
    const pollIntervalMs = this.config.pollIntervalSeconds * 1000;
    const targetMs = this.config.checkpoint * 1000;

    // How long until checkpoint age?
    const elapsedMs = Date.now() - context.detection.detectedAt;
    const remainingMs = targetMs - elapsedMs;

    if (remainingMs <= 0) {
      // Already past checkpoint — do a single poll for fresh data
      logger.debug(
        { stage: this.name, mint: mintStr, elapsedMs, targetMs },
        '[research-score-gate] Token already past checkpoint age — doing single poll',
      );
      const snapshot = await this.pollTransactions(context);
      if (snapshot) pollHistory.push(snapshot);
      return pollHistory;
    }

    if (buf) {
      buf.info(`Research score gate: polling transactions every ${this.config.pollIntervalSeconds}s for ${Math.round(remainingMs)}ms until checkpoint age (${this.config.checkpoint}s)`);
    }

    // Do an immediate first poll, then poll at intervals until checkpoint
    const snapshot = await this.pollTransactions(context);
    if (snapshot) pollHistory.push(snapshot);

    while (true) {
      const nowElapsed = Date.now() - context.detection.detectedAt;
      const timeLeft = targetMs - nowElapsed;
      if (timeLeft <= 0) break;

      // Sleep for the shorter of pollInterval or remaining time
      const sleepMs = Math.min(pollIntervalMs, timeLeft);
      await sleep(sleepMs);

      // Check again if we've reached checkpoint
      const postSleepElapsed = Date.now() - context.detection.detectedAt;
      if (postSleepElapsed >= targetMs) break;

      // Poll
      const snap = await this.pollTransactions(context);
      if (snap) pollHistory.push(snap);
    }

    // Final poll at checkpoint age
    const finalSnap = await this.pollTransactions(context);
    if (finalSnap) pollHistory.push(finalSnap);

    logger.debug(
      { stage: this.name, mint: mintStr, pollCount: pollHistory.length },
      '[research-score-gate] Checkpoint polling complete',
    );

    return pollHistory;
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

    // ─── Wait for checkpoint age while polling transactions ───────────
    const pollHistory = await this.waitAndPoll(context);

    // ─── Fetch fresh bonding curve state at checkpoint age ────────────
    let freshBcs: BondingCurveState | undefined;
    try {
      const result = await getBondingCurveState(this.connection, context.detection.bondingCurve);
      if (result) {
        freshBcs = result;
      } else {
        logger.debug(
          { stage: this.name, mint: mintStr },
          '[research-score-gate] Fresh bonding curve fetch returned null — using initial state only',
        );
      }
    } catch (err) {
      logger.debug(
        { stage: this.name, mint: mintStr, error: err instanceof Error ? err.message : String(err) },
        '[research-score-gate] Fresh bonding curve fetch failed — using initial state only',
      );
    }

    // Build feature vector from pipeline context + polled data
    const features = buildFeatureVector(context, freshBcs, pollHistory);

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
      freshBondingCurveState: freshBcs,
    };

    // Log the score breakdown at info level for diagnostics
    const sortedFeatures = [...featureScores].sort((a, b) => b.score - a.score);
    logger.info(
      {
        stage: this.name,
        mint: mintStr,
        score,
        signal,
        threshold: this.config.scoreThreshold,
        passed: score >= this.config.scoreThreshold,
        pollSnapshots: pollHistory.length,
        featureBreakdown: sortedFeatures.map((f) => `${f.name}=${f.raw}(${f.score})`),
      },
      '[research-score-gate] Score breakdown',
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
