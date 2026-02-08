/**
 * Deep Filters Stage
 *
 * Stage 3 of the pipeline - expensive checks that require RPC calls.
 * This stage is only reached if cheap gates pass.
 *
 * Includes:
 * - Bonding curve state fetch (1 RPC call)
 * - Graduation check
 * - Min/Max SOL filters
 * - Future: holder distribution, trading velocity, etc.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  PipelineContext,
  StageResult,
  DeepFiltersData,
  PipelineStage,
  RejectionReasons,
} from './types';
import { getBondingCurveState, BondingCurveState } from '../helpers/pumpfun';
import { getPumpFunFilters, PumpFunFilterContext } from '../filters';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface DeepFiltersConfig {
  /** Skip bonding curve check? (testing only) */
  skipBondingCurveCheck: boolean;

  /** Skip filter execution? (testing only) */
  skipFilters: boolean;
}

const DEFAULT_CONFIG: DeepFiltersConfig = {
  skipBondingCurveCheck: false,
  skipFilters: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEEP FILTERS STAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DeepFiltersStage - Expensive checks requiring RPC calls
 *
 * Order of checks:
 * 1. Fetch bonding curve state (1 RPC call)
 * 2. Check if graduated
 * 3. Run pump.fun filters (min/max SOL, scoring)
 */
export class DeepFiltersStage implements PipelineStage<PipelineContext, DeepFiltersData> {
  name = 'deep-filters';

  private connection: Connection;
  private config: DeepFiltersConfig;

  constructor(connection: Connection, config: Partial<DeepFiltersConfig> = {}) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(context: PipelineContext): Promise<StageResult<DeepFiltersData>> {
    const startTime = Date.now();
    const { detection } = context;
    const mintStr = detection.mint.toString();
    const bondingCurveStr = detection.bondingCurve.toString();
    const buf = context.logBuffer;

    // ═══════════════════════════════════════════════════════════════════════════
    // FETCH BONDING CURVE STATE
    // ═══════════════════════════════════════════════════════════════════════════
    let bondingCurveState: BondingCurveState | null = null;

    if (!this.config.skipBondingCurveCheck) {
      try {
        bondingCurveState = await getBondingCurveState(this.connection, detection.bondingCurve);

        if (!bondingCurveState) {
          return this.reject(
            RejectionReasons.CURVE_NOT_FOUND,
            startTime,
            { mint: mintStr, bondingCurve: bondingCurveStr },
            buf
          );
        }
      } catch (error) {
        return this.reject(
          `Failed to fetch bonding curve: ${error instanceof Error ? error.message : 'Unknown error'}`,
          startTime,
          { mint: mintStr, bondingCurve: bondingCurveStr },
          buf
        );
      }

      // ═══════════════════════════════════════════════════════════════════════════
      // GRADUATION CHECK
      // ═══════════════════════════════════════════════════════════════════════════
      if (bondingCurveState.complete) {
        return this.reject(
          RejectionReasons.ALREADY_GRADUATED,
          startTime,
          { mint: mintStr, bondingCurve: bondingCurveStr },
          buf
        );
      }
    } else {
      // Testing mode - create mock state
      const BN = require('bn.js');
      bondingCurveState = {
        virtualTokenReserves: new BN(1000000000),
        virtualSolReserves: new BN(30000000000),
        realTokenReserves: new BN(800000000),
        realSolReserves: new BN(10000000000),
        tokenTotalSupply: new BN(1000000000),
        complete: false,
        creator: detection.creator || PublicKey.default,
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RUN PUMP.FUN FILTERS
    // ═══════════════════════════════════════════════════════════════════════════
    let filterResults: DeepFiltersData['filterResults'];

    if (!this.config.skipFilters) {
      const pumpFunFilters = getPumpFunFilters();

      if (pumpFunFilters) {
        const filterContext: PumpFunFilterContext = {
          mint: detection.mint,
          bondingCurve: detection.bondingCurve,
          bondingCurveState,
          creator: detection.creator || undefined,
          name: detection.name,
          symbol: detection.symbol,
          detectedAt: detection.detectedAt,
        };

        const results = await pumpFunFilters.execute(filterContext);

        if (!results.allPassed) {
          return this.reject(
            `${RejectionReasons.FILTER_FAILED}: ${results.summary}`,
            startTime,
            {
              mint: mintStr,
              filters: results.filters.map((f) => ({
                name: f.filterName,
                passed: f.passed,
                reason: f.reason,
              })),
            },
            buf
          );
        }

        filterResults = {
          allPassed: results.allPassed,
          score: results.normalizedScore,
          summary: results.summary,
          details: results.filters.map((f) => ({
            name: f.filterName,
            passed: f.passed,
            reason: f.reason,
          })),
        };
      } else {
        // No filters configured - pass by default
        filterResults = {
          allPassed: true,
          score: 100,
          summary: 'No filters configured',
          details: [],
        };
      }
    } else {
      // Skip filters (testing mode)
      filterResults = {
        allPassed: true,
        score: 100,
        summary: 'Filters skipped (testing mode)',
        details: [],
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ALL CHECKS PASSED
    // ═══════════════════════════════════════════════════════════════════════════
    const duration = Date.now() - startTime;

    if (buf) {
      buf.info(`Deep filters: PASSED (${duration}ms)`);
    } else {
      logger.debug(
        {
          stage: this.name,
          mint: mintStr,
          durationMs: duration,
          score: filterResults.score,
          realSolReserves: bondingCurveState.realSolReserves.toString(),
          complete: bondingCurveState.complete,
        },
        '[pipeline] Deep filters passed'
      );
    }

    return {
      pass: true,
      reason: filterResults.summary,
      stage: this.name,
      data: {
        bondingCurveState,
        filterResults,
      },
      durationMs: duration,
    };
  }

  /**
   * Helper to create rejection result with consistent logging
   */
  private reject(
    reason: string,
    startTime: number,
    logData: Record<string, unknown> = {},
    logBuffer?: import('../helpers/token-log-buffer').TokenLogBuffer
  ): StageResult<DeepFiltersData> {
    const duration = Date.now() - startTime;

    if (logBuffer) {
      logBuffer.info(`Deep filters: REJECTED - ${reason} (${duration}ms)`);
    } else {
      logger.info(
        {
          stage: this.name,
          reason,
          durationMs: duration,
          ...logData,
        },
        `[pipeline] Rejected: ${reason}`
      );
    }

    return {
      pass: false,
      reason,
      stage: this.name,
      durationMs: duration,
    };
  }
}
