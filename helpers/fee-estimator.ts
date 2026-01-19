import { Connection } from '@solana/web3.js';
import { logger } from './logger';
import {
  PRIORITY_FEE_PERCENTILE,
  MIN_PRIORITY_FEE,
  MAX_PRIORITY_FEE,
  USE_DYNAMIC_FEE,
  COMPUTE_UNIT_PRICE,
} from './constants';

/**
 * Fee estimation result
 */
export interface FeeEstimate {
  priorityFee: number; // in microLamports
  source: 'dynamic' | 'static';
}

/**
 * Estimates the priority fee based on recent network activity.
 * Uses getRecentPrioritizationFees() to query recent fees and returns
 * the configured percentile value, bounded by min/max limits.
 *
 * @param connection - Solana connection instance
 * @returns Fee estimate with priority fee in microLamports
 */
export async function estimatePriorityFee(connection: Connection): Promise<FeeEstimate> {
  // If dynamic fees are disabled, return static fee
  if (!USE_DYNAMIC_FEE) {
    return {
      priorityFee: COMPUTE_UNIT_PRICE,
      source: 'static',
    };
  }

  try {
    // Get recent prioritization fees from the network
    // This returns fees from recent slots
    const recentFees = await connection.getRecentPrioritizationFees();

    if (!recentFees || recentFees.length === 0) {
      logger.debug('No recent prioritization fees available, using static fee');
      return {
        priorityFee: COMPUTE_UNIT_PRICE,
        source: 'static',
      };
    }

    // Extract fee values and filter out zeros
    const feeValues = recentFees
      .map((f) => f.prioritizationFee)
      .filter((fee) => fee > 0)
      .sort((a, b) => a - b);

    if (feeValues.length === 0) {
      logger.debug('All recent fees are zero, using minimum fee');
      return {
        priorityFee: MIN_PRIORITY_FEE,
        source: 'dynamic',
      };
    }

    // Calculate the percentile
    const percentileIndex = Math.floor((PRIORITY_FEE_PERCENTILE / 100) * feeValues.length);
    const clampedIndex = Math.min(percentileIndex, feeValues.length - 1);
    let estimatedFee = feeValues[clampedIndex];

    // Apply min/max bounds
    estimatedFee = Math.max(estimatedFee, MIN_PRIORITY_FEE);
    estimatedFee = Math.min(estimatedFee, MAX_PRIORITY_FEE);

    logger.debug(
      {
        samplesCount: feeValues.length,
        percentile: PRIORITY_FEE_PERCENTILE,
        minFee: Math.min(...feeValues),
        maxFee: Math.max(...feeValues),
        estimatedFee,
      },
      'Dynamic priority fee estimated'
    );

    return {
      priorityFee: estimatedFee,
      source: 'dynamic',
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to estimate dynamic priority fee, falling back to static');
    return {
      priorityFee: COMPUTE_UNIT_PRICE,
      source: 'static',
    };
  }
}

/**
 * Get priority fee for a transaction.
 * This is a convenience wrapper that handles errors gracefully.
 *
 * @param connection - Solana connection instance
 * @returns Priority fee in microLamports
 */
export async function getPriorityFee(connection: Connection): Promise<number> {
  const estimate = await estimatePriorityFee(connection);
  return estimate.priorityFee;
}
