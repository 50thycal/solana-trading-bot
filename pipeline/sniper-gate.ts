/**
 * Sniper Gate Stage
 *
 * Stage 4 of the pipeline (alternative to momentum gate) - classifies wallets
 * as sniper bots vs organic buyers, monitors for bot exits, and only passes
 * when bots have dumped and organic demand remains.
 *
 * Design:
 * - Wait initialDelayMs before first check (allow indexing)
 * - Fetch transactions from bonding curve address (same RPC as momentum gate)
 * - Classify wallets by slot delta from token creation:
 *     slotDelta <= sniperSlotThreshold -> sniper bot
 *     slotDelta >  sniperSlotThreshold -> organic buyer
 * - Track sniper sells (exits)
 * - PASS when:
 *     (botCount === 0 AND organicCount >= minOrganicBuyers)
 *     OR (botExitPercent >= minBotExitPercent AND organicCount >= minOrganicBuyers)
 * - If logOnly === true -> always pass (data collection mode)
 * - If maxChecks reached -> REJECT
 *
 * Failure handling:
 * - Any RPC error -> REJECT immediately (no retries)
 * - Log: mint, stage=SNIPER_GATE, decision metrics on every poll
 */

import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  PipelineContext,
  StageResult,
  SniperGateData,
  SniperGateCheckResult,
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

export interface SniperGateConfig {
  /** Enable/disable the sniper gate (default: false) */
  enabled: boolean;

  /** Initial delay before first check in ms (default: 500) */
  initialDelayMs: number;

  /** Wait between recheck polls in ms (default: 1000) */
  recheckIntervalMs: number;

  /**
   * Maximum polls before timeout rejection (default: 10).
   * Each poll issues 2 heavy RPC calls (getSignaturesForAddress + getParsedTransactions
   * for up to 100 transactions). Keep this value conservative to avoid exhausting
   * RPC rate limits under concurrent token processing.
   */
  maxChecks: number;

  /** Slots 0..N after token creation = sniper bot (default: 3) */
  sniperSlotThreshold: number;

  /** % of bot wallets that must have sold before we buy (default: 50) */
  minBotExitPercent: number;

  /** Minimum unique organic buyer wallets required (default: 3) */
  minOrganicBuyers: number;

  /** Log metrics but always pass - safe data collection mode (default: false) */
  logOnly: boolean;
}

const DEFAULT_CONFIG: SniperGateConfig = {
  enabled: false,
  initialDelayMs: 500,
  recheckIntervalMs: 1000,
  maxChecks: 10,
  sniperSlotThreshold: 3,
  minBotExitPercent: 50,
  minOrganicBuyers: 3,
  logOnly: false,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSACTION ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Per-poll wallet state tracking
 */
interface WalletAnalysis {
  /** Wallets that bought early (snipers): wallet -> 'bought' | 'exited' */
  sniperWallets: Map<string, 'bought' | 'exited'>;
  /** Wallets that bought later (organic) */
  organicWallets: Set<string>;
  /** All wallets that bought */
  allBuyWallets: Set<string>;
  /** Total buy transactions */
  totalBuys: number;
  /** Total sell transactions */
  totalSells: number;
}

/**
 * Fetch all transactions for a bonding curve and classify wallets.
 *
 * Uses getSignaturesForAddress + getParsedTransactions — same RPC pattern
 * as momentum gate. New: per-transaction slot comparison against creationSlot
 * to determine sniper vs organic classification.
 *
 * @param connection - Solana RPC connection
 * @param bondingCurve - Bonding curve address
 * @param creationSlot - Token creation slot (from detection event)
 * @param sniperSlotThreshold - Max slot delta to classify as sniper
 */
async function fetchAndAnalyzeTransactions(
  connection: Connection,
  bondingCurve: PublicKey,
  creationSlot: number,
  sniperSlotThreshold: number,
): Promise<WalletAnalysis> {
  const sniperWallets = new Map<string, 'bought' | 'exited'>();
  const organicWallets = new Set<string>();
  const allBuyWallets = new Set<string>();
  let totalBuys = 0;
  let totalSells = 0;

  // Step 1: Fetch recent signatures
  const signatures = await connection.getSignaturesForAddress(
    bondingCurve,
    { limit: 100 },
    'confirmed',
  );

  if (signatures.length === 0) {
    return { sniperWallets, organicWallets, allBuyWallets, totalBuys, totalSells };
  }

  // Build a slot lookup map: signature -> slot
  const slotBySignature = new Map<string, number>();
  for (const sigInfo of signatures) {
    if (sigInfo.slot !== undefined) {
      slotBySignature.set(sigInfo.signature, sigInfo.slot);
    }
  }

  // Step 2: Fetch parsed transaction details (batch)
  // NOTE: getSignaturesForAddress returns newest-first; we reverse so we process
  // oldest-first, ensuring early buys are classified before their subsequent sells.
  const txSignaturesNewestFirst = signatures.map((s) => s.signature);
  const transactionsNewestFirst = await connection.getParsedTransactions(txSignaturesNewestFirst, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });

  // Reverse both arrays to process oldest transaction first
  const txSignatures = [...txSignaturesNewestFirst].reverse();
  const transactions = [...transactionsNewestFirst].reverse();

  // Step 3: Analyze each transaction
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (!tx?.meta || tx.meta.err) {
      continue; // Skip failed transactions
    }

    // Get the slot for this transaction from the signatures response
    const txSlot = slotBySignature.get(txSignatures[i]) ?? tx.slot;

    // Fee payer / signer is the first account key
    const wallet = tx.transaction.message.accountKeys[0]?.pubkey?.toString();
    if (!wallet) {
      continue;
    }

    // Check both outer and inner instructions for pump.fun instructions
    const allInstructions = [
      ...tx.transaction.message.instructions,
      ...(tx.meta.innerInstructions?.flatMap((inner) => inner.instructions) || []),
    ];

    let isBuy = false;
    let isSell = false;

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

      if (discriminator.equals(BUY_DISCRIMINATOR)) {
        isBuy = true;
      } else if (discriminator.equals(SELL_DISCRIMINATOR)) {
        isSell = true;
      }
    }

    // Classify based on action type
    if (isBuy) {
      totalBuys++;
      allBuyWallets.add(wallet);

      const slotDelta = txSlot - creationSlot;
      if (slotDelta <= sniperSlotThreshold) {
        // Early buyer = sniper bot (only set if not already tracked)
        if (!sniperWallets.has(wallet)) {
          sniperWallets.set(wallet, 'bought');
        }
      } else {
        // Later buyer = organic — but only if the wallet was not already
        // classified as a sniper (prevents double-counting across both sets)
        if (!sniperWallets.has(wallet)) {
          organicWallets.add(wallet);
        }
      }
    }

    if (isSell) {
      totalSells++;
      // If this seller was a sniper, mark them as exited
      if (sniperWallets.has(wallet)) {
        sniperWallets.set(wallet, 'exited');
      }
    }
  }

  return { sniperWallets, organicWallets, allBuyWallets, totalBuys, totalSells };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SNIPER GATE STAGE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SniperGateStage - Validates token safety by monitoring sniper bot exits
 *
 * Flow:
 * 1. If disabled -> pass through (same pattern as momentum gate)
 * 2. Wait initialDelayMs
 * 3. Loop up to maxChecks:
 *    a. Fetch and analyze transactions
 *    b. Calculate metrics (bot count, exit %, organic count)
 *    c. Log metrics (always, for data analysis)
 *    d. Check pass conditions
 *    e. If not passed -> wait recheckIntervalMs, retry
 * 4. maxChecks reached -> REJECT with appropriate reason
 * 5. RPC error at any point -> REJECT immediately
 */
export class SniperGateStage implements PipelineStage<PipelineContext, SniperGateData> {
  name = 'sniper-gate';

  private connection: Connection;
  private config: SniperGateConfig;

  constructor(connection: Connection, config: Partial<SniperGateConfig> = {}) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(context: PipelineContext): Promise<StageResult<SniperGateData>> {
    const startTime = Date.now();
    const { detection } = context;
    const mintStr = detection.mint.toString();
    const bondingCurveStr = detection.bondingCurve.toString();
    const buf = context.logBuffer;
    const creationSlot = detection.slot;

    // If disabled, pass through immediately
    if (!this.config.enabled) {
      if (buf) {
        buf.info('Sniper gate: SKIPPED (disabled)');
      } else {
        logger.debug(
          { stage: this.name, mint: mintStr },
          '[pipeline] Sniper gate disabled, passing through',
        );
      }
      return {
        pass: true,
        reason: 'Sniper gate disabled',
        stage: this.name,
        data: {
          sniperWalletCount: 0,
          sniperExitCount: 0,
          sniperExitPercent: 0,
          organicBuyerCount: 0,
          totalBuys: 0,
          totalSells: 0,
          uniqueBuyWalletCount: 0,
          checksPerformed: 0,
          totalWaitMs: 0,
          checkStartedAt: startTime,
          sniperWallets: [],
          organicWallets: [],
          logOnly: false,
          checkHistory: [],
        },
        durationMs: Date.now() - startTime,
      };
    }

    // Step 1: Initial delay (allow transactions to be indexed)
    if (this.config.initialDelayMs > 0) {
      await sleep(this.config.initialDelayMs);
    }

    let checksPerformed = 0;
    let lastAnalysis: WalletAnalysis | null = null;
    const checkHistory: SniperGateCheckResult[] = [];

    // Polling loop
    while (checksPerformed < this.config.maxChecks) {
      checksPerformed++;

      // Fetch and analyze transactions
      let analysis: WalletAnalysis;
      try {
        analysis = await fetchAndAnalyzeTransactions(
          this.connection,
          detection.bondingCurve,
          creationSlot,
          this.config.sniperSlotThreshold,
        );
      } catch (error) {
        // RPC failure -> REJECT immediately (no retries)
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        return this.reject(
          `${RejectionReasons.SNIPER_GATE_RPC_FAILED}: ${errorMsg}`,
          startTime,
          {
            mint: mintStr,
            bondingCurve: bondingCurveStr,
            checksPerformed,
            error: errorMsg,
          },
          buf,
          checkHistory,
        );
      }

      lastAnalysis = analysis;

      // Calculate metrics
      const botCount = analysis.sniperWallets.size;
      const botExitCount = [...analysis.sniperWallets.values()].filter(
        (v) => v === 'exited',
      ).length;
      const botExitPercent = botCount > 0 ? (botExitCount / botCount) * 100 : 0;
      const organicCount = analysis.organicWallets.size;
      const uniqueBuyWalletCount = analysis.allBuyWallets.size;

      // Log current state (always, for data analysis)
      logger.debug(
        {
          stage: this.name,
          mint: mintStr,
          check: checksPerformed,
          maxChecks: this.config.maxChecks,
          botCount,
          botExitCount,
          botExitPercent: botExitPercent.toFixed(1) + '%',
          organicCount,
          totalBuys: analysis.totalBuys,
          totalSells: analysis.totalSells,
          minBotExitPercent: this.config.minBotExitPercent,
          minOrganicBuyers: this.config.minOrganicBuyers,
          logOnly: this.config.logOnly,
        },
        '[sniper-gate] Check result',
      );

      // Determine if pass conditions are met
      const hasEnoughOrganic = organicCount >= this.config.minOrganicBuyers;
      const botsCleared =
        botCount === 0 || botExitPercent >= this.config.minBotExitPercent;
      const passConditionsMet = botsCleared && hasEnoughOrganic;

      // Record this check in history for pattern analysis
      checkHistory.push({
        checkNumber: checksPerformed,
        checkedAt: Date.now(),
        botCount,
        botExitCount,
        botExitPercent,
        organicCount,
        totalBuys: analysis.totalBuys,
        totalSells: analysis.totalSells,
        uniqueBuyWalletCount,
        passConditionsMet,
        sniperWallets: [...analysis.sniperWallets.keys()],
        organicWallets: [...analysis.organicWallets],
      });

      // In log-only mode we run the full loop — do NOT short-circuit here.
      // The pass happens after maxChecks are exhausted (below the while loop).
      if (passConditionsMet) {
        const duration = Date.now() - startTime;
        const passReason = botCount === 0
          ? `No bots detected, ${organicCount} organic buyers`
          : `Bots cleared: ${botExitPercent.toFixed(1)}% exited, ${organicCount} organic buyers`;

        if (buf) {
          buf.info(
            `Sniper gate: PASSED - ${passReason} (${duration}ms)`,
          );
        } else {
          logger.info(
            {
              stage: this.name,
              mint: mintStr,
              botCount,
              botExitCount,
              botExitPercent: botExitPercent.toFixed(1) + '%',
              organicCount,
              totalBuys: analysis.totalBuys,
              totalSells: analysis.totalSells,
              checksPerformed,
              logOnly: this.config.logOnly,
              durationMs: duration,
            },
            '[pipeline] Sniper gate passed',
          );
        }

        return {
          pass: true,
          reason: passReason,
          stage: this.name,
          data: {
            sniperWalletCount: botCount,
            sniperExitCount: botExitCount,
            sniperExitPercent: botExitPercent,
            organicBuyerCount: organicCount,
            totalBuys: analysis.totalBuys,
            totalSells: analysis.totalSells,
            uniqueBuyWalletCount,
            checksPerformed,
            totalWaitMs: duration,
            checkStartedAt: startTime,
            sniperWallets: [...analysis.sniperWallets.keys()],
            organicWallets: [...analysis.organicWallets],
            logOnly: this.config.logOnly,
            checkHistory,
          },
          durationMs: duration,
        };
      }

      // Not passed - wait before next check (if we have checks remaining)
      if (checksPerformed < this.config.maxChecks) {
        await sleep(this.config.recheckIntervalMs);
      }
    }

    // Max checks reached
    const botCount = lastAnalysis?.sniperWallets.size ?? 0;
    const botExitCount = lastAnalysis
      ? [...lastAnalysis.sniperWallets.values()].filter((v) => v === 'exited').length
      : 0;
    const botExitPercent = botCount > 0 ? (botExitCount / botCount) * 100 : 0;
    const organicCount = lastAnalysis?.organicWallets.size ?? 0;
    const uniqueBuyWalletCount = lastAnalysis?.allBuyWallets.size ?? 0;

    // In log-only mode: run the full loop for data collection, then pass.
    // Conditions were never met naturally, but we still forward all check data.
    if (this.config.logOnly) {
      const duration = Date.now() - startTime;
      const passReason = `Log-only mode (${checksPerformed} checks complete): bots=${botCount}, exits=${botExitPercent.toFixed(1)}%, organic=${organicCount}`;

      if (buf) {
        buf.info(`Sniper gate: PASSED (log-only) - ${passReason} (${duration}ms)`);
      } else {
        logger.info(
          {
            stage: this.name,
            mint: mintStr,
            botCount,
            botExitCount,
            botExitPercent: botExitPercent.toFixed(1) + '%',
            organicCount,
            checksPerformed,
            logOnly: true,
            durationMs: duration,
          },
          '[pipeline] Sniper gate passed (log-only, all checks complete)',
        );
      }

      return {
        pass: true,
        reason: passReason,
        stage: this.name,
        data: {
          sniperWalletCount: botCount,
          sniperExitCount: botExitCount,
          sniperExitPercent: botExitPercent,
          organicBuyerCount: organicCount,
          totalBuys: lastAnalysis?.totalBuys ?? 0,
          totalSells: lastAnalysis?.totalSells ?? 0,
          uniqueBuyWalletCount,
          checksPerformed,
          totalWaitMs: duration,
          checkStartedAt: startTime,
          sniperWallets: lastAnalysis ? [...lastAnalysis.sniperWallets.keys()] : [],
          organicWallets: lastAnalysis ? [...lastAnalysis.organicWallets] : [],
          logOnly: true,
          checkHistory,
        },
        durationMs: duration,
      };
    }

    // Determine primary rejection reason:
    // TIMEOUT  = bots are still present and haven't met the exit threshold
    // LOW_ORGANIC = bots cleared (or none) but organic count still insufficient
    const botsStillPresent = botCount > 0 && botExitPercent < this.config.minBotExitPercent;
    const rejectReason = botsStillPresent
      ? RejectionReasons.SNIPER_GATE_TIMEOUT
      : RejectionReasons.SNIPER_GATE_LOW_ORGANIC;

    return this.reject(
      `${rejectReason}: bots=${botCount}, exits=${botExitPercent.toFixed(1)}%, organic=${organicCount}/${this.config.minOrganicBuyers}`,
      startTime,
      {
        mint: mintStr,
        bondingCurve: bondingCurveStr,
        botCount,
        botExitCount,
        botExitPercent: botExitPercent.toFixed(1) + '%',
        organicCount,
        minOrganicBuyers: this.config.minOrganicBuyers,
        minBotExitPercent: this.config.minBotExitPercent,
        checksPerformed,
      },
      buf,
      checkHistory,
    );
  }

  /**
   * Helper to create rejection result with consistent logging.
   * checkHistory is included in data so callers can persist observations even
   * for rejected tokens.
   */
  private reject(
    reason: string,
    startTime: number,
    logData: Record<string, unknown> = {},
    logBuffer?: import('../helpers/token-log-buffer').TokenLogBuffer,
    checkHistory: SniperGateCheckResult[] = [],
  ): StageResult<SniperGateData> {
    const duration = Date.now() - startTime;

    if (logBuffer) {
      logBuffer.info(`Sniper gate: REJECTED - ${reason} (${duration}ms)`);
    } else {
      logger.info(
        {
          stage: this.name,
          reason,
          durationMs: duration,
          ...logData,
        },
        `[pipeline] Rejected: ${reason}`,
      );
    }

    const lastCheck = checkHistory[checkHistory.length - 1];
    return {
      pass: false,
      reason,
      stage: this.name,
      durationMs: duration,
      data: {
        sniperWalletCount: lastCheck?.botCount ?? 0,
        sniperExitCount: lastCheck?.botExitCount ?? 0,
        sniperExitPercent: lastCheck?.botExitPercent ?? 0,
        organicBuyerCount: lastCheck?.organicCount ?? 0,
        totalBuys: lastCheck?.totalBuys ?? 0,
        totalSells: lastCheck?.totalSells ?? 0,
        uniqueBuyWalletCount: lastCheck?.uniqueBuyWalletCount ?? 0,
        checksPerformed: checkHistory.length,
        totalWaitMs: duration,
        checkStartedAt: startTime,
        sniperWallets: lastCheck?.sniperWallets ?? [],
        organicWallets: lastCheck?.organicWallets ?? [],
        logOnly: this.config.logOnly,
        checkHistory,
      },
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<SniperGateConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): SniperGateConfig {
    return { ...this.config };
  }
}
