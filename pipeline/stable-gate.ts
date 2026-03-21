/**
 * Stable Gate Stage
 *
 * Stage 6 of the pipeline — runs AFTER the research score gate as the final
 * buy-readiness check. Confirms the token is safe to buy RIGHT NOW by running
 * three sub-checks:
 *
 * 1. Price Stabilization: Takes multiple bonding curve snapshots and confirms
 *    the price is flat or rising (not mid-dump).
 * 2. Curve Re-Validation: Re-fetches bonding curve state and verifies SOL
 *    reserves still meet the minimum threshold after bot dumps.
 * 3. Sell Ratio Hard Gate: Fetches fresh transaction data and rejects if the
 *    sell ratio (sells / total txs) is too high.
 *
 * If any sub-check fails, the gate waits and retries up to a configurable
 * number of times before rejecting the token.
 */

import { Connection } from '@solana/web3.js';
import BN from 'bn.js';
import {
  PipelineContext,
  StageResult,
  PipelineStage,
  RejectionReasons,
  StableGateData,
} from './types';
import { BondingCurveState } from '../helpers/pumpfun';
import { logger, getBondingCurveState, sleep } from '../helpers';
import { fetchAndAnalyzeTransactions } from './sniper-gate';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface StableGateConfig {
  /** Enable/disable the stable gate (default: true) */
  enabled: boolean;
  /** If true, always pass but log the results (default: false) */
  logOnly: boolean;
  /** Max retry attempts before rejecting (default: 5) */
  maxRetries: number;
  /** Seconds to wait between retries (default: 5) */
  retryDelaySeconds: number;
  /** Number of bonding curve snapshots for price trend (default: 3) */
  priceSnapshots: number;
  /** Milliseconds between price snapshots (default: 500) */
  snapshotIntervalMs: number;
  /** Max allowed price decline across snapshots in % (default: 5) */
  maxPriceDropPercent: number;
  /** Min SOL in curve post-dump; 0 = use PUMPFUN_MIN_SOL_IN_CURVE (default: 0) */
  minSolInCurve: number;
  /** Fallback min SOL from deep filters config (used when minSolInCurve is 0) */
  fallbackMinSolInCurve: number;
  /** Max sell ratio (sells/total txs); reject if exceeded (default: 0.4) */
  maxSellRatio: number;
}

const DEFAULT_CONFIG: StableGateConfig = {
  enabled: true,
  logOnly: false,
  maxRetries: 5,
  retryDelaySeconds: 5,
  priceSnapshots: 3,
  snapshotIntervalMs: 500,
  maxPriceDropPercent: 5,
  minSolInCurve: 0,
  fallbackMinSolInCurve: 5,
  maxSellRatio: 0.4,
};

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const LAMPORTS_PER_SOL = 1_000_000_000;

function bnToSol(bn: BN): number {
  return bn.toNumber() / LAMPORTS_PER_SOL;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STABLE GATE STAGE
// ═══════════════════════════════════════════════════════════════════════════════

export class StableGateStage implements PipelineStage<PipelineContext, StableGateData> {
  name = 'stable-gate';

  private connection: Connection;
  private config: StableGateConfig;

  constructor(connection: Connection, config: Partial<StableGateConfig> = {}) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(context: PipelineContext): Promise<StageResult<StableGateData>> {
    const startTime = Date.now();
    const mintStr = context.detection.mint.toString();
    const buf = context.logBuffer;

    // If disabled, pass through immediately
    if (!this.config.enabled) {
      if (buf) {
        buf.info('Stable gate: SKIPPED (disabled)');
      }
      return {
        pass: true,
        reason: 'Stable gate disabled',
        stage: this.name,
        durationMs: Date.now() - startTime,
      };
    }

    const effectiveMinSol = this.config.minSolInCurve > 0
      ? this.config.minSolInCurve
      : this.config.fallbackMinSolInCurve;

    const totalAttempts = this.config.maxRetries + 1; // first attempt + retries

    let lastPriceResult: StableGateData['priceStabilization'] = {
      passed: false,
      snapshots: [],
      priceChangePct: 0,
    };
    let lastCurveResult: StableGateData['curveReValidation'] = {
      passed: false,
      freshSolInCurve: 0,
      minRequired: effectiveMinSol,
    };
    let lastSellResult: StableGateData['sellRatioCheck'] = {
      passed: false,
      sellRatio: 0,
      maxAllowed: this.config.maxSellRatio,
      totalBuys: 0,
      totalSells: 0,
    };
    let lastFreshBcs: BondingCurveState | undefined;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const isRetry = attempt > 1;

      if (isRetry) {
        if (buf) {
          buf.info(`Stable gate: retry ${attempt - 1}/${this.config.maxRetries} — waiting ${this.config.retryDelaySeconds}s`);
        }
        await sleep(this.config.retryDelaySeconds * 1000);
      }

      logger.debug(
        { stage: this.name, mint: mintStr, attempt, totalAttempts },
        `[stable-gate] Attempt ${attempt}/${totalAttempts}`,
      );

      // ─── Sub-check 1: Price Stabilization ──────────────────────────
      const snapshots: Array<{ priceSol: number; timestamp: number }> = [];

      let priceCheckFailed = false;
      for (let i = 0; i < this.config.priceSnapshots; i++) {
        if (i > 0) {
          await sleep(this.config.snapshotIntervalMs);
        }
        try {
          const bcs = await getBondingCurveState(this.connection, context.detection.bondingCurve);
          if (!bcs) {
            priceCheckFailed = true;
            break;
          }
          const virtualSol = bnToSol(bcs.virtualSolReserves);
          const virtualTokens = bcs.virtualTokenReserves.toNumber();
          const priceSol = virtualTokens > 0 ? virtualSol / virtualTokens : 0;
          snapshots.push({ priceSol, timestamp: Date.now() });
        } catch (err) {
          logger.debug(
            { stage: this.name, mint: mintStr, error: err instanceof Error ? err.message : String(err) },
            '[stable-gate] Bonding curve snapshot failed',
          );
          priceCheckFailed = true;
          break;
        }
      }

      let priceChangePct = 0;
      if (snapshots.length >= 2) {
        const firstPrice = snapshots[0].priceSol;
        const lastPrice = snapshots[snapshots.length - 1].priceSol;
        priceChangePct = firstPrice > 0
          ? ((lastPrice - firstPrice) / firstPrice) * 100
          : 0;
      }

      const pricePassed = !priceCheckFailed
        && snapshots.length >= 2
        && priceChangePct >= -this.config.maxPriceDropPercent;

      lastPriceResult = {
        passed: pricePassed,
        snapshots,
        priceChangePct: Math.round(priceChangePct * 100) / 100,
      };

      // ─── Sub-check 2: Curve Re-Validation ──────────────────────────
      // Use the last snapshot's data if available, otherwise fetch fresh
      let freshSolInCurve = 0;
      let curveCheckFailed = false;

      if (snapshots.length > 0) {
        // We already have the latest state from the snapshot loop; re-fetch for reserves
        try {
          const bcs = await getBondingCurveState(this.connection, context.detection.bondingCurve);
          if (bcs) {
            freshSolInCurve = bnToSol(bcs.realSolReserves);
            lastFreshBcs = bcs;
          } else {
            curveCheckFailed = true;
          }
        } catch {
          curveCheckFailed = true;
        }
      } else {
        // No snapshots (all failed), try one dedicated fetch
        try {
          const bcs = await getBondingCurveState(this.connection, context.detection.bondingCurve);
          if (bcs) {
            freshSolInCurve = bnToSol(bcs.realSolReserves);
            lastFreshBcs = bcs;
          } else {
            curveCheckFailed = true;
          }
        } catch {
          curveCheckFailed = true;
        }
      }

      const curvePassed = !curveCheckFailed && freshSolInCurve >= effectiveMinSol;

      lastCurveResult = {
        passed: curvePassed,
        freshSolInCurve: Math.round(freshSolInCurve * 1000) / 1000,
        minRequired: effectiveMinSol,
      };

      // ─── Sub-check 3: Sell Ratio Hard Gate ─────────────────────────
      let sellRatio = 0;
      let totalBuys = 0;
      let totalSells = 0;
      let sellCheckFailed = false;

      try {
        const sniperSlotThreshold = 3;
        const signatureLimit = 30;
        const analysis = await fetchAndAnalyzeTransactions(
          this.connection,
          context.detection.bondingCurve,
          context.detection.slot,
          sniperSlotThreshold,
          signatureLimit,
        );
        totalBuys = analysis.totalBuys;
        totalSells = analysis.totalSells;
        const totalTxs = totalBuys + totalSells;
        sellRatio = totalTxs > 0 ? totalSells / totalTxs : 0;
      } catch (err) {
        logger.debug(
          { stage: this.name, mint: mintStr, error: err instanceof Error ? err.message : String(err) },
          '[stable-gate] Transaction fetch for sell ratio failed',
        );
        sellCheckFailed = true;
      }

      const sellPassed = !sellCheckFailed && sellRatio <= this.config.maxSellRatio;

      lastSellResult = {
        passed: sellPassed,
        sellRatio: Math.round(sellRatio * 1000) / 1000,
        maxAllowed: this.config.maxSellRatio,
        totalBuys,
        totalSells,
      };

      // ─── Evaluate ──────────────────────────────────────────────────
      const allPassed = pricePassed && curvePassed && sellPassed;

      logger.debug(
        {
          stage: this.name,
          mint: mintStr,
          attempt,
          pricePassed,
          priceChangePct: lastPriceResult.priceChangePct,
          curvePassed,
          freshSolInCurve: lastCurveResult.freshSolInCurve,
          sellPassed,
          sellRatio: lastSellResult.sellRatio,
          allPassed,
        },
        `[stable-gate] Attempt ${attempt} result`,
      );

      if (allPassed || this.config.logOnly) {
        const gateData: StableGateData = {
          attemptNumber: attempt,
          totalAttempts: attempt,
          priceStabilization: lastPriceResult,
          curveReValidation: lastCurveResult,
          sellRatioCheck: lastSellResult,
          totalWaitMs: Date.now() - startTime,
          freshBondingCurveState: lastFreshBcs,
        };

        if (this.config.logOnly) {
          const reason = `Log-only mode: price=${pricePassed} curve=${curvePassed} sell=${sellPassed} attempt=${attempt}`;
          if (buf) {
            buf.info(`Stable gate: PASSED (log-only) - ${reason}`);
          }
          return {
            pass: true,
            reason,
            stage: this.name,
            data: gateData,
            durationMs: Date.now() - startTime,
          };
        }

        const reason = `All checks passed on attempt ${attempt}/${totalAttempts} — price=${lastPriceResult.priceChangePct}% sol=${lastCurveResult.freshSolInCurve} sellRatio=${lastSellResult.sellRatio}`;
        if (buf) {
          buf.info(`Stable gate: PASSED - ${reason}`);
        } else {
          logger.info(
            { stage: this.name, mint: mintStr, attempt, ...gateData },
            '[pipeline] Stable gate passed',
          );
        }
        return {
          pass: true,
          reason,
          stage: this.name,
          data: gateData,
          durationMs: Date.now() - startTime,
        };
      }

      // Log which sub-checks failed for this attempt
      const failedChecks: string[] = [];
      if (!pricePassed) failedChecks.push(`price(${lastPriceResult.priceChangePct}%)`);
      if (!curvePassed) failedChecks.push(`curve(${lastCurveResult.freshSolInCurve}<${effectiveMinSol})`);
      if (!sellPassed) failedChecks.push(`sellRatio(${lastSellResult.sellRatio}>${this.config.maxSellRatio})`);

      if (buf) {
        buf.info(`Stable gate: attempt ${attempt}/${totalAttempts} FAILED — ${failedChecks.join(', ')}`);
      }
    }

    // All retries exhausted — reject
    const gateData: StableGateData = {
      attemptNumber: totalAttempts,
      totalAttempts,
      priceStabilization: lastPriceResult,
      curveReValidation: lastCurveResult,
      sellRatioCheck: lastSellResult,
      totalWaitMs: Date.now() - startTime,
      freshBondingCurveState: lastFreshBcs,
    };

    // Determine the primary rejection reason based on which checks failed
    let rejectReason: string;
    if (!lastPriceResult.passed) {
      rejectReason = `${RejectionReasons.STABLE_GATE_PRICE_FALLING}: priceChange=${lastPriceResult.priceChangePct}% over ${totalAttempts} attempts`;
    } else if (!lastCurveResult.passed) {
      rejectReason = `${RejectionReasons.STABLE_GATE_CURVE_DEPLETED}: sol=${lastCurveResult.freshSolInCurve} < min=${effectiveMinSol}`;
    } else if (!lastSellResult.passed) {
      rejectReason = `${RejectionReasons.STABLE_GATE_HIGH_SELL_RATIO}: ratio=${lastSellResult.sellRatio} > max=${this.config.maxSellRatio}`;
    } else {
      rejectReason = `${RejectionReasons.STABLE_GATE_TIMEOUT}: exhausted ${totalAttempts} attempts`;
    }

    if (buf) {
      buf.info(`Stable gate: REJECTED - ${rejectReason}`);
    } else {
      logger.info(
        { stage: this.name, mint: mintStr, ...gateData },
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

  updateConfig(config: Partial<StableGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): StableGateConfig {
    return { ...this.config };
  }
}
