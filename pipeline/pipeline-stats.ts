/**
 * Pipeline Stats Tracker
 *
 * Tracks statistics for each pipeline gate/filter for the dashboard.
 * In-memory stats that can be reset by the user.
 */

import { PipelineResult } from './pipeline';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface GateStats {
  name: string;
  displayName: string;
  passed: number;
  failed: number;
  totalChecked: number;
}

export interface PipelineStatsSnapshot {
  /** When stats tracking started (or last reset) */
  startedAt: number;

  /** Total tokens detected */
  tokensDetected: number;

  /** Tokens that passed all gates and were bought */
  tokensBought: number;

  /** Tokens rejected at some gate */
  tokensRejected: number;

  /** Buy rate percentage */
  buyRate: number;

  /** Per-gate statistics */
  gateStats: {
    cheapGates: GateStats[];
    deepFilters: GateStats[];
  };

  /** Top rejection reasons with counts */
  topRejectionReasons: Array<{ reason: string; count: number }>;

  /** Average pipeline duration in ms */
  avgPipelineDurationMs: number;

  /** Total pipeline duration for calculating average */
  totalPipelineDurationMs: number;

  /** Recent tokens (last 100) */
  recentTokens: RecentToken[];
}

export interface RecentToken {
  mint: string;
  name?: string;
  symbol?: string;
  detectedAt: number;
  outcome: 'bought' | 'rejected';
  rejectedAt?: string;
  rejectionReason?: string;
  pipelineDurationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GATE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════

/** All cheap gates in order */
const CHEAP_GATES = [
  { name: 'dedupe', displayName: 'Dedupe Check' },
  { name: 'blacklist', displayName: 'Blacklist Check' },
  { name: 'exposure', displayName: 'Exposure Check' },
  { name: 'pattern', displayName: 'Name/Symbol Pattern' },
  { name: 'mint-info', displayName: 'Mint Info Check' },
];

/** All deep filters in order */
const DEEP_FILTERS = [
  { name: 'graduation', displayName: 'Graduation Check' },
  { name: 'min-sol', displayName: 'Min SOL in Curve' },
  { name: 'max-sol', displayName: 'Max SOL in Curve' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE STATS CLASS
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_RECENT_TOKENS = 100;

export class PipelineStats {
  private startedAt: number;
  private tokensDetected: number = 0;
  private tokensBought: number = 0;
  private tokensRejected: number = 0;

  /** Gate pass/fail counters */
  private cheapGateStats: Map<string, { passed: number; failed: number }>;
  private deepFilterStats: Map<string, { passed: number; failed: number }>;

  /** Rejection reason counters */
  private rejectionReasons: Map<string, number>;

  /** Pipeline duration tracking */
  private totalPipelineDurationMs: number = 0;
  private pipelineCount: number = 0;

  /** Recent tokens for scrollable list */
  private recentTokens: RecentToken[] = [];

  constructor() {
    this.startedAt = Date.now();
    this.cheapGateStats = new Map();
    this.deepFilterStats = new Map();
    this.rejectionReasons = new Map();

    // Initialize all gates with zero counts
    for (const gate of CHEAP_GATES) {
      this.cheapGateStats.set(gate.name, { passed: 0, failed: 0 });
    }
    for (const filter of DEEP_FILTERS) {
      this.deepFilterStats.set(filter.name, { passed: 0, failed: 0 });
    }

    logger.info('[pipeline-stats] Initialized');
  }

  /**
   * Record a pipeline result
   */
  recordResult(result: PipelineResult): void {
    this.tokensDetected++;
    this.pipelineCount++;
    this.totalPipelineDurationMs += result.totalDurationMs;

    const detection = result.context.detection;
    const recentToken: RecentToken = {
      mint: detection.mint.toString(),
      name: detection.name,
      symbol: detection.symbol,
      detectedAt: detection.detectedAt,
      outcome: result.success ? 'bought' : 'rejected',
      rejectedAt: result.rejectedAt,
      rejectionReason: result.rejectionReason,
      pipelineDurationMs: result.totalDurationMs,
    };

    // Add to recent tokens (keep last MAX_RECENT_TOKENS)
    this.recentTokens.unshift(recentToken);
    if (this.recentTokens.length > MAX_RECENT_TOKENS) {
      this.recentTokens.pop();
    }

    if (result.success) {
      this.tokensBought++;
      // All gates passed
      this.recordAllGatesPassed();
    } else {
      this.tokensRejected++;
      // Record which gate rejected and track the reason
      this.recordRejection(result.rejectedAt, result.rejectionReason);
    }
  }

  /**
   * Record that all gates passed (for bought tokens)
   */
  private recordAllGatesPassed(): void {
    // All cheap gates passed
    for (const gate of CHEAP_GATES) {
      const stats = this.cheapGateStats.get(gate.name)!;
      stats.passed++;
    }

    // All deep filters passed
    for (const filter of DEEP_FILTERS) {
      const stats = this.deepFilterStats.get(filter.name)!;
      stats.passed++;
    }
  }

  /**
   * Record a rejection at a specific stage
   */
  private recordRejection(rejectedAt?: string, reason?: string): void {
    if (!rejectedAt || !reason) return;

    // Track rejection reason
    const currentCount = this.rejectionReasons.get(reason) || 0;
    this.rejectionReasons.set(reason, currentCount + 1);

    // Determine which gates passed before rejection
    if (rejectedAt === 'cheap-gates') {
      this.recordCheapGatesRejection(reason);
    } else if (rejectedAt === 'deep-filters') {
      // All cheap gates passed
      for (const gate of CHEAP_GATES) {
        const stats = this.cheapGateStats.get(gate.name)!;
        stats.passed++;
      }
      this.recordDeepFiltersRejection(reason);
    }
  }

  /**
   * Record which cheap gate rejected based on the reason
   */
  private recordCheapGatesRejection(reason: string): void {
    // Map rejection reasons to gate names
    const reasonToGate: Record<string, string> = {
      ALREADY_PROCESSED: 'dedupe',
      ALREADY_OWNED: 'dedupe',
      PENDING_TRADE: 'dedupe',
      MINT_BLACKLISTED: 'blacklist',
      CREATOR_BLACKLISTED: 'blacklist',
      EXPOSURE_LIMIT: 'exposure',
      TRADES_PER_HOUR: 'exposure',
      INSUFFICIENT_BALANCE: 'exposure',
      JUNK_NAME: 'pattern',
      JUNK_SYMBOL: 'pattern',
      MINT_NOT_RENOUNCED: 'mint-info',
      HAS_FREEZE_AUTHORITY: 'mint-info',
      INVALID_DECIMALS: 'mint-info',
      MINT_FETCH_FAILED: 'mint-info',
    };

    const failedGate = reasonToGate[reason] || 'dedupe'; // Default to first gate if unknown
    let foundFailed = false;

    for (const gate of CHEAP_GATES) {
      const stats = this.cheapGateStats.get(gate.name)!;
      if (gate.name === failedGate) {
        stats.failed++;
        foundFailed = true;
        break; // Stop processing after the failed gate
      } else {
        stats.passed++;
      }
    }

    // If we didn't find the failed gate, mark the first one as failed
    if (!foundFailed) {
      const firstGate = this.cheapGateStats.get('dedupe')!;
      firstGate.failed++;
    }
  }

  /**
   * Record which deep filter rejected based on the reason
   */
  private recordDeepFiltersRejection(reason: string): void {
    // Map rejection reasons to filter names
    const reasonToFilter: Record<string, string> = {
      CURVE_NOT_FOUND: 'graduation',
      CURVE_FETCH_FAILED: 'graduation',
      ALREADY_GRADUATED: 'graduation',
      MIN_SOL_IN_CURVE: 'min-sol',
      MAX_SOL_IN_CURVE: 'max-sol',
      SCORE_TOO_LOW: 'max-sol', // Score failures happen after all filters
    };

    const failedFilter = reasonToFilter[reason] || 'graduation';
    let foundFailed = false;

    for (const filter of DEEP_FILTERS) {
      const stats = this.deepFilterStats.get(filter.name)!;
      if (filter.name === failedFilter) {
        stats.failed++;
        foundFailed = true;
        break;
      } else {
        stats.passed++;
      }
    }

    if (!foundFailed) {
      const firstFilter = this.deepFilterStats.get('graduation')!;
      firstFilter.failed++;
    }
  }

  /**
   * Get current stats snapshot
   */
  getSnapshot(): PipelineStatsSnapshot {
    // Build gate stats arrays
    const cheapGatesArray: GateStats[] = CHEAP_GATES.map((gate) => {
      const stats = this.cheapGateStats.get(gate.name)!;
      return {
        name: gate.name,
        displayName: gate.displayName,
        passed: stats.passed,
        failed: stats.failed,
        totalChecked: stats.passed + stats.failed,
      };
    });

    const deepFiltersArray: GateStats[] = DEEP_FILTERS.map((filter) => {
      const stats = this.deepFilterStats.get(filter.name)!;
      return {
        name: filter.name,
        displayName: filter.displayName,
        passed: stats.passed,
        failed: stats.failed,
        totalChecked: stats.passed + stats.failed,
      };
    });

    // Build top rejection reasons
    const topRejectionReasons = Array.from(this.rejectionReasons.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const avgPipelineDurationMs =
      this.pipelineCount > 0 ? this.totalPipelineDurationMs / this.pipelineCount : 0;

    const buyRate =
      this.tokensDetected > 0 ? (this.tokensBought / this.tokensDetected) * 100 : 0;

    return {
      startedAt: this.startedAt,
      tokensDetected: this.tokensDetected,
      tokensBought: this.tokensBought,
      tokensRejected: this.tokensRejected,
      buyRate,
      gateStats: {
        cheapGates: cheapGatesArray,
        deepFilters: deepFiltersArray,
      },
      topRejectionReasons,
      avgPipelineDurationMs,
      totalPipelineDurationMs: this.totalPipelineDurationMs,
      recentTokens: this.recentTokens,
    };
  }

  /**
   * Reset all stats
   */
  reset(): void {
    this.startedAt = Date.now();
    this.tokensDetected = 0;
    this.tokensBought = 0;
    this.tokensRejected = 0;
    this.totalPipelineDurationMs = 0;
    this.pipelineCount = 0;
    this.recentTokens = [];
    this.rejectionReasons.clear();

    // Reset all gate counters
    for (const gate of CHEAP_GATES) {
      this.cheapGateStats.set(gate.name, { passed: 0, failed: 0 });
    }
    for (const filter of DEEP_FILTERS) {
      this.deepFilterStats.set(filter.name, { passed: 0, failed: 0 });
    }

    logger.info('[pipeline-stats] Stats reset');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

let pipelineStatsInstance: PipelineStats | null = null;

/**
 * Initialize the pipeline stats singleton
 */
export function initPipelineStats(): PipelineStats {
  if (!pipelineStatsInstance) {
    pipelineStatsInstance = new PipelineStats();
  }
  return pipelineStatsInstance;
}

/**
 * Get the pipeline stats singleton
 */
export function getPipelineStats(): PipelineStats | null {
  return pipelineStatsInstance;
}

/**
 * Reset pipeline stats (for dashboard button)
 */
export function resetPipelineStats(): void {
  if (pipelineStatsInstance) {
    pipelineStatsInstance.reset();
  }
}
