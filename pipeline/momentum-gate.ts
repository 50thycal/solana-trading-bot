/**
 * Momentum Gate Stage
 *
 * Stage 4 of the pipeline - validates buy momentum before purchase.
 * Uses retry-based polling to check if minimum buy transactions have occurred.
 *
 * Design:
 * - Wait INITIAL_DELAY_MS before first check (allow indexing)
 * - Fetch transactions from bonding curve address
 * - Count buy/sell transactions by parsing instruction discriminators
 * - If buys >= MIN_TOTAL_BUYS -> PASS
 * - If checks < MAX_CHECKS -> wait RECHECK_INTERVAL_MS and retry
 * - If checks >= MAX_CHECKS -> REJECT
 *
 * Failure handling:
 * - Any RPC error -> REJECT immediately (no retries)
 * - Log: mint, stage=MOMENTUM_GATE, error reason
 */

import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  PipelineContext,
  StageResult,
  MomentumGateData,
  PipelineStage,
  RejectionReasons,
} from './types';
import { PUMP_FUN_PROGRAM_ID } from '../helpers/pumpfun';
import { sleep, logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * pump.fun Buy instruction discriminator (first 8 bytes of sha256("global:buy"))
 */
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

/**
 * pump.fun Sell instruction discriminator (first 8 bytes of sha256("global:sell"))
 */
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface MomentumGateConfig {
  /** Enable/disable the momentum gate */
  enabled: boolean;

  /** Initial delay before first check (ms) */
  initialDelayMs: number;

  /** Minimum buy transactions required */
  minTotalBuys: number;

  /** Wait between recheck attempts (ms) */
  recheckIntervalMs: number;

  /** Maximum number of checks before rejection */
  maxChecks: number;
}

const DEFAULT_CONFIG: MomentumGateConfig = {
  enabled: true,
  initialDelayMs: 100,
  minTotalBuys: 10,
  recheckIntervalMs: 100,
  maxChecks: 5,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTION COUNTING
// ═══════════════════════════════════════════════════════════════════════════════

interface TransactionCounts {
  buyCount: number;
  sellCount: number;
}

/**
 * Fetch and count buy/sell transactions for a bonding curve
 *
 * @param connection - Solana connection
 * @param bondingCurve - Bonding curve address to check
 * @returns Transaction counts or throws on error
 */
async function fetchTransactionCounts(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<TransactionCounts> {
  // Fetch recent signatures for the bonding curve
  // Using limit=100 as a reasonable window for very recent transactions
  const signatures = await connection.getSignaturesForAddress(
    bondingCurve,
    { limit: 100 },
    'confirmed'
  );

  if (signatures.length === 0) {
    return { buyCount: 0, sellCount: 0 };
  }

  let buyCount = 0;
  let sellCount = 0;

  // Fetch transaction details to parse instruction data
  // Use getParsedTransactions for batch fetching
  const txSignatures = signatures.map((s) => s.signature);
  const transactions = await connection.getParsedTransactions(txSignatures, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  for (const tx of transactions) {
    if (!tx?.meta || tx.meta.err) {
      continue; // Skip failed transactions
    }

    // Check both outer and inner instructions for pump.fun instructions
    const allInstructions = [
      ...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions?.flatMap((inner) => inner.instructions) || []),
    ];

    for (const ix of allInstructions) {
      // Only check unparsed instructions with data
      if ('parsed' in ix || !('programId' in ix)) {
        continue;
      }

      // Check if this is a pump.fun instruction
      if (!ix.programId.equals(PUMP_FUN_PROGRAM_ID)) {
        continue;
      }

      // Get instruction data
      if (!('data' in ix) || typeof ix.data !== 'string') {
        continue;
      }

      // Decode base58 instruction data
      let dataBuffer: Buffer;
      try {
        dataBuffer = Buffer.from(bs58.decode(ix.data));
      } catch {
        continue;
      }

      if (dataBuffer.length < 8) {
        continue;
      }

      // Extract discriminator (first 8 bytes)
      const discriminator = dataBuffer.subarray(0, 8);

      // Check against known discriminators
      if (discriminator.equals(BUY_DISCRIMINATOR)) {
        buyCount++;
      } else if (discriminator.equals(SELL_DISCRIMINATOR)) {
        sellCount++;
      }
    }
  }

  return { buyCount, sellCount };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOMENTUM GATE STAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * MomentumGateStage - Validates buy momentum with retry-based polling
 *
 * Flow:
 * 1. Wait INITIAL_DELAY_MS
 * 2. Fetch transactions, count buys/sells
 * 3. If buys >= MIN_TOTAL_BUYS -> PASS
 * 4. If checks < MAX_CHECKS -> wait RECHECK_INTERVAL_MS, goto step 2
 * 5. If checks >= MAX_CHECKS -> REJECT
 */
export class MomentumGateStage implements PipelineStage<PipelineContext, MomentumGateData> {
  name = 'momentum-gate';

  private connection: Connection;
  private config: MomentumGateConfig;

  constructor(connection: Connection, config: Partial<MomentumGateConfig> = {}) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(context: PipelineContext): Promise<StageResult<MomentumGateData>> {
    const startTime = Date.now();
    const { detection } = context;
    const mintStr = detection.mint.toString();
    const bondingCurveStr = detection.bondingCurve.toString();
    const buf = context.logBuffer;

    // If disabled, pass through immediately
    if (!this.config.enabled) {
      if (buf) {
        buf.info('Momentum gate: SKIPPED (disabled)');
      } else {
        logger.debug(
          { stage: this.name, mint: mintStr },
          '[pipeline] Momentum gate disabled, passing through'
        );
      }
      return {
        pass: true,
        reason: 'Momentum gate disabled',
        stage: this.name,
        data: {
          buyCount: 0,
          sellCount: 0,
          checksPerformed: 0,
          totalWaitMs: 0,
          checkStartedAt: startTime,
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Step 1: Initial delay
    if (this.config.initialDelayMs > 0) {
      await sleep(this.config.initialDelayMs);
    }

    let checksPerformed = 0;
    let lastBuyCount = 0;
    let lastSellCount = 0;

    // Polling loop
    while (checksPerformed < this.config.maxChecks) {
      checksPerformed++;

      // Step 2: Fetch transactions
      let counts: TransactionCounts;
      try {
        counts = await fetchTransactionCounts(this.connection, detection.bondingCurve);
      } catch (error) {
        // RPC failure -> REJECT immediately (no retries)
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return this.reject(
          `${RejectionReasons.MOMENTUM_RPC_FETCH_FAILED}: ${errorMsg}`,
          startTime,
          {
            mint: mintStr,
            bondingCurve: bondingCurveStr,
            checksPerformed,
            error: errorMsg,
          },
          buf
        );
      }

      lastBuyCount = counts.buyCount;
      lastSellCount = counts.sellCount;

      logger.debug(
        {
          stage: this.name,
          mint: mintStr,
          check: checksPerformed,
          maxChecks: this.config.maxChecks,
          buyCount: counts.buyCount,
          sellCount: counts.sellCount,
          threshold: this.config.minTotalBuys,
        },
        '[momentum-gate] Check result'
      );

      // Step 3: Check threshold
      if (counts.buyCount >= this.config.minTotalBuys) {
        // PASS!
        const duration = Date.now() - startTime;

        if (buf) {
          buf.info(`Momentum gate: PASSED - ${counts.buyCount} buys (${duration}ms)`);
        } else {
          logger.info(
            {
              stage: this.name,
              mint: mintStr,
              buyCount: counts.buyCount,
              sellCount: counts.sellCount,
              threshold: this.config.minTotalBuys,
              checksPerformed,
              durationMs: duration,
            },
            '[pipeline] Momentum gate passed'
          );
        }

        return {
          pass: true,
          reason: `Momentum confirmed: ${counts.buyCount} buys >= ${this.config.minTotalBuys} threshold`,
          stage: this.name,
          data: {
            buyCount: counts.buyCount,
            sellCount: counts.sellCount,
            checksPerformed,
            totalWaitMs: duration,
            checkStartedAt: startTime,
          },
          durationMs: duration,
        };
      }

      // Step 4: Not enough buys - check if we can retry
      if (checksPerformed < this.config.maxChecks) {
        // Wait before next check
        await sleep(this.config.recheckIntervalMs);
      }
    }

    // Step 5: Max checks reached -> REJECT
    return this.reject(
      `${RejectionReasons.MOMENTUM_THRESHOLD_NOT_MET}: buys=${lastBuyCount}, threshold=${this.config.minTotalBuys}`,
      startTime,
      {
        mint: mintStr,
        bondingCurve: bondingCurveStr,
        buyCount: lastBuyCount,
        sellCount: lastSellCount,
        threshold: this.config.minTotalBuys,
        checksPerformed,
      },
      buf
    );
  }

  /**
   * Helper to create rejection result with consistent logging
   */
  private reject(
    reason: string,
    startTime: number,
    logData: Record<string, unknown> = {},
    logBuffer?: import('../helpers/token-log-buffer').TokenLogBuffer
  ): StageResult<MomentumGateData> {
    const duration = Date.now() - startTime;

    if (logBuffer) {
      logBuffer.info(`Momentum gate: REJECTED - ${reason} (${duration}ms)`);
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

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<MomentumGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): MomentumGateConfig {
    return { ...this.config };
  }
}
