/**
 * Smoke Test Mode
 *
 * Runs a production-like single-trade cycle on mainnet:
 *   CONFIG_CHECK -> RPC_CHECK -> BOOT_SYSTEMS -> LISTEN_AND_PIPELINE
 *   -> BUY_EXECUTE -> BUY_VERIFY -> POSITION_MONITOR -> SELL_EXECUTE
 *   -> SELL_VERIFY -> REPORT
 *
 * Flow:
 *   1. Boot up like production (listener, pipeline, position monitor)
 *   2. Listen for tokens, pass each through the full pipeline
 *   3. First token that passes all pipeline stages -> attempt buy
 *   4. If buy fails: record why, continue listening for next passing token
 *   5. If buy succeeds: monitor position with real SL/TP/max hold
 *   6. When exit trigger fires -> sell (retry up to 3 times)
 *   7. After sell -> print report, graceful shutdown
 *
 * Set BOT_MODE=smoke to trigger this instead of the normal bot.
 * Set SMOKE_TEST_RUNS=N to run N sequential test cycles (default: 1).
 * Uses real mainnet transactions with the configured QUOTE_AMOUNT.
 * Exits with code 0 (pass) or 1 (fail) when done.
 *
 * @module smoke-test
 */

import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  RPC_BACKUP_ENDPOINTS,
  LOG_LEVEL,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  TAKE_PROFIT,
  STOP_LOSS,
  MAX_HOLD_DURATION_MS,
  SMOKE_TEST_TIMEOUT_MS,
  SMOKE_TEST_RUNS,
  PUMPFUN_MIN_SOL_IN_CURVE,
  PUMPFUN_MAX_SOL_IN_CURVE,
  PUMPFUN_ENABLE_MIN_SOL_FILTER,
  PUMPFUN_ENABLE_MAX_SOL_FILTER,
  PUMPFUN_MIN_SCORE_REQUIRED,
  PUMPFUN_DETECTION_COOLDOWN_MS,
  ONE_TOKEN_AT_A_TIME,
  TRANSACTION_EXECUTOR,
  AUTO_BUY_DELAY,
  MAX_BUY_RETRIES,
  AUTO_SELL,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  PRICE_CHECK_INTERVAL,
  PRICE_CHECK_DURATION,
  MAX_TOTAL_EXPOSURE_SOL,
  MAX_TRADES_PER_HOUR,
  MIN_WALLET_BUFFER_SOL,
  SIMULATE_TRANSACTION,
  USE_DYNAMIC_FEE,
  PRIORITY_FEE_PERCENTILE,
  MIN_PRIORITY_FEE,
  MAX_PRIORITY_FEE,
  USE_FALLBACK_EXECUTOR,
  MAX_TOKEN_AGE_SECONDS,
  SNIPER_GATE_ENABLED,
  SNIPER_GATE_INITIAL_DELAY_MS,
  SNIPER_GATE_RECHECK_INTERVAL_MS,
  SNIPER_GATE_MAX_CHECKS,
  SNIPER_GATE_SNIPER_SLOT_THRESHOLD,
  SNIPER_GATE_MIN_BOT_EXIT_PERCENT,
  SNIPER_GATE_MIN_ORGANIC_BUYERS,
  SNIPER_GATE_LOG_ONLY,
  TRAILING_STOP_ENABLED,
  TRAILING_STOP_ACTIVATION_PERCENT,
  TRAILING_STOP_DISTANCE_PERCENT,
  HARD_TAKE_PROFIT_PERCENT,
  COST_ADJUSTED_EXITS,
  MAX_PRICE_DRIFT_PERCENT,
  CUSTOM_FEE,
  JITO_BUNDLE_TIMEOUT,
  JITO_BUNDLE_POLL_INTERVAL,
  STABLE_GATE_ENABLED,
  STABLE_GATE_LOG_ONLY,
  STABLE_GATE_MAX_RETRIES,
  STABLE_GATE_RETRY_DELAY_SECONDS,
  STABLE_GATE_PRICE_SNAPSHOTS,
  STABLE_GATE_SNAPSHOT_INTERVAL_MS,
  STABLE_GATE_MAX_PRICE_DROP_PERCENT,
  STABLE_GATE_MIN_SOL_IN_CURVE,
  STABLE_GATE_MAX_SELL_RATIO,
  SNIPER_GATE_SIGNATURE_LIMIT,
} from './helpers';
import {
  buyOnPumpFun,
  sellOnPumpFun,
  decodeBondingCurveState,
  calculateSellSolOut,
} from './helpers/pumpfun';
import BN from 'bn.js';
import { initTradeAuditManager } from './helpers/trade-audit';
import { initRpcManager } from './helpers/rpc-manager';
import { getConfig, getRedactedConfigSnapshot } from './helpers/config-validator';
import { TransactionExecutor } from './transactions/transaction-executor.interface';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { DefaultTransactionExecutor } from './transactions/default-transaction-executor';
import { FallbackTransactionExecutor } from './transactions/fallback-transaction-executor';
import {
  PumpFunListener,
  initPumpFunListener,
} from './listeners/pumpfun-listener';
import {
  initPipeline,
  getPipeline,
  DetectionEvent,
  initPipelineStats,
  getPipelineStats,
  resetPipelineStats,
} from './pipeline';
import {
  initPumpFunFilters,
} from './filters';
import {
  initPumpFunPositionMonitor,
  PumpFunTriggerEvent,
} from './risk/pumpfun-position-monitor';
import { DetectedToken } from './types';
import { sleep } from './helpers/promises';
import { initStateStore, getStateStore } from './persistence';
import { getPnlTracker } from './risk';
import fs from 'fs';
import path from 'path';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

interface SmokeTestStep {
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  details: string;
  durationMs: number;
}

interface BuyFailureRecord {
  tokenSymbol: string;
  tokenMint: string;
  reason: string;
  timestamp: number;
}

export interface FeeBreakdown {
  // ── Wallet-level overhead (measured from balance deltas) ──
  /** Buy-side overhead: actualSolSpent - tradeAmount (gas + priority fee + Jito tip + ATA rent) */
  buyOverhead: number;
  /** Sell-side overhead: wallet-level residual on the sell side (gas + priority fee + Jito tip) */
  sellOverhead: number;
  /** Sum of buy + sell overhead (measured from wallet delta, does NOT include protocol fees) */
  walletOverhead: number;

  // ── Protocol fees (estimated — embedded in bonding curve price) ──
  /** Estimated pump.fun buy fee (~1% of trade amount, deducted from tokens received) */
  estimatedPumpBuyFee: number;
  /** Estimated pump.fun sell fee (~1.25% of sell proceeds, deducted from SOL received) */
  estimatedPumpSellFee: number;

  // ── Jito tip (from config — shown for reference) ──
  /** Configured Jito/Warp tip per transaction (from CUSTOM_FEE env var).
   *  NOTE: pump.fun buy/sell currently use sendRawTransaction directly,
   *  bypassing the Jito/Warp executor, so this tip is NOT actually sent. */
  jitoTipPerTx: number;

  // ── All-in totals ──
  /** Total friction = walletOverhead + estimatedPumpBuyFee + estimatedPumpSellFee */
  totalOverhead: number;
  /** Whether the bundle executor (Jito/Warp) is active for this run */
  bundleExecutorActive: boolean;
  /** Which executor is configured: 'jito', 'warp', or 'default' */
  executorType: string;
  /** Which executor actually handled the buy tx (e.g. 'jito' or 'default' if fallback kicked in) */
  buyExecutorUsed?: string;
  /** Which executor actually handled the sell tx */
  sellExecutorUsed?: string;
}

export interface SmokeTestReport {
  startedAt: number;
  completedAt: number;
  totalDurationMs: number;
  steps: SmokeTestStep[];
  overallResult: 'PASS' | 'FAIL';
  walletBalanceBefore: number;
  walletBalanceAfter: number;
  netCostSol: number;
  passedCount: number;
  failedCount: number;
  totalSteps: number;
  exitTrigger?: string;
  buyFailures: BuyFailureRecord[];
  tokensEvaluated: number;
  tokensPipelinePassed: number;
  actualSolSpentOnBuy?: number;
  buyOverheadSol?: number;
  /** Token that was successfully bought and sold during this run */
  tradedToken?: {
    name: string;
    symbol: string;
    /** Full on-chain mint address (contract address) */
    mint: string;
    /** Bonding curve program account */
    bondingCurve: string;
  };
  /** Wall-clock time (ms) when buy transaction was confirmed */
  buyTimestamp?: number;
  /** Wall-clock time (ms) when sell transaction was confirmed */
  sellTimestamp?: number;
  /** Buy transaction signature */
  buySignature?: string;
  /** Sell transaction signature */
  sellSignature?: string;
  /** SOL received from the sell transaction */
  sellSolReceived?: number;
  /** Trade return ignoring overhead: sellSolReceived - tradeAmount */
  tradeReturnSol?: number;
  /** Itemized fee breakdown (overhead costs + estimated protocol fees) */
  feeBreakdown?: FeeBreakdown;
  /** P&L as percentage of total cost (includes all overhead) */
  pnlPercentWithOverhead?: number;
  /** P&L as percentage of trade amount only (ignores gas/tips overhead) */
  pnlPercentWithoutOverhead?: number;
  /** Slippage analysis */
  slippage?: {
    buySlippagePercent?: number;   // Token slippage on buy (negative = got fewer tokens)
    sellSlippagePercent?: number;  // SOL slippage on sell (negative = got less SOL)
    buyExpectedTokens?: number;
    buyActualTokens?: number;
    sellExpectedSol?: number;
    sellActualSol?: number;
    /** Estimated SOL cost of buy slippage */
    buySlippageCostSol?: number;
    /** Estimated SOL cost of sell slippage */
    sellSlippageCostSol?: number;
  };
  /** Price snapshots during position hold (for sparkline chart) */
  priceHistory?: Array<{ timestamp: number; valueSol: number; pnlPercent: number }>;
  /** Highest PnL % reached during the hold */
  highWaterMarkPercent?: number;
  /** Hold duration in ms (buyTimestamp to sellTimestamp) */
  holdDurationMs?: number;
  /** Trade efficiency score 0-100 (composite of overhead ratio, slippage, and return) */
  tradeEfficiencyScore?: number;
  /** Snapshot of environment variables used for this run (for cross-run analytics) */
  envSnapshot?: Record<string, string | number | boolean>;
  /** Which run number this is when using SMOKE_TEST_RUNS > 1 (1-indexed) */
  runNumber?: number;
  /** Total number of runs configured for this session */
  totalRuns?: number;
  /** Pipeline gate rejection counts (gate name → count of tokens rejected at that gate) */
  gateRejections?: Record<string, number>;
  /** Detailed pipeline rejection records: array of { stage, reason } for per-component analytics */
  pipelineRejections?: Array<{ stage: string; reason: string }>;
  /** Per-component gate stats snapshot from PipelineStats (pass/fail per gate component) */
  gateStats?: {
    cheapGates: Array<{ name: string; displayName: string; passed: number; failed: number; totalChecked: number }>;
    deepFilters: Array<{ name: string; displayName: string; passed: number; failed: number; totalChecked: number }>;
    sniperGate: Array<{ name: string; displayName: string; passed: number; failed: number; totalChecked: number }>;
    researchScoreGate: Array<{ name: string; displayName: string; passed: number; failed: number; totalChecked: number }>;
    stableGate: Array<{ name: string; displayName: string; passed: number; failed: number; totalChecked: number }>;
  };
  /** Pipeline data for the specific token that was bought */
  boughtTokenPipelineData?: {
    /** Research bot score (0-100) */
    researchScore?: number;
    /** Research signal classification */
    researchSignal?: string;
    /** Deep filter composite score */
    compositeScore?: number;
    /** Time spent in each pipeline gate (ms) */
    cheapGateDurationMs?: number;
    deepFilterDurationMs?: number;
    sniperGateDurationMs?: number;
    researchGateDurationMs?: number;
    stableGateDurationMs?: number;
    /** Total time in pipeline for this token */
    totalPipelineDurationMs?: number;
  };
  /** Run-wide pipeline timing statistics */
  runPipelineStats?: {
    /** Average time a token spent in the pipeline (ms) */
    avgPipelineDurationMs: number;
    /** Max time any token spent in the pipeline (ms) */
    maxPipelineDurationMs: number;
    /** Min time any token spent in the pipeline (ms) */
    minPipelineDurationMs: number;
    /** Average research score across all tokens that reached the research gate */
    avgResearchScore?: number;
    /** Highest research score seen in this run */
    maxResearchScore?: number;
    /** Lowest research score seen in this run */
    minResearchScore?: number;
    /** Number of tokens that were scored by the research gate */
    researchScoreCount?: number;
  };
}

// Shared state for the report endpoint
let lastReport: SmokeTestReport | null = null;

/** Live progress state so the dashboard can show what's happening mid-test */
interface SmokeTestProgress {
  running: boolean;
  startedAt: number;
  currentStep: string;
  walletBalanceBefore: number;
  tokensEvaluated: number;
  tokensPipelinePassed: number;
  buyFailures: number;
  steps: SmokeTestStep[];
  runNumber: number;
  totalRuns: number;
}

let liveProgress: SmokeTestProgress | null = null;

/** Current run context for multi-run mode (used by buildReport) */
let currentRunNumber = 1;
let currentTotalRuns = 1;

/** File path for persisting smoke test reports across restarts */
function getReportsFilePath(): string {
  try {
    const config = getConfig();
    return path.join(config.dataDir, 'smoke-reports.json');
  } catch {
    return path.join(process.cwd(), 'data', 'smoke-reports.json');
  }
}

export function getSmokeTestReport(): SmokeTestReport | null {
  return lastReport;
}

/**
 * Get live progress of a currently running smoke test (null if not running)
 */
export function getSmokeTestProgress(): SmokeTestProgress | null {
  return liveProgress;
}

/**
 * In-memory cache for persisted smoke test reports.
 * Avoids blocking the event loop with fs.readFileSync on every dashboard request.
 */
let reportsCache: SmokeTestReport[] | null = null;

/**
 * Get all persisted smoke test reports (current + historical).
 * Reads from disk only on first call; subsequent calls serve from memory.
 * Cache is invalidated when persistReport() writes new data.
 */
export function getAllSmokeTestReports(): SmokeTestReport[] {
  if (reportsCache !== null) return reportsCache;
  try {
    const filePath = getReportsFilePath();
    if (!fs.existsSync(filePath)) {
      reportsCache = [];
      return reportsCache;
    }
    const data = fs.readFileSync(filePath, 'utf-8');
    reportsCache = JSON.parse(data);
    return reportsCache!;
  } catch {
    reportsCache = [];
    return reportsCache;
  }
}

/**
 * Persist a smoke test report to the reports file
 */
function persistReport(report: SmokeTestReport): void {
  try {
    const filePath = getReportsFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let reports: SmokeTestReport[] = [];
    if (fs.existsSync(filePath)) {
      try {
        reports = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch { /* start fresh */ }
    }

    reports.push(report);

    // Keep last 50 reports
    if (reports.length > 50) {
      reports = reports.slice(-50);
    }

    fs.writeFileSync(filePath, JSON.stringify(reports, null, 2));

    // Update in-memory cache so dashboard reads don't hit disk
    reportsCache = reports;
  } catch (error) {
    logger.warn({ error }, '[smoke-test] Failed to persist smoke test report');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// STEP RUNNER
// ════════════════════════════════════════════════════════════════════════════

async function runStep(
  step: SmokeTestStep,
  fn: () => Promise<string>,
): Promise<boolean> {
  step.status = 'running';
  const start = Date.now();

  try {
    const details = await fn();
    step.status = 'passed';
    step.details = details;
    step.durationMs = Date.now() - start;
    logger.info(`[smoke-test] [PASS] ${step.name} (${step.durationMs}ms) - ${details}`);
    return true;
  } catch (error) {
    step.status = 'failed';
    step.details = error instanceof Error ? error.message : String(error);
    step.durationMs = Date.now() - start;
    logger.error(`[smoke-test] [FAIL] ${step.name} (${step.durationMs}ms) - ${step.details}`);
    return false;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN SMOKE TEST
// ════════════════════════════════════════════════════════════════════════════

/**
 * Runs multiple sequential smoke tests based on SMOKE_TEST_RUNS config.
 * Each run is independent - tracked and persisted as its own report.
 * Returns the final run's report for backward compatibility.
 */
export async function runSmokeTest(): Promise<SmokeTestReport> {
  const totalRuns = SMOKE_TEST_RUNS;

  if (totalRuns <= 1) {
    return runSingleSmokeTest(1, 1);
  }

  logger.info('');
  logger.info('════════════════════════════════════════════════════════════');
  logger.info(`  SMOKE TEST MULTI-RUN: ${totalRuns} sequential runs configured`);
  logger.info('════════════════════════════════════════════════════════════');
  logger.info('');

  const allReports: SmokeTestReport[] = [];

  for (let run = 1; run <= totalRuns; run++) {
    logger.info('');
    logger.info(`────────────────────────────────────────────────────────────`);
    logger.info(`  Starting run ${run} of ${totalRuns}`);
    logger.info(`────────────────────────────────────────────────────────────`);
    logger.info('');

    try {
      const report = await runSingleSmokeTest(run, totalRuns);
      allReports.push(report);

      logger.info(`[smoke-test] Run ${run}/${totalRuns} finished: ${report.overallResult}`);
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        `[smoke-test] Run ${run}/${totalRuns} threw unexpected error`
      );
      // Build a minimal failure report so it still gets tracked
      const failReport: SmokeTestReport = {
        startedAt: Date.now(),
        completedAt: Date.now(),
        totalDurationMs: 0,
        steps: [],
        overallResult: 'FAIL',
        walletBalanceBefore: 0,
        walletBalanceAfter: 0,
        netCostSol: 0,
        passedCount: 0,
        failedCount: 1,
        totalSteps: 0,
        buyFailures: [],
        tokensEvaluated: 0,
        tokensPipelinePassed: 0,
        runNumber: run,
        totalRuns,
      };
      allReports.push(failReport);
      persistReport(failReport);
    }

    // Brief pause between runs to let connections clean up
    if (run < totalRuns) {
      logger.info(`[smoke-test] Waiting 5s before starting run ${run + 1}...`);
      await sleep(5000);
    }
  }

  // Print multi-run summary
  const passed = allReports.filter(r => r.overallResult === 'PASS').length;
  const failed = allReports.filter(r => r.overallResult === 'FAIL').length;
  const totalNetCost = allReports.reduce((sum, r) => sum + r.netCostSol, 0);

  logger.info('');
  logger.info('════════════════════════════════════════════════════════════');
  logger.info('  SMOKE TEST MULTI-RUN SUMMARY');
  logger.info('════════════════════════════════════════════════════════════');
  logger.info(`  Total runs:     ${totalRuns}`);
  logger.info(`  Passed:         ${passed}`);
  logger.info(`  Failed:         ${failed}`);
  logger.info(`  Total net cost: ${totalNetCost.toFixed(6)} SOL`);
  logger.info('');
  for (let i = 0; i < allReports.length; i++) {
    const r = allReports[i];
    const duration = (r.totalDurationMs / 1000).toFixed(1);
    const cost = r.netCostSol.toFixed(6);
    const token = r.tradedToken ? ` ${r.tradedToken.symbol}` : '';
    const trigger = r.exitTrigger ? ` [${r.exitTrigger}]` : '';
    logger.info(`  Run ${i + 1}: ${r.overallResult} | ${duration}s | ${cost} SOL${token}${trigger}`);
  }
  logger.info('');
  logger.info('════════════════════════════════════════════════════════════');
  logger.info('');

  // Return the last report for bootstrap.ts compatibility
  return allReports[allReports.length - 1];
}

async function runSingleSmokeTest(runNumber: number, totalRuns: number): Promise<SmokeTestReport> {
  // Set module-level run context so buildReport can stamp it on reports
  currentRunNumber = runNumber;
  currentTotalRuns = totalRuns;

  // Reset pipeline stats for this run so gate counters are per-run, not cumulative
  resetPipelineStats();

  logger.level = LOG_LEVEL;
  const startedAt = Date.now();
  const config = getConfig();
  const tradeAmount = Number(QUOTE_AMOUNT);
  const timeoutMs = SMOKE_TEST_TIMEOUT_MS;
  const maxHoldMs = MAX_HOLD_DURATION_MS > 0 ? MAX_HOLD_DURATION_MS : 20000;

  const runLabel = totalRuns > 1 ? ` (Run ${runNumber}/${totalRuns})` : '';

  logger.info('');
  logger.info('════════════════════════════════════════');
  logger.info(`  SMOKE TEST MODE${runLabel}`);
  logger.info(`  Trade amount: ${tradeAmount} SOL`);
  logger.info(`  Overall timeout: ${timeoutMs / 1000}s`);
  logger.info(`  Max hold duration: ${maxHoldMs / 1000}s`);
  logger.info(`  Take profit: ${TAKE_PROFIT}%`);
  logger.info(`  Stop loss: ${STOP_LOSS}%`);
  logger.info('════════════════════════════════════════');
  logger.info('');

  // Define all steps
  const steps: SmokeTestStep[] = [
    { name: 'CONFIG_CHECK', status: 'pending', details: '', durationMs: 0 },
    { name: 'RPC_CHECK', status: 'pending', details: '', durationMs: 0 },
    { name: 'BOOT_SYSTEMS', status: 'pending', details: '', durationMs: 0 },
    { name: 'LISTEN_AND_PIPELINE', status: 'pending', details: '', durationMs: 0 },
    { name: 'BUY_EXECUTE', status: 'pending', details: '', durationMs: 0 },
    { name: 'BUY_VERIFY', status: 'pending', details: '', durationMs: 0 },
    { name: 'POSITION_MONITOR', status: 'pending', details: '', durationMs: 0 },
    { name: 'SELL_EXECUTE', status: 'pending', details: '', durationMs: 0 },
    { name: 'SELL_VERIFY', status: 'pending', details: '', durationMs: 0 },
  ];

  // Track state across steps
  let walletBalanceBefore = 0;
  let walletBalanceAfter = 0;
  const buyFailures: BuyFailureRecord[] = [];
  let tokensEvaluated = 0;
  let tokensPipelinePassed = 0;
  let journalSessionId: string | null = null;

  // Initialize live progress so the dashboard shows real-time status
  liveProgress = {
    running: true,
    startedAt,
    currentStep: 'CONFIG_CHECK',
    walletBalanceBefore: 0,
    tokensEvaluated: 0,
    tokensPipelinePassed: 0,
    buyFailures: 0,
    steps,
    runNumber,
    totalRuns,
  };

  // Mutable state holder
  const state: {
    connection: Connection | null;
    wallet: Keypair | null;
    listener: PumpFunListener | null;
    passedToken: DetectedToken | null;
    passedBondingCurve: PublicKey | null;
    isToken2022: boolean;
    buySignature: string;
    buyTimestamp: number;
    tokensReceived: number;
    actualSolSpent: number | undefined;
    sellSignature: string;
    sellSolReceived: number;
    sellTimestamp: number;
    exitTrigger: string;
    buySlippagePercent: number | undefined;
    sellSlippagePercent: number | undefined;
    buyExpectedTokens: number | undefined;
    sellExpectedSol: number | undefined;
    priceHistory: Array<{ timestamp: number; valueSol: number; pnlPercent: number }>;
    highWaterMarkPercent: number | undefined;
    executor: TransactionExecutor | undefined;
    buyExecutorUsed: string | undefined;
    sellExecutorUsed: string | undefined;
    gateRejections: Record<string, number>;
    pipelineRejections: Array<{ stage: string; reason: string }>;
    boughtTokenPipelineData: SmokeTestReport['boughtTokenPipelineData'];
    /** Per-token pipeline durations for computing min/max/avg */
    pipelineDurations: number[];
    /** Research scores for all tokens that reached the research gate */
    allResearchScores: number[];
  } = {
    connection: null,
    wallet: null,
    listener: null,
    passedToken: null,
    passedBondingCurve: null,
    isToken2022: false,
    buySignature: '',
    buyTimestamp: 0,
    tokensReceived: 0,
    actualSolSpent: undefined,
    sellSignature: '',
    sellSolReceived: 0,
    sellTimestamp: 0,
    exitTrigger: '',
    buySlippagePercent: undefined,
    sellSlippagePercent: undefined,
    buyExpectedTokens: undefined,
    sellExpectedSol: undefined,
    priceHistory: [],
    highWaterMarkPercent: undefined,
    executor: undefined,
    buyExecutorUsed: undefined,
    sellExecutorUsed: undefined,
    gateRejections: {},
    pipelineRejections: [],
    boughtTokenPipelineData: undefined,
    pipelineDurations: [],
    allResearchScores: [],
  };

  // Wrap the entire test body in try/finally to guarantee liveProgress is
  // cleared even if an unexpected error propagates (e.g. null assertion failure).
  // Without this, the dashboard would show the test as perpetually "Running...".
  try {

  // ─────────────────────────────────────────────────────────────────────
  // STEP 1: CONFIG_CHECK
  // ─────────────────────────────────────────────────────────────────────
  const configOk = await runStep(steps[0], async () => {
    state.wallet = getWallet(PRIVATE_KEY.trim());

    // Initialize RPC
    const rpcManager = initRpcManager({
      primaryEndpoint: RPC_ENDPOINT,
      primaryWsEndpoint: RPC_WEBSOCKET_ENDPOINT,
      backupEndpoints: RPC_BACKUP_ENDPOINTS,
      commitment: COMMITMENT_LEVEL,
    });
    state.connection = rpcManager.getConnection();

    const balance = await state.connection.getBalance(state.wallet.publicKey, 'confirmed');
    const balanceSol = balance / LAMPORTS_PER_SOL;
    walletBalanceBefore = balanceSol;

    const minRequired = tradeAmount + 0.01; // buffer for gas
    if (balanceSol < minRequired) {
      throw new Error(`Insufficient balance: ${balanceSol.toFixed(4)} SOL (need ${minRequired} SOL)`);
    }

    return `Balance: ${balanceSol.toFixed(4)} SOL, Wallet: ${state.wallet!.publicKey.toString().substring(0, 8)}...`;
  });

  if (!configOk) return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore, '', buyFailures, tokensEvaluated, tokensPipelinePassed);

  // Update progress with wallet balance
  if (liveProgress) {
    liveProgress.walletBalanceBefore = walletBalanceBefore;
    liveProgress.currentStep = 'RPC_CHECK';
  }

  // ─────────────────────────────────────────────────────────────────────
  // STEP 2: RPC_CHECK
  // ─────────────────────────────────────────────────────────────────────
  const rpcOk = await runStep(steps[1], async () => {
    const rpcStart = Date.now();
    const slot = await state.connection!.getSlot('confirmed');
    const latency = Date.now() - rpcStart;

    const blockTime = await state.connection!.getBlockTime(slot);
    const now = Math.floor(Date.now() / 1000);
    const age = blockTime ? now - blockTime : 0;

    if (age > 60) {
      throw new Error(`RPC appears stale: slot ${slot} is ${age}s old`);
    }

    return `Slot: ${slot}, latency: ${latency}ms, block age: ${age}s`;
  });

  if (!rpcOk) return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore, '', buyFailures, tokensEvaluated, tokensPipelinePassed);
  if (liveProgress) liveProgress.currentStep = 'BOOT_SYSTEMS';

  // ─────────────────────────────────────────────────────────────────────
  // STEP 3: BOOT_SYSTEMS
  // ─────────────────────────────────────────────────────────────────────
  const bootOk = await runStep(steps[2], async () => {
    // Initialize persistence so smoke test trades are recorded and visible on dashboard
    initStateStore();
    const pnlTracker = getPnlTracker();
    await pnlTracker.init();

    // Create run journal entry so smoke tests appear on the journal page
    const storeForJournal = getStateStore();
    if (storeForJournal) {
      journalSessionId = storeForJournal.createJournalEntry({
        hypothesis: config.runHypothesis,
        configSnapshot: getRedactedConfigSnapshot(),
        botMode: 'smoke',
        quoteAmountSol: tradeAmount,
        takeProfitPct: config.takeProfit,
        stopLossPct: config.stopLoss,
        maxHoldDurationS: Math.round(maxHoldMs / 1000),
        sniperGateEnabled: config.sniperGateEnabled,
        trailingStopEnabled: config.trailingStopEnabled,
        runNumber,
        totalRuns,
      });
      logger.info({ sessionId: journalSessionId, runNumber }, 'Smoke test journal entry created');
    }

    // Initialize filters
    initPumpFunFilters({
      minSolInCurve: PUMPFUN_MIN_SOL_IN_CURVE,
      maxSolInCurve: PUMPFUN_MAX_SOL_IN_CURVE,
      enableMinSolFilter: PUMPFUN_ENABLE_MIN_SOL_FILTER,
      enableMaxSolFilter: PUMPFUN_ENABLE_MAX_SOL_FILTER,
      minScoreRequired: PUMPFUN_MIN_SCORE_REQUIRED,
    });

    // Initialize pipeline
    initPipeline(state.connection!, state.wallet!, {
      cheapGates: {
        tradeAmountSol: tradeAmount,
        skipMintInfoCheck: true,
      },
      deepFilters: {
        skipBondingCurveCheck: false,
        skipFilters: false,
      },
      sniperGate: {
        enabled: config.sniperGateEnabled,
        initialDelayMs: config.sniperGateInitialDelayMs,
        recheckIntervalMs: config.sniperGateRecheckIntervalMs,
        maxChecks: config.sniperGateMaxChecks,
        sniperSlotThreshold: config.sniperGateSniperSlotThreshold,
        minBotExitPercent: config.sniperGateMinBotExitPercent,
        minOrganicBuyers: config.sniperGateMinOrganicBuyers,
        logOnly: config.sniperGateLogOnly,
      },
      researchScoreGate: {
        enabled: config.researchScoreGateEnabled,
        researchBotUrl: config.researchBotUrl,
        scoreThreshold: config.researchScoreThreshold,
        checkpoint: config.researchScoreCheckpoint,
        logOnly: config.researchScoreLogOnly,
        modelRefreshIntervalMs: config.researchScoreModelRefreshInterval,
      },
      verbose: true,
    });

    initPipelineStats();
    initTradeAuditManager();

    // Initialize position monitor with real SL/TP/max hold settings
    initPumpFunPositionMonitor(state.connection!, state.wallet!, {
      checkIntervalMs: 500,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      maxHoldDurationMs: maxHoldMs,
      trailingStopEnabled: TRAILING_STOP_ENABLED,
      trailingStopActivationPercent: TRAILING_STOP_ACTIVATION_PERCENT,
      trailingStopDistancePercent: TRAILING_STOP_DISTANCE_PERCENT,
      hardTakeProfitPercent: HARD_TAKE_PROFIT_PERCENT,
      costAdjustedExits: COST_ADJUSTED_EXITS,
    });

    // Initialize transaction executor (Jito/Warp bundle support)
    if (TRANSACTION_EXECUTOR === 'jito') {
      const jitoExecutor = new JitoTransactionExecutor(
        CUSTOM_FEE, state.connection!, SIMULATE_TRANSACTION,
        JITO_BUNDLE_TIMEOUT, JITO_BUNDLE_POLL_INTERVAL,
      );
      if (USE_FALLBACK_EXECUTOR) {
        const defaultExecutor = new DefaultTransactionExecutor(state.connection!);
        state.executor = new FallbackTransactionExecutor(jitoExecutor, defaultExecutor, 'jito', 'default');
      } else {
        state.executor = jitoExecutor;
      }
      logger.info({ tip: CUSTOM_FEE }, '[smoke-test] Jito bundle executor enabled');
    } else if (TRANSACTION_EXECUTOR === 'warp') {
      state.executor = new WarpTransactionExecutor(CUSTOM_FEE, state.connection!);
      logger.info({ tip: CUSTOM_FEE }, '[smoke-test] Warp executor enabled');
    } else {
      logger.info('[smoke-test] Using default RPC (no bundle executor)');
    }

    // Initialize listener
    state.listener = initPumpFunListener(state.connection!);

    const executorLabel = state.executor ? `${TRANSACTION_EXECUTOR} bundles (tip: ${CUSTOM_FEE})` : 'direct RPC';
    return `Pipeline, position monitor (TP:${TAKE_PROFIT}%/SL:${STOP_LOSS}%/Hold:${maxHoldMs / 1000}s), listener, tx: ${executorLabel}`;
  });

  if (!bootOk) return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore, '', buyFailures, tokensEvaluated, tokensPipelinePassed);
  if (liveProgress) liveProgress.currentStep = 'LISTEN_AND_PIPELINE';

  // ─────────────────────────────────────────────────────────────────────
  // STEP 4 + 5: LISTEN_AND_PIPELINE -> BUY_EXECUTE (loop until success)
  // Tokens are listened for, run through pipeline, and if one passes,
  // a buy is attempted. If the buy fails, we record it and keep going.
  // ─────────────────────────────────────────────────────────────────────
  const listenAndBuyOk = await runListenPipelineAndBuy(
    steps,
    state,
    tradeAmount,
    timeoutMs,
    startedAt,
    buyFailures,
    (count) => {
      tokensEvaluated = count;
      if (liveProgress) liveProgress.tokensEvaluated = count;
    },
    (count) => {
      tokensPipelinePassed = count;
      if (liveProgress) liveProgress.tokensPipelinePassed = count;
    },
  );

  // Stop listener after we're done with detection
  if (state.listener) {
    try { await state.listener.stop(); } catch { /* ignore */ }
  }

  if (!listenAndBuyOk) {
    // The listen/pipeline step timed out or failed, BUT a buy may have landed
    // on-chain just as the timeout fired.  The async event handler keeps running
    // after the promise rejects, so state.passedToken / state.tokensReceived
    // can be populated even though listenAndBuyOk is false.
    //
    // Give the in-flight buy a brief window to settle, then check whether the
    // wallet actually holds tokens.  If it does, fall through to the normal
    // POSITION_MONITOR → SELL flow instead of returning early.
    if (state.passedToken && state.tokensReceived > 0) {
      logger.warn(
        { mint: state.passedToken.mint.toString(), tokens: state.tokensReceived },
        '[smoke-test] Listen/pipeline timed out but buy succeeded — continuing to sell flow',
      );
      // Mark BUY_EXECUTE as passed (it was set inside the handler already,
      // but the LISTEN_AND_PIPELINE step is marked failed).  This way the
      // report shows what actually happened.
      steps[3].details += ' (timeout, but buy landed)';
    } else {
      // Wait briefly in case buyOnPumpFun is still in-flight
      await sleep(3000);

      if (state.passedToken && state.tokensReceived > 0) {
        logger.warn(
          { mint: state.passedToken.mint.toString(), tokens: state.tokensReceived },
          '[smoke-test] Buy landed after timeout grace period — continuing to sell flow',
        );
        steps[3].details += ' (timeout, but buy landed after grace period)';
      } else {
        // Genuinely no buy — return early as before
        try {
          walletBalanceAfter = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
        } catch { /* ignore */ }
        const earlyGateStats = getPipelineStats()?.getSnapshot()?.gateStats;
        return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceAfter, '', buyFailures, tokensEvaluated, tokensPipelinePassed,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined,
          {
            gateRejections: Object.keys(state.gateRejections).length > 0 ? state.gateRejections : undefined,
            pipelineRejections: state.pipelineRejections.length > 0 ? state.pipelineRejections : undefined,
            gateStats: earlyGateStats,
            runPipelineStats: state.pipelineDurations.length > 0 ? {
              avgPipelineDurationMs: state.pipelineDurations.reduce((a, b) => a + b, 0) / state.pipelineDurations.length,
              maxPipelineDurationMs: Math.max(...state.pipelineDurations),
              minPipelineDurationMs: Math.min(...state.pipelineDurations),
              avgResearchScore: state.allResearchScores.length > 0
                ? state.allResearchScores.reduce((a, b) => a + b, 0) / state.allResearchScores.length
                : undefined,
              maxResearchScore: state.allResearchScores.length > 0
                ? Math.max(...state.allResearchScores)
                : undefined,
              minResearchScore: state.allResearchScores.length > 0
                ? Math.min(...state.allResearchScores)
                : undefined,
              researchScoreCount: state.allResearchScores.length > 0
                ? state.allResearchScores.length
                : undefined,
            } : undefined,
          },
        );
      }
    }
  }

  if (liveProgress) liveProgress.currentStep = 'BUY_VERIFY';

  // ─────────────────────────────────────────────────────────────────────
  // STEP 6: BUY_VERIFY
  // ─────────────────────────────────────────────────────────────────────
  await runStep(steps[5], async () => {
    await sleep(2000);

    const tokenProgramId = state.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    const tokenAta = getAssociatedTokenAddressSync(state.passedToken!.mint, state.wallet!.publicKey, false, tokenProgramId);

    let actualBalance = 0;
    try {
      const account = await getAccount(state.connection!, tokenAta, 'confirmed', tokenProgramId);
      actualBalance = Number(account.amount);
    } catch {
      throw new Error('Token account not found after buy - tokens may not have been received');
    }

    if (actualBalance <= 0) {
      throw new Error('Token balance is 0 after buy');
    }

    const currentSolBalance = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
    const totalSolSpent = walletBalanceBefore - currentSolBalance;
    const overhead = state.actualSolSpent !== undefined
      ? state.actualSolSpent - tradeAmount
      : totalSolSpent - tradeAmount;

    return `${actualBalance} tokens in wallet, ${totalSolSpent.toFixed(4)} SOL spent ` +
           `(trade: ${tradeAmount}, overhead: ${overhead.toFixed(6)} [ATA rent + gas])`;
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 7: POSITION_MONITOR - Real SL/TP/max hold monitoring
  // ─────────────────────────────────────────────────────────────────────
  if (liveProgress) liveProgress.currentStep = 'POSITION_MONITOR';
  const monitorOk = await runStep(steps[6], async () => {
    const monitor = initPumpFunPositionMonitor(state.connection!, state.wallet!, {
      checkIntervalMs: 500,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      maxHoldDurationMs: maxHoldMs,
      trailingStopEnabled: TRAILING_STOP_ENABLED,
      trailingStopActivationPercent: TRAILING_STOP_ACTIVATION_PERCENT,
      trailingStopDistancePercent: TRAILING_STOP_DISTANCE_PERCENT,
      hardTakeProfitPercent: HARD_TAKE_PROFIT_PERCENT,
      costAdjustedExits: COST_ADJUSTED_EXITS,
    });

    // Add the position to monitor
    monitor.addPosition({
      tokenMint: state.passedToken!.mint.toString(),
      bondingCurve: state.passedBondingCurve!.toString(),
      entryAmountSol: tradeAmount,
      actualCostSol: state.actualSolSpent,
      tokenAmount: state.tokensReceived,
      entryTimestamp: Date.now(),
      buySignature: state.buySignature,
      isToken2022: state.isToken2022,
    });

    monitor.start();

    // Wait for a trigger event (SL, TP, time_exit, graduated)
    const remainingTimeout = Math.max(timeoutMs - (Date.now() - startedAt), 30000);

    return new Promise<string>((resolve, reject) => {
      const monitorTimeout = setTimeout(() => {
        monitor.stop();
        reject(new Error(`Position monitor did not trigger within remaining timeout (${Math.floor(remainingTimeout / 1000)}s)`));
      }, remainingTimeout);

      monitor.on('trigger', (event: PumpFunTriggerEvent) => {
        clearTimeout(monitorTimeout);
        monitor.stop();
        // Remove position from monitor - we'll handle the sell ourselves with retry logic
        monitor.removePosition(event.position.tokenMint);

        state.exitTrigger = event.type;
        state.priceHistory = event.position.priceHistory || [];
        state.highWaterMarkPercent = event.position.highWaterMarkPercent;
        const pnlSign = event.pnlPercent >= 0 ? '+' : '';
        const tradePnl = `${pnlSign}${event.pnlPercent.toFixed(2)}%`;
        const totalCostPnlStr = event.totalCostPnlPercent !== undefined
          ? `, total-cost PnL: ${event.totalCostPnlPercent >= 0 ? '+' : ''}${event.totalCostPnlPercent.toFixed(2)}%`
          : '';
        resolve(`Exit trigger: ${event.type}, PnL: ${tradePnl}${totalCostPnlStr}, value: ${event.currentValueSol.toFixed(6)} SOL`);
      });
    });
  });

  if (!monitorOk) {
    // Still try to sell if monitor failed
    logger.warn('[smoke-test] Monitor step failed, attempting sell anyway');
  }

  // ─────────────────────────────────────────────────────────────────────
  // STEP 8: SELL_EXECUTE - with 3x retry
  // ─────────────────────────────────────────────────────────────────────
  if (liveProgress) liveProgress.currentStep = 'SELL_EXECUTE';
  const sellOk = await runStep(steps[7], async () => {
    const smokeTestSlippageBps = SELL_SLIPPAGE * 100; // Use actual configured slippage
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      logger.info(`[smoke-test] Sell attempt ${attempt}/${maxAttempts}`);

      const sellResult = await sellOnPumpFun({
        connection: state.connection!,
        wallet: state.wallet!,
        mint: state.passedToken!.mint,
        bondingCurve: state.passedBondingCurve!,
        tokenAmount: state.tokensReceived,
        slippageBps: smokeTestSlippageBps,
        computeUnitLimit: COMPUTE_UNIT_LIMIT,
        computeUnitPrice: COMPUTE_UNIT_PRICE,
        isToken2022: state.isToken2022,
        executor: state.executor,
      });

      if (sellResult.success) {
        state.sellSignature = sellResult.signature || '';
        state.sellSolReceived = sellResult.solReceived || 0;
        state.sellTimestamp = Date.now();
        state.sellSlippagePercent = sellResult.slippagePercent;
        state.sellExpectedSol = sellResult.expectedSol;
        state.sellExecutorUsed = sellResult.executorUsed;
        return `Sold on attempt ${attempt}/${maxAttempts} for ${state.sellSolReceived.toFixed(6)} SOL, sig: ${state.sellSignature.substring(0, 12)}...`;
      }

      logger.warn(`[smoke-test] Sell attempt ${attempt} failed: ${sellResult.error}`);

      if (attempt < maxAttempts) {
        await sleep(2000);
      }
    }

    // All retries exhausted - position is likely dead, just report it
    return `All ${maxAttempts} sell attempts failed - position abandoned (token likely dead)`;
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 9: SELL_VERIFY
  // ─────────────────────────────────────────────────────────────────────
  if (liveProgress) liveProgress.currentStep = 'SELL_VERIFY';
  if (sellOk && state.sellSignature) {
    await runStep(steps[8], async () => {
      await sleep(2000);

      const tokenProgramId = state.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const tokenAta = getAssociatedTokenAddressSync(state.passedToken!.mint, state.wallet!.publicKey, false, tokenProgramId);

      let remainingTokens = 0;
      try {
        const account = await getAccount(state.connection!, tokenAta, 'confirmed', tokenProgramId);
        remainingTokens = Number(account.amount);
      } catch {
        remainingTokens = 0;
      }

      walletBalanceAfter = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
      const netCost = walletBalanceBefore - walletBalanceAfter;

      if (remainingTokens > 0) {
        return `WARNING: ${remainingTokens} tokens still in wallet. Net cost: ${netCost.toFixed(6)} SOL`;
      }

      return `Position closed. Net cost: ${netCost.toFixed(6)} SOL (includes gas fees)`;
    });
  } else {
    steps[8].status = 'skipped';
    steps[8].details = state.sellSignature ? 'Skipped because sell failed' : 'Skipped - sell did not produce a signature (position abandoned)';

    try {
      walletBalanceAfter = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
    } catch { /* ignore */ }
  }

  // Record the sell trade in persistence layer for dashboard P&L
  // Wrapped in try-catch so persistence errors never block the report
  if (state.passedToken && state.sellSignature && state.sellSolReceived > 0) {
    try {
      const mintStr = state.passedToken.mint.toString();
      const bondingCurveStr = state.passedBondingCurve!.toString();

      const pnlTracker = getPnlTracker();
      pnlTracker.recordSell({
        tokenMint: mintStr,
        tokenSymbol: state.passedToken.symbol,
        amountSol: state.sellSolReceived,
        amountToken: state.tokensReceived,
        poolId: bondingCurveStr,
        txSignature: state.sellSignature,
      });

      const stateStore = getStateStore();
      if (stateStore) {
        stateStore.closePosition(mintStr, `smoke_test_${state.exitTrigger || 'completed'}`);
      }
    } catch (persistError) {
      logger.warn(
        { error: persistError instanceof Error ? persistError.message : String(persistError) },
        '[smoke-test] Failed to record sell in persistence layer (non-fatal)'
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // POST-SELL PRICE TRACKING - Continue monitoring bonding curve price
  // for up to 5 minutes from the buy to build a fuller price chart
  // ─────────────────────────────────────────────────────────────────────
  const POST_SELL_TOTAL_DURATION_MS = 5 * 60 * 1000; // 5 minutes total from buy
  const POST_SELL_SNAPSHOT_INTERVAL_MS = 5000; // every 5 seconds

  if (state.passedToken && state.passedBondingCurve && state.buyTimestamp && state.tokensReceived > 0) {
    const trackingDeadline = state.buyTimestamp + POST_SELL_TOTAL_DURATION_MS;
    const remainingMs = trackingDeadline - Date.now();

    if (remainingMs > POST_SELL_SNAPSHOT_INTERVAL_MS) {
      if (liveProgress) liveProgress.currentStep = 'POST_SELL_TRACKING';
      logger.info(
        { remainingMs: Math.floor(remainingMs / 1000) + 's' },
        '[smoke-test] Continuing price tracking after sell',
      );

      const bondingCurveKey = state.passedBondingCurve;
      const tokenAmountBN = new BN(state.tokensReceived);

      while (Date.now() < trackingDeadline) {
        await sleep(POST_SELL_SNAPSHOT_INTERVAL_MS);
        if (Date.now() >= trackingDeadline) break;

        try {
          const accountInfo = await state.connection!.getAccountInfo(bondingCurveKey, 'confirmed');
          if (!accountInfo?.data) continue;

          const bcState = decodeBondingCurveState(accountInfo.data as Buffer);
          if (!bcState || bcState.complete) break; // token graduated, stop tracking

          const expectedSolOut = calculateSellSolOut(bcState, tokenAmountBN);
          const currentValueSol = expectedSolOut.toNumber() / LAMPORTS_PER_SOL;

          if (!Number.isFinite(currentValueSol) || currentValueSol < 0) continue;

          const rawPnlPercent = ((currentValueSol - tradeAmount) / tradeAmount) * 100;

          if (!state.priceHistory) state.priceHistory = [];
          state.priceHistory.push({ timestamp: Date.now(), valueSol: currentValueSol, pnlPercent: rawPnlPercent });
        } catch (err) {
          logger.debug({ error: err }, '[smoke-test] Post-sell price fetch failed (non-fatal)');
        }
      }

      logger.info(
        { snapshots: state.priceHistory.length },
        '[smoke-test] Post-sell price tracking complete',
      );
    }
  }

  const tradedToken = state.passedToken ? {
    name: state.passedToken.name || '',
    symbol: state.passedToken.symbol || '',
    mint: state.passedToken.mint.toString(),
    bondingCurve: state.passedBondingCurve?.toString() || '',
  } : undefined;

  // Snapshot pipeline gate stats for this run
  const pipelineStatsSnapshot = getPipelineStats()?.getSnapshot();
  const snapshotGateStats = pipelineStatsSnapshot?.gateStats;

  return buildReport(
    startedAt, steps, walletBalanceBefore, walletBalanceAfter, state.exitTrigger,
    buyFailures, tokensEvaluated, tokensPipelinePassed, state.actualSolSpent, tradeAmount,
    tradedToken, state.buyTimestamp || undefined, state.sellTimestamp || undefined,
    state.buySignature || undefined, state.sellSignature || undefined,
    {
      sellSolReceived: state.sellSolReceived || undefined,
      buySlippagePercent: state.buySlippagePercent,
      sellSlippagePercent: state.sellSlippagePercent,
      buyExpectedTokens: state.buyExpectedTokens,
      buyActualTokens: state.tokensReceived || undefined,
      sellExpectedSol: state.sellExpectedSol,
      priceHistory: state.priceHistory.length > 0 ? state.priceHistory : undefined,
      highWaterMarkPercent: state.highWaterMarkPercent,
      bundleExecutorActive: state.executor !== undefined,
      buyExecutorUsed: state.buyExecutorUsed,
      sellExecutorUsed: state.sellExecutorUsed,
      gateRejections: Object.keys(state.gateRejections).length > 0 ? state.gateRejections : undefined,
      pipelineRejections: state.pipelineRejections.length > 0 ? state.pipelineRejections : undefined,
      gateStats: snapshotGateStats,
      boughtTokenPipelineData: state.boughtTokenPipelineData,
      runPipelineStats: state.pipelineDurations.length > 0 ? {
        avgPipelineDurationMs: state.pipelineDurations.reduce((a, b) => a + b, 0) / state.pipelineDurations.length,
        maxPipelineDurationMs: Math.max(...state.pipelineDurations),
        minPipelineDurationMs: Math.min(...state.pipelineDurations),
        avgResearchScore: state.allResearchScores.length > 0
          ? state.allResearchScores.reduce((a, b) => a + b, 0) / state.allResearchScores.length
          : undefined,
      } : undefined,
    },
  );

  } finally {
    // Close run journal entry with per-run stats from this smoke test cycle
    if (journalSessionId) {
      try {
        const storeForClose = getStateStore();
        if (storeForClose) {
          const didBuy = state.buySignature !== '';
          const didSell = state.sellSignature !== '';
          const pnlSol = didSell && state.actualSolSpent != null
            ? state.sellSolReceived - state.actualSolSpent
            : 0;
          storeForClose.closeJournalEntry({
            sessionId: journalSessionId,
            totalDetections: tokensEvaluated,
            totalTrades: didBuy ? 1 : 0,
            totalWins: pnlSol > 0 ? 1 : 0,
            totalLosses: didSell && pnlSol <= 0 ? 1 : 0,
            realizedPnlSol: pnlSol,
          });
          logger.info({ sessionId: journalSessionId, runNumber }, 'Smoke test journal entry closed');
        }
      } catch (journalErr) {
        logger.warn({ error: journalErr }, 'Failed to close smoke test journal entry');
      }
    }

    // Always clear live progress so the dashboard never shows a stale "Running..." state
    liveProgress = null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// LISTEN + PIPELINE + BUY LOOP
// ════════════════════════════════════════════════════════════════════════════

/**
 * Listens for tokens, runs them through the pipeline, and attempts to buy
 * the first one that passes. If a buy fails, records the failure and
 * continues until a successful buy or timeout.
 */
async function runListenPipelineAndBuy(
  steps: SmokeTestStep[],
  state: {
    connection: Connection | null;
    wallet: Keypair | null;
    listener: PumpFunListener | null;
    passedToken: DetectedToken | null;
    passedBondingCurve: PublicKey | null;
    isToken2022: boolean;
    buySignature: string;
    buyTimestamp: number;
    tokensReceived: number;
    actualSolSpent: number | undefined;
    sellSignature: string;
    sellSolReceived: number;
    sellTimestamp: number;
    exitTrigger: string;
    buySlippagePercent: number | undefined;
    sellSlippagePercent: number | undefined;
    buyExpectedTokens: number | undefined;
    sellExpectedSol: number | undefined;
    priceHistory: Array<{ timestamp: number; valueSol: number; pnlPercent: number }>;
    highWaterMarkPercent: number | undefined;
    executor: TransactionExecutor | undefined;
    buyExecutorUsed: string | undefined;
    sellExecutorUsed: string | undefined;
    gateRejections: Record<string, number>;
    pipelineRejections: Array<{ stage: string; reason: string }>;
    boughtTokenPipelineData: SmokeTestReport['boughtTokenPipelineData'];
    pipelineDurations: number[];
    allResearchScores: number[];
  },
  tradeAmount: number,
  timeoutMs: number,
  startedAt: number,
  buyFailures: BuyFailureRecord[],
  setTokensEvaluated: (count: number) => void,
  setTokensPipelinePassed: (count: number) => void,
): Promise<boolean> {
  let tokensEvaluated = 0;
  let tokensPipelinePassed = 0;
  let buySucceeded = false;

  // STEP 4: LISTEN_AND_PIPELINE
  const listenOk = await runStep(steps[3], async () => {
    const pipeline = getPipeline();
    if (!pipeline) throw new Error('Pipeline not initialized');

    return new Promise<string>((resolve, reject) => {
      const overallTimeout = setTimeout(() => {
        reject(new Error(
          `No token passed pipeline and was successfully bought within ${timeoutMs / 1000}s timeout. ` +
          `Evaluated: ${tokensEvaluated}, Pipeline passed: ${tokensPipelinePassed}, Buy failures: ${buyFailures.length}`
        ));
      }, timeoutMs);

      // Track whether we're currently processing a pipeline+buy attempt
      let processingBuy = false;

      // In-memory guard: prevents the same mint from entering the pipeline
      // concurrently when duplicate websocket events arrive before the async
      // pipeline completes. Without this, 3-4 duplicate events for the same
      // mint all pass through the processingBuy check (which is false for all
      // of them) and run the full pipeline in parallel, leading to duplicate buys.
      const inFlightMints = new Set<string>();

      // Remove any stale 'new-token' handlers from previous runs.
      // initPumpFunListener() is a singleton — across multi-run smoke tests the
      // same EventEmitter instance is reused.  Without this cleanup, handlers from
      // earlier runs remain attached and fire alongside the current run's handler,
      // causing duplicate pipeline processing (one per stale handler).
      state.listener!.removeAllListeners('new-token');

      state.listener!.on('new-token', async (token: DetectedToken) => {
        if (token.source !== 'pumpfun') return;
        if (buySucceeded) return; // Already got a successful buy
        if (processingBuy) return; // Don't overlap buy attempts

        const mintStr = token.mint.toString();
        if (inFlightMints.has(mintStr)) {
          logger.debug({ mint: mintStr }, '[smoke-test] Duplicate mint event, already in-flight — skipping');
          return;
        }
        inFlightMints.add(mintStr);

        try {

        tokensEvaluated++;
        setTokensEvaluated(tokensEvaluated);

        // Build detection event for pipeline
        const detectionEvent: DetectionEvent = {
          signature: token.signature || `smoke-test-${Date.now()}`,
          slot: token.slot ?? 0,
          mint: token.mint,
          bondingCurve: token.bondingCurve!,
          associatedBondingCurve: token.associatedBondingCurve!,
          creator: token.creator || null,
          name: token.name,
          symbol: token.symbol,
          rawLogs: [],
          detectedAt: Date.now(),
          isToken2022: token.isToken2022,
          source: 'websocket',
        };

        // Run through pipeline
        const result = await pipeline.process(detectionEvent);

        // Record result in PipelineStats singleton so gate statistics are tracked
        // (mirrors index.ts production path — without this, gateStats stays at zero)
        getPipelineStats()?.recordResult(result);

        // Track per-token pipeline duration for run-wide stats
        state.pipelineDurations.push(result.totalDurationMs);

        // Track research scores for all tokens that reached the research gate
        if (result.context.researchScore) {
          state.allResearchScores.push(result.context.researchScore.score);
        }

        if (!result.success) {
          // Track which gate rejected this token
          const gate = result.rejectedAt || 'unknown';
          state.gateRejections[gate] = (state.gateRejections[gate] || 0) + 1;
          // Record detailed rejection for per-component analytics
          state.pipelineRejections.push({
            stage: gate,
            reason: result.rejectionReason || 'unknown',
          });
          logger.debug(
            { mint: mintStr, symbol: token.symbol, reason: result.rejectionReason, gate },
            '[smoke-test] Token rejected by pipeline'
          );
          return;
        }

        // Re-check AFTER the async pipeline await. Two tokens arriving within the pipeline
        // processing window (~100-200ms) will both pass the initial `if (processingBuy)`
        // guard at the top because the flag is still false while both are inside
        // pipeline.process(). This second check closes that race window — only the first
        // token to exit the pipeline and reach here will proceed to buy.
        if (buySucceeded || processingBuy) {
          logger.debug(
            { mint: mintStr, symbol: token.symbol },
            '[smoke-test] Pipeline passed but another token already claimed the buy slot - skipping'
          );
          return;
        }

        // Claim the buy slot before any further awaits
        processingBuy = true;

        // Pipeline passed!
        tokensPipelinePassed++;
        setTokensPipelinePassed(tokensPipelinePassed);
        logger.info(
          { mint: mintStr, symbol: token.symbol, score: result.context.deepFilters?.filterResults?.score },
          '[smoke-test] Token passed pipeline - attempting buy'
        );

        // Attempt buy - use cheapGates if available, otherwise fall back to detection event
        const isToken2022 = result.context.cheapGates?.mintInfo?.isToken2022 ?? token.isToken2022 ?? false;

        try {
          const buyResult = await buyOnPumpFun({
            connection: state.connection!,
            wallet: state.wallet!,
            mint: token.mint,
            bondingCurve: token.bondingCurve!,
            amountSol: tradeAmount,
            slippageBps: BUY_SLIPPAGE * 100,
            computeUnitLimit: COMPUTE_UNIT_LIMIT,
            computeUnitPrice: COMPUTE_UNIT_PRICE,
            isToken2022,
            executor: state.executor,
          });

          if (buyResult.success) {
            // Buy succeeded!
            state.passedToken = token;
            state.passedBondingCurve = token.bondingCurve!;
            state.isToken2022 = isToken2022;
            state.buySignature = buyResult.signature || '';
            state.buyTimestamp = Date.now();
            state.tokensReceived = buyResult.tokensReceived || 0;
            state.actualSolSpent = buyResult.actualSolSpent;
            state.buySlippagePercent = buyResult.slippagePercent;
            state.buyExpectedTokens = buyResult.expectedTokens;
            state.buyExecutorUsed = buyResult.executorUsed;
            buySucceeded = true;

            // Capture pipeline data for the bought token
            const stageDurations: Record<string, number> = {};
            for (const sr of result.stageResults) {
              stageDurations[sr.stage] = sr.durationMs;
            }
            state.boughtTokenPipelineData = {
              researchScore: result.context.researchScore?.score,
              researchSignal: result.context.researchScore?.signal,
              compositeScore: result.context.deepFilters?.filterResults?.score,
              cheapGateDurationMs: stageDurations['cheap-gates'],
              deepFilterDurationMs: stageDurations['deep-filters'],
              sniperGateDurationMs: stageDurations['sniper-gate'],
              researchGateDurationMs: stageDurations['research-score-gate'],
              stableGateDurationMs: stageDurations['stable-gate'],
              totalPipelineDurationMs: result.totalDurationMs,
            };

            clearTimeout(overallTimeout);

            // Record real money buy in persistence layer for dashboard P&L
            // Wrapped in try-catch so persistence errors never block the sell flow
            try {
              const stateStore = getStateStore();
              const bCurveStr = token.bondingCurve!.toString();
              const solSpent = state.actualSolSpent ?? tradeAmount;

              if (stateStore) {
                const tokensRcvd = state.tokensReceived;
                const entryPrice = tokensRcvd > 0 ? solSpent / tokensRcvd : 0;
                stateStore.createPosition({
                  tokenMint: mintStr,
                  poolId: bCurveStr,
                  amountSol: solSpent,
                  amountToken: tokensRcvd,
                  entryPrice,
                });
              }

              const pnlTracker = getPnlTracker();
              pnlTracker.recordBuy({
                tokenMint: mintStr,
                tokenSymbol: token.symbol,
                amountSol: solSpent,
                amountToken: state.tokensReceived,
                poolId: bCurveStr,
                txSignature: state.buySignature,
              });
            } catch (persistError) {
              logger.warn(
                { error: persistError instanceof Error ? persistError.message : String(persistError) },
                '[smoke-test] Failed to record buy in persistence layer (non-fatal - sell will still proceed)'
              );
            }

            // Mark buy step as passed too
            steps[4].status = 'passed';
            steps[4].details = `Bought ${state.tokensReceived} tokens of ${token.symbol || 'Unknown'}, sig: ${state.buySignature.substring(0, 12)}...`;
            steps[4].durationMs = 0;

            resolve(
              `Pipeline passed: ${token.symbol || 'Unknown'} (${mintStr.substring(0, 12)}...), ` +
              `score: ${result.context.deepFilters?.filterResults?.score ?? 'N/A'}, ` +
              `evaluated: ${tokensEvaluated}, pipeline passed: ${tokensPipelinePassed}`
            );
          } else {
            // Buy failed - record and continue
            const failReason = buyResult.error || 'Unknown buy error';
            buyFailures.push({
              tokenSymbol: token.symbol || 'Unknown',
              tokenMint: mintStr,
              reason: failReason,
              timestamp: Date.now(),
            });
            if (liveProgress) liveProgress.buyFailures = buyFailures.length;

            logger.warn(
              { mint: mintStr, symbol: token.symbol, error: failReason },
              `[smoke-test] Buy failed (attempt ${buyFailures.length}) - continuing to listen`
            );

            processingBuy = false;
          }
        } catch (error) {
          const failReason = error instanceof Error ? error.message : String(error);
          buyFailures.push({
            tokenSymbol: token.symbol || 'Unknown',
            tokenMint: mintStr,
            reason: failReason,
            timestamp: Date.now(),
          });
          if (liveProgress) liveProgress.buyFailures = buyFailures.length;

          logger.warn(
            { mint: mintStr, error: failReason },
            `[smoke-test] Buy threw error (attempt ${buyFailures.length}) - continuing to listen`
          );

          processingBuy = false;
        }

        } finally {
          inFlightMints.delete(mintStr);
        }
      });

      state.listener!.start().catch(reject);
    });
  });

  if (!listenOk || !buySucceeded) {
    // If the pipeline step passed but buy failed, mark buy as failed
    if (listenOk && !buySucceeded) {
      steps[4].status = 'failed';
      steps[4].details = `No successful buy. ${buyFailures.length} buy failures recorded.`;
    } else if (!listenOk) {
      steps[4].status = 'skipped';
      steps[4].details = 'Skipped because pipeline/listen step failed';
    }
    return false;
  }

  return true;
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT BUILDER
// ════════════════════════════════════════════════════════════════════════════

interface BuildReportExtras {
  sellSolReceived?: number;
  buySlippagePercent?: number;
  sellSlippagePercent?: number;
  buyExpectedTokens?: number;
  buyActualTokens?: number;
  sellExpectedSol?: number;
  priceHistory?: Array<{ timestamp: number; valueSol: number; pnlPercent: number }>;
  highWaterMarkPercent?: number;
  bundleExecutorActive?: boolean;
  buyExecutorUsed?: string;
  sellExecutorUsed?: string;
  gateRejections?: Record<string, number>;
  pipelineRejections?: Array<{ stage: string; reason: string }>;
  gateStats?: SmokeTestReport['gateStats'];
  boughtTokenPipelineData?: SmokeTestReport['boughtTokenPipelineData'];
  runPipelineStats?: SmokeTestReport['runPipelineStats'];
}

function buildReport(
  startedAt: number,
  steps: SmokeTestStep[],
  walletBefore: number,
  walletAfter: number,
  exitTrigger: string,
  buyFailures: BuyFailureRecord[],
  tokensEvaluated: number,
  tokensPipelinePassed: number,
  actualSolSpentOnBuy?: number,
  tradeAmount?: number,
  tradedToken?: { name: string; symbol: string; mint: string; bondingCurve: string },
  buyTimestamp?: number,
  sellTimestamp?: number,
  buySignature?: string,
  sellSignature?: string,
  extras?: BuildReportExtras,
): SmokeTestReport {
  const sellSolReceived = extras?.sellSolReceived;
  const completedAt = Date.now();
  const passedCount = steps.filter((s) => s.status === 'passed').length;
  const failedCount = steps.filter((s) => s.status === 'failed').length;
  const totalSteps = steps.filter((s) => s.status !== 'skipped' && s.status !== 'pending').length;
  const overallResult = failedCount === 0 && passedCount > 0 ? 'PASS' : 'FAIL';

  const buyOverhead = (actualSolSpentOnBuy !== undefined && tradeAmount !== undefined)
    ? actualSolSpentOnBuy - tradeAmount
    : undefined;

  // Compute trade return and fee breakdown when we have sell data
  const netCostSol = walletBefore - walletAfter;
  let tradeReturnSol: number | undefined;
  let feeBreakdown: FeeBreakdown | undefined;
  let pnlPercentWithOverhead: number | undefined;
  let pnlPercentWithoutOverhead: number | undefined;

  if (sellSolReceived !== undefined && tradeAmount !== undefined && tradeAmount > 0) {
    // Trade return: pure trade P&L ignoring gas/tips overhead
    tradeReturnSol = sellSolReceived - tradeAmount;

    // % return on the trade amount only (ignores overhead)
    pnlPercentWithoutOverhead = (tradeReturnSol / tradeAmount) * 100;

    // % return on actual total cost (includes all overhead)
    if (actualSolSpentOnBuy !== undefined && actualSolSpentOnBuy > 0) {
      const allInPnl = sellSolReceived - actualSolSpentOnBuy;
      pnlPercentWithOverhead = (allInPnl / actualSolSpentOnBuy) * 100;
    }

    // Fee breakdown
    // ── Wallet-level overhead (measured from balance deltas) ──
    const measuredBuyOverhead = buyOverhead ?? 0;
    // walletOverhead = total SOL lost beyond the trade itself
    //   = (walletBefore - walletAfter) - (tradeAmount - sellSolReceived)
    //   = netCostSol + tradeReturnSol
    const walletOverhead = tradeReturnSol + netCostSol;
    const sellOverhead = Math.max(0, walletOverhead - measuredBuyOverhead);

    // ── Protocol fees (estimated — embedded in bonding curve price) ──
    // These are NOT visible at the wallet level because pump.fun deducts them
    // before computing token output (buy) or SOL output (sell).
    const estimatedPumpBuyFee = tradeAmount * 0.01;       // ~1% on buys
    const estimatedPumpSellFee = sellSolReceived * 0.0125; // ~1.25% on sells

    // ── Jito tip (from config, for reference only) ──
    // NOTE: buyOnPumpFun/sellOnPumpFun use connection.sendRawTransaction()
    // directly, bypassing the Jito/Warp executor. This tip is configured but
    // NOT actually sent in the current pump.fun transaction path.
    const jitoTipPerTx = parseFloat(CUSTOM_FEE) || 0;

    // ── All-in total: wallet overhead + protocol fees ──
    const totalOverhead = walletOverhead + estimatedPumpBuyFee + estimatedPumpSellFee;

    const bundleExecutorActive = extras?.bundleExecutorActive ?? false;
    feeBreakdown = {
      buyOverhead: measuredBuyOverhead,
      sellOverhead,
      walletOverhead,
      estimatedPumpBuyFee,
      estimatedPumpSellFee,
      jitoTipPerTx,
      totalOverhead,
      bundleExecutorActive,
      executorType: TRANSACTION_EXECUTOR,
      buyExecutorUsed: extras?.buyExecutorUsed,
      sellExecutorUsed: extras?.sellExecutorUsed,
    };
  }

  // Slippage analysis
  let slippage: SmokeTestReport['slippage'];
  if (extras) {
    const buySlipPct = extras.buySlippagePercent;
    const sellSlipPct = extras.sellSlippagePercent;
    const buyExpected = extras.buyExpectedTokens;
    const buyActual = extras.buyActualTokens;
    const sellExpected = extras.sellExpectedSol;
    const sellActual = sellSolReceived;

    // Estimate SOL cost of slippage
    let buySlippageCostSol: number | undefined;
    if (buySlipPct !== undefined && tradeAmount !== undefined) {
      // Negative slippage = got fewer tokens = lost value
      buySlippageCostSol = Math.abs(buySlipPct / 100) * tradeAmount;
      if (buySlipPct >= 0) buySlippageCostSol = 0; // Positive slippage = no cost
    }
    let sellSlippageCostSol: number | undefined;
    if (sellSlipPct !== undefined && sellActual !== undefined) {
      // Negative slippage = got less SOL
      sellSlippageCostSol = sellSlipPct < 0 ? Math.abs(sellSlipPct / 100) * sellActual : 0;
    }

    if (buySlipPct !== undefined || sellSlipPct !== undefined) {
      slippage = {
        buySlippagePercent: buySlipPct,
        sellSlippagePercent: sellSlipPct,
        buyExpectedTokens: buyExpected,
        buyActualTokens: buyActual,
        sellExpectedSol: sellExpected,
        sellActualSol: sellActual,
        buySlippageCostSol,
        sellSlippageCostSol,
      };
    }
  }

  // Price history and hold duration
  const priceHistory = extras?.priceHistory;
  const highWaterMarkPercent = extras?.highWaterMarkPercent;
  const holdDurationMs = (buyTimestamp && sellTimestamp) ? sellTimestamp - buyTimestamp : undefined;

  // Trade efficiency score (0-100)
  // Composed of three sub-scores weighted:
  //   - Overhead ratio (40%): how small the overhead is relative to trade amount
  //   - Slippage score (30%): how close actual was to expected
  //   - Return score (30%): whether the trade was profitable
  let tradeEfficiencyScore: number | undefined;
  if (tradeAmount !== undefined && tradeAmount > 0 && sellSolReceived !== undefined) {
    // Overhead ratio score: 100 = no overhead, 0 = overhead >= trade amount
    const overheadRatio = feeBreakdown ? feeBreakdown.totalOverhead / tradeAmount : 0;
    const overheadScore = Math.max(0, Math.min(100, (1 - overheadRatio * 5) * 100));

    // Slippage score: 100 = no slippage, 0 = 10%+ slippage
    const avgSlippage = Math.abs(slippage?.buySlippagePercent ?? 0) + Math.abs(slippage?.sellSlippagePercent ?? 0);
    const slippageScore = Math.max(0, Math.min(100, (1 - avgSlippage / 20) * 100));

    // Return score: 100 = +10% or better, 50 = breakeven, 0 = -10% or worse
    const returnPct = pnlPercentWithOverhead ?? 0;
    const returnScore = Math.max(0, Math.min(100, 50 + returnPct * 5));

    tradeEfficiencyScore = Math.round(overheadScore * 0.4 + slippageScore * 0.3 + returnScore * 0.3);
  }

  // Capture environment variables snapshot for cross-run analytics
  // Include all tunable parameters so the dashboard can analyze impact of any setting
  const config = getConfig();
  const envSnapshot: Record<string, string | number | boolean> = {
    // Trading parameters
    QUOTE_AMOUNT: Number(QUOTE_AMOUNT),
    TAKE_PROFIT,
    STOP_LOSS,
    BUY_SLIPPAGE,
    SELL_SLIPPAGE,
    AUTO_BUY_DELAY,
    AUTO_SELL,
    AUTO_SELL_DELAY,
    PRICE_CHECK_INTERVAL,
    PRICE_CHECK_DURATION,
    ONE_TOKEN_AT_A_TIME,
    // Position management
    MAX_HOLD_DURATION_MS,
    MAX_BUY_RETRIES,
    MAX_SELL_RETRIES,
    // Risk controls
    MAX_TOTAL_EXPOSURE_SOL,
    MAX_TRADES_PER_HOUR,
    MIN_WALLET_BUFFER_SOL,
    // Transaction execution
    COMPUTE_UNIT_LIMIT,
    COMPUTE_UNIT_PRICE,
    TRANSACTION_EXECUTOR,
    SIMULATE_TRANSACTION,
    USE_DYNAMIC_FEE,
    PRIORITY_FEE_PERCENTILE,
    MIN_PRIORITY_FEE,
    MAX_PRIORITY_FEE,
    USE_FALLBACK_EXECUTOR,
    // Pump.fun filters
    PUMPFUN_MIN_SOL_IN_CURVE,
    PUMPFUN_MAX_SOL_IN_CURVE,
    PUMPFUN_ENABLE_MIN_SOL_FILTER,
    PUMPFUN_ENABLE_MAX_SOL_FILTER,
    PUMPFUN_MIN_SCORE_REQUIRED,
    PUMPFUN_DETECTION_COOLDOWN_MS,
    MAX_TOKEN_AGE_SECONDS,
    // Sniper gate
    SNIPER_GATE_ENABLED,
    SNIPER_GATE_INITIAL_DELAY_MS,
    SNIPER_GATE_RECHECK_INTERVAL_MS,
    SNIPER_GATE_MAX_CHECKS,
    SNIPER_GATE_SNIPER_SLOT_THRESHOLD,
    SNIPER_GATE_MIN_BOT_EXIT_PERCENT,
    SNIPER_GATE_MIN_ORGANIC_BUYERS,
    SNIPER_GATE_LOG_ONLY,
    SNIPER_GATE_SIGNATURE_LIMIT,
    // Stable gate
    STABLE_GATE_ENABLED,
    STABLE_GATE_LOG_ONLY,
    STABLE_GATE_MAX_RETRIES,
    STABLE_GATE_RETRY_DELAY_SECONDS,
    STABLE_GATE_PRICE_SNAPSHOTS,
    STABLE_GATE_SNAPSHOT_INTERVAL_MS,
    STABLE_GATE_MAX_PRICE_DROP_PERCENT,
    STABLE_GATE_MIN_SOL_IN_CURVE,
    STABLE_GATE_MAX_SELL_RATIO,
    // Research score gate (from config)
    RESEARCH_SCORE_GATE_ENABLED: config.researchScoreGateEnabled,
    RESEARCH_SCORE_THRESHOLD: config.researchScoreThreshold,
    RESEARCH_SCORE_CHECKPOINT: config.researchScoreCheckpoint,
    RESEARCH_SCORE_LOG_ONLY: config.researchScoreLogOnly,
    // Trailing stop
    TRAILING_STOP_ENABLED,
    TRAILING_STOP_ACTIVATION_PERCENT,
    TRAILING_STOP_DISTANCE_PERCENT,
    HARD_TAKE_PROFIT_PERCENT,
    COST_ADJUSTED_EXITS,
    MAX_PRICE_DRIFT_PERCENT,
    // Transaction extras
    CUSTOM_FEE: CUSTOM_FEE || 0,
    JITO_BUNDLE_TIMEOUT,
    JITO_BUNDLE_POLL_INTERVAL,
    // Test config
    SMOKE_TEST_TIMEOUT_MS,
    SMOKE_TEST_RUNS,
    // Hypothesis
    RUN_HYPOTHESIS: config.runHypothesis || '',
  };

  const report: SmokeTestReport = {
    startedAt,
    completedAt,
    totalDurationMs: completedAt - startedAt,
    steps,
    overallResult,
    walletBalanceBefore: walletBefore,
    walletBalanceAfter: walletAfter,
    netCostSol,
    passedCount,
    failedCount,
    totalSteps,
    exitTrigger: exitTrigger || undefined,
    buyFailures,
    tokensEvaluated,
    tokensPipelinePassed,
    actualSolSpentOnBuy,
    buyOverheadSol: buyOverhead,
    tradedToken,
    buyTimestamp,
    sellTimestamp,
    buySignature,
    sellSignature,
    sellSolReceived,
    tradeReturnSol,
    feeBreakdown,
    pnlPercentWithOverhead,
    pnlPercentWithoutOverhead,
    slippage,
    priceHistory,
    highWaterMarkPercent,
    holdDurationMs,
    tradeEfficiencyScore,
    envSnapshot,
    runNumber: currentRunNumber,
    totalRuns: currentTotalRuns,
    gateRejections: extras?.gateRejections,
    pipelineRejections: extras?.pipelineRejections,
    gateStats: extras?.gateStats,
    boughtTokenPipelineData: extras?.boughtTokenPipelineData,
    runPipelineStats: extras?.runPipelineStats,
  };

  // Store for dashboard retrieval (in-memory + persisted to file)
  lastReport = report;
  persistReport(report);

  // Print the formatted report
  const totalSecs = (report.totalDurationMs / 1000).toFixed(1);
  const netCost = report.netCostSol.toFixed(6);

  logger.info('');
  logger.info('════════════════════════════════════════════════════════════');
  const runTag = currentTotalRuns > 1 ? ` (Run ${currentRunNumber}/${currentTotalRuns})` : '';
  logger.info(`  SMOKE TEST REPORT${runTag}`);
  logger.info('════════════════════════════════════════════════════════════');
  logger.info(`  Result:          ${overallResult} (${passedCount}/${totalSteps} steps)`);
  logger.info(`  Duration:        ${totalSecs}s`);
  logger.info(`  Net cost:        ${netCost} SOL`);
  logger.info(`  Wallet:          ${walletBefore.toFixed(4)} -> ${walletAfter.toFixed(4)} SOL`);
  if (report.actualSolSpentOnBuy !== undefined) {
    const overhead = report.buyOverheadSol ?? 0;
    logger.info(`  Buy cost:        ${report.actualSolSpentOnBuy.toFixed(6)} SOL (trade: ${(report.actualSolSpentOnBuy - overhead).toFixed(6)}, overhead: ${overhead.toFixed(6)})`);
  }
  if (report.sellSolReceived !== undefined) {
    logger.info(`  Sell received:   ${report.sellSolReceived.toFixed(6)} SOL`);
  }
  if (report.tradeReturnSol !== undefined) {
    const sign = report.tradeReturnSol >= 0 ? '+' : '';
    logger.info(`  Trade return:    ${sign}${report.tradeReturnSol.toFixed(6)} SOL (ex-overhead)`);
  }
  if (report.pnlPercentWithOverhead !== undefined) {
    const sign = report.pnlPercentWithOverhead >= 0 ? '+' : '';
    logger.info(`  Return % (all-in): ${sign}${report.pnlPercentWithOverhead.toFixed(2)}%`);
  }
  if (report.pnlPercentWithoutOverhead !== undefined) {
    const sign = report.pnlPercentWithoutOverhead >= 0 ? '+' : '';
    logger.info(`  Return % (trade):  ${sign}${report.pnlPercentWithoutOverhead.toFixed(2)}%`);
  }
  if (report.feeBreakdown) {
    const fb = report.feeBreakdown;
    logger.info(`  Fee breakdown (all-in):`);
    logger.info(`    Buy overhead:    ${fb.buyOverhead.toFixed(6)} SOL (gas+priority+tip+rent)`);
    logger.info(`    Sell overhead:   ${fb.sellOverhead.toFixed(6)} SOL (gas+priority+tip)`);
    logger.info(`    Wallet overhead: ${fb.walletOverhead.toFixed(6)} SOL (measured)`);
    logger.info(`    Pump buy fee:    ~${fb.estimatedPumpBuyFee.toFixed(6)} SOL (~1%%, estimated)`);
    logger.info(`    Pump sell fee:   ~${fb.estimatedPumpSellFee.toFixed(6)} SOL (~1.25%%, estimated)`);
    if (fb.bundleExecutorActive) {
      const buyExec = fb.buyExecutorUsed ?? 'unknown';
      const sellExec = fb.sellExecutorUsed ?? 'unknown';
      const bothJito = buyExec === 'jito' && sellExec === 'jito';
      const tipStatus = bothJito
        ? 'SENT via Jito bundle'
        : `buy: ${buyExec}, sell: ${sellExec}`;
      logger.info(`    ${fb.executorType} tip/tx:  ${fb.jitoTipPerTx.toFixed(6)} SOL (${tipStatus})`);
    } else {
      logger.info(`    Jito tip/tx:     ${fb.jitoTipPerTx.toFixed(6)} SOL (configured, NOT sent — set TRANSACTION_EXECUTOR=jito)`);
    }
    logger.info(`    Total overhead:  ${fb.totalOverhead.toFixed(6)} SOL (wallet + protocol fees)`);
  }
  if (exitTrigger) {
    logger.info(`  Exit trigger:    ${exitTrigger}`);
  }
  logger.info(`  Tokens seen:     ${tokensEvaluated}`);
  logger.info(`  Pipeline passed: ${tokensPipelinePassed}`);
  if (buyFailures.length > 0) {
    logger.info(`  Buy failures:    ${buyFailures.length}`);
  }
  logger.info('');

  logger.info('  Steps:');
  for (const step of steps) {
    const statusTag = step.status === 'passed' ? 'PASS'
      : step.status === 'failed' ? 'FAIL'
      : step.status === 'skipped' ? 'SKIP'
      : '----';

    const durationStr = step.durationMs > 0 ? `${step.durationMs}ms` : '-';
    const paddedName = step.name.padEnd(20);
    const paddedDuration = durationStr.padStart(8);

    logger.info(`  [${statusTag}] ${paddedName} ${paddedDuration}  ${step.details}`);
  }

  if (buyFailures.length > 0) {
    logger.info('');
    logger.info('  Buy Failures:');
    for (let i = 0; i < buyFailures.length; i++) {
      const f = buyFailures[i];
      logger.info(`    ${i + 1}. ${f.tokenSymbol} (${f.tokenMint.substring(0, 12)}...): ${f.reason}`);
    }
  }

  logger.info('');
  logger.info('════════════════════════════════════════════════════════════');
  logger.info('');

  return report;
}
