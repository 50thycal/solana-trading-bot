/**
 * pump.fun Token Filters
 *
 * A filter system specifically designed for pump.fun bonding curve tokens.
 * Unlike Raydium LP pool filters, these evaluate bonding curve state
 * and token characteristics to identify quality opportunities.
 *
 * Design: Supports both blocking (pass/fail) and scoring (rank tokens).
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import BN from 'bn.js';
import {
  BondingCurveState,
  calculateMarketCapSol,
  calculatePrice,
  getGraduationProgress,
} from '../helpers/pumpfun';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Result of a single filter check
 */
export interface PumpFunFilterResult {
  filterName: string;
  passed: boolean;
  score: number; // 0-100, higher is better
  reason: string;
  actualValue?: string | number;
  thresholdValue?: string | number;
}

/**
 * Combined result from all filters
 */
export interface PumpFunFilterResults {
  allPassed: boolean;
  totalScore: number; // Sum of all filter scores
  maxPossibleScore: number; // Maximum possible score
  normalizedScore: number; // 0-100 percentage
  filters: PumpFunFilterResult[];
  summary: string;
  tokenMint: string;
  bondingCurve: string;
}

/**
 * Data available for filtering pump.fun tokens
 */
export interface PumpFunFilterContext {
  mint: PublicKey;
  bondingCurve: PublicKey;
  bondingCurveState: BondingCurveState;
  creator?: PublicKey;
  name?: string;
  symbol?: string;
  uri?: string;
  detectedAt: number;
}

/**
 * Interface for a single pump.fun filter
 */
export interface PumpFunFilter {
  name: string;
  description: string;
  /** If true, failing this filter blocks the buy. If false, it only affects score. */
  isBlocking: boolean;
  /** Maximum score this filter can contribute */
  maxScore: number;
  /** Execute the filter check */
  execute(context: PumpFunFilterContext): Promise<PumpFunFilterResult> | PumpFunFilterResult;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface PumpFunFilterConfig {
  /** Minimum SOL in bonding curve to consider (default: 5) */
  minSolInCurve: number;
  /** Maximum SOL in bonding curve - avoids near-graduation (default: 300) */
  maxSolInCurve: number;
  /** Enable min SOL filter (default: true) */
  enableMinSolFilter: boolean;
  /** Enable max SOL filter (default: true) */
  enableMaxSolFilter: boolean;
  /** Minimum score required to buy (0-100, default: 0 = any passing) */
  minScoreRequired: number;
}

export const DEFAULT_PUMPFUN_FILTER_CONFIG: PumpFunFilterConfig = {
  minSolInCurve: 5,
  maxSolInCurve: 300,
  enableMinSolFilter: true,
  enableMaxSolFilter: true,
  minScoreRequired: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL FILTERS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimum SOL in Bonding Curve Filter
 *
 * Rejects tokens that haven't attracted enough interest yet.
 * Rationale: Tokens with more SOL have proven some market validation.
 */
export class MinSolInCurveFilter implements PumpFunFilter {
  name = 'minSolInCurve';
  description = 'Requires minimum SOL deposited in bonding curve';
  isBlocking = true;
  maxScore = 20;

  constructor(private minSol: number) {}

  execute(context: PumpFunFilterContext): PumpFunFilterResult {
    const realSolInCurve = context.bondingCurveState.realSolReserves.toNumber() / LAMPORTS_PER_SOL;

    const passed = realSolInCurve >= this.minSol;

    // Score: 0 if below minimum, scales up to maxScore based on how much above minimum
    let score = 0;
    if (passed) {
      // Score scales from 10 to maxScore based on SOL amount
      // 5 SOL = 10 points, 50 SOL = 20 points
      const solAboveMin = realSolInCurve - this.minSol;
      const bonusScore = Math.min(10, solAboveMin / 5); // +1 point per 5 SOL above min, max 10 bonus
      score = 10 + bonusScore;
    }

    return {
      filterName: this.name,
      passed,
      score: Math.round(score),
      reason: passed
        ? `Has ${realSolInCurve.toFixed(2)} SOL (min: ${this.minSol})`
        : `Only ${realSolInCurve.toFixed(2)} SOL in curve (min: ${this.minSol} required)`,
      actualValue: realSolInCurve.toFixed(2),
      thresholdValue: this.minSol,
    };
  }
}

/**
 * Maximum SOL in Bonding Curve Filter
 *
 * Avoids tokens that are close to graduation.
 * Rationale: Near-graduation tokens have less upside potential on the curve.
 */
export class MaxSolInCurveFilter implements PumpFunFilter {
  name = 'maxSolInCurve';
  description = 'Avoids tokens near graduation threshold';
  isBlocking = true;
  maxScore = 15;

  constructor(private maxSol: number) {}

  execute(context: PumpFunFilterContext): PumpFunFilterResult {
    const realSolInCurve = context.bondingCurveState.realSolReserves.toNumber() / LAMPORTS_PER_SOL;
    const graduationProgress = getGraduationProgress(context.bondingCurveState);

    const passed = realSolInCurve <= this.maxSol;

    // Score: Higher for tokens earlier in the curve (more upside)
    // 0% progress = 15 points, 75% progress = 0 points
    let score = 0;
    if (passed) {
      score = Math.max(0, this.maxScore * (1 - graduationProgress / 100));
    }

    return {
      filterName: this.name,
      passed,
      score: Math.round(score),
      reason: passed
        ? `${realSolInCurve.toFixed(2)} SOL (${graduationProgress.toFixed(1)}% to graduation)`
        : `${realSolInCurve.toFixed(2)} SOL exceeds max ${this.maxSol} (${graduationProgress.toFixed(1)}% graduated)`,
      actualValue: realSolInCurve.toFixed(2),
      thresholdValue: this.maxSol,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILTER COORDINATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * PumpFunFilters - Coordinates all pump.fun filter checks
 *
 * Runs all enabled filters and produces a combined result with:
 * - Pass/fail status (all blocking filters must pass)
 * - Combined score (for ranking/prioritization)
 * - Detailed results per filter
 */
export class PumpFunFilters {
  private filters: PumpFunFilter[] = [];
  private config: PumpFunFilterConfig;

  constructor(config: Partial<PumpFunFilterConfig> = {}) {
    this.config = { ...DEFAULT_PUMPFUN_FILTER_CONFIG, ...config };
    this.initializeFilters();
  }

  private initializeFilters(): void {
    // Add enabled filters
    if (this.config.enableMinSolFilter) {
      this.filters.push(new MinSolInCurveFilter(this.config.minSolInCurve));
    }

    if (this.config.enableMaxSolFilter) {
      this.filters.push(new MaxSolInCurveFilter(this.config.maxSolInCurve));
    }

    logger.info(
      {
        filterCount: this.filters.length,
        filters: this.filters.map((f) => f.name),
        config: this.config,
      },
      '[pump.fun filters] Initialized'
    );
  }

  /**
   * Get current configuration
   */
  getConfig(): PumpFunFilterConfig {
    return { ...this.config };
  }

  /**
   * Get list of active filter names
   */
  getActiveFilters(): string[] {
    return this.filters.map((f) => f.name);
  }

  /**
   * Execute all filters and return combined results
   */
  async execute(context: PumpFunFilterContext): Promise<PumpFunFilterResults> {
    const results: PumpFunFilterResult[] = [];
    let allPassed = true;
    let totalScore = 0;
    let maxPossibleScore = 0;

    for (const filter of this.filters) {
      try {
        const result = await filter.execute(context);
        results.push(result);

        maxPossibleScore += filter.maxScore;
        totalScore += result.score;

        // Check if blocking filter failed
        if (filter.isBlocking && !result.passed) {
          allPassed = false;
        }
      } catch (error) {
        logger.error(
          { error, filterName: filter.name, mint: context.mint.toString() },
          '[pump.fun filters] Filter execution error'
        );

        // Treat errors as failures for blocking filters
        results.push({
          filterName: filter.name,
          passed: false,
          score: 0,
          reason: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });

        if (filter.isBlocking) {
          allPassed = false;
        }
      }
    }

    // Check minimum score requirement
    const normalizedScore = maxPossibleScore > 0 ? (totalScore / maxPossibleScore) * 100 : 0;
    if (this.config.minScoreRequired > 0 && normalizedScore < this.config.minScoreRequired) {
      allPassed = false;
    }

    // Build summary
    const passedCount = results.filter((r) => r.passed).length;
    const failedFilters = results.filter((r) => !r.passed).map((r) => r.filterName);
    const summary = allPassed
      ? `All ${results.length} filters passed (score: ${normalizedScore.toFixed(0)}%)`
      : `Failed: ${failedFilters.join(', ')} (${passedCount}/${results.length} passed)`;

    return {
      allPassed,
      totalScore,
      maxPossibleScore,
      normalizedScore: Math.round(normalizedScore),
      filters: results,
      summary,
      tokenMint: context.mint.toString(),
      bondingCurve: context.bondingCurve.toString(),
    };
  }

  /**
   * Quick check - returns just pass/fail without full details
   */
  async check(context: PumpFunFilterContext): Promise<boolean> {
    const results = await this.execute(context);
    return results.allPassed;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

let pumpFunFiltersInstance: PumpFunFilters | null = null;

/**
 * Initialize the pump.fun filters singleton
 */
export function initPumpFunFilters(config: Partial<PumpFunFilterConfig> = {}): PumpFunFilters {
  pumpFunFiltersInstance = new PumpFunFilters(config);
  return pumpFunFiltersInstance;
}

/**
 * Get the pump.fun filters singleton (must be initialized first)
 */
export function getPumpFunFilters(): PumpFunFilters | null {
  return pumpFunFiltersInstance;
}
