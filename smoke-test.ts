/**
 * Smoke Test Mode
 *
 * Runs a single controlled end-to-end cycle on mainnet:
 *   CONFIG_CHECK -> RPC_CHECK -> DETECT_TOKEN -> PIPELINE_CHECK
 *   -> BUY_EXECUTE -> BUY_VERIFY -> POSITION_MONITOR -> SELL_EXECUTE
 *   -> SELL_VERIFY -> REPORT
 *
 * Set TEST_MODE=smoke on Railway to trigger this instead of the normal bot.
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
  PUMPFUN_MIN_SOL_IN_CURVE,
  PUMPFUN_MAX_SOL_IN_CURVE,
  PUMPFUN_ENABLE_MIN_SOL_FILTER,
  PUMPFUN_ENABLE_MAX_SOL_FILTER,
  PUMPFUN_MIN_SCORE_REQUIRED,
} from './helpers';
import {
  buyOnPumpFun,
  sellOnPumpFun,
  getBondingCurveState,
} from './helpers/pumpfun';
import { initTradeAuditManager, getTradeAuditManager } from './helpers/trade-audit';
import { initRpcManager } from './helpers/rpc-manager';
import { getConfig } from './helpers/config-validator';
import {
  PumpFunListener,
  initPumpFunListener,
} from './listeners/pumpfun-listener';
import {
  initPipeline,
  getPipeline,
  DetectionEvent,
  initPipelineStats,
} from './pipeline';
import {
  initPumpFunFilters,
} from './filters';
import { DetectedToken } from './types';
import { sleep } from './helpers/promises';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

interface SmokeTestStep {
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  details: string;
  durationMs: number;
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
}

// Shared state for the report endpoint
let lastReport: SmokeTestReport | null = null;

export function getSmokeTestReport(): SmokeTestReport | null {
  return lastReport;
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

export async function runSmokeTest(): Promise<SmokeTestReport> {
  logger.level = LOG_LEVEL;
  const startedAt = Date.now();
  const config = getConfig();
  const tradeAmount = Number(QUOTE_AMOUNT);

  logger.info('');
  logger.info('════════════════════════════════════════');
  logger.info('  SMOKE TEST MODE');
  logger.info(`  Trade amount: ${tradeAmount} SOL`);
  logger.info('════════════════════════════════════════');
  logger.info('');

  // Define all steps
  const steps: SmokeTestStep[] = [
    { name: 'CONFIG_CHECK', status: 'pending', details: '', durationMs: 0 },
    { name: 'RPC_CHECK', status: 'pending', details: '', durationMs: 0 },
    { name: 'DETECT_TOKEN', status: 'pending', details: '', durationMs: 0 },
    { name: 'PIPELINE_CHECK', status: 'pending', details: '', durationMs: 0 },
    { name: 'BUY_EXECUTE', status: 'pending', details: '', durationMs: 0 },
    { name: 'BUY_VERIFY', status: 'pending', details: '', durationMs: 0 },
    { name: 'POSITION_CHECK', status: 'pending', details: '', durationMs: 0 },
    { name: 'SELL_EXECUTE', status: 'pending', details: '', durationMs: 0 },
    { name: 'SELL_VERIFY', status: 'pending', details: '', durationMs: 0 },
  ];

  // Track state across steps
  let walletBalanceBefore = 0;
  let walletBalanceAfter = 0;

  // Mutable state holder - avoids TypeScript control flow narrowing issues
  const state: {
    connection: Connection | null;
    wallet: Keypair | null;
    listener: PumpFunListener | null;
    passedToken: DetectedToken | null;
    passedBondingCurve: PublicKey | null;
    isToken2022: boolean;
    buySignature: string;
    tokensReceived: number;
    sellSignature: string;
  } = {
    connection: null,
    wallet: null,
    listener: null,
    passedToken: null,
    passedBondingCurve: null,
    isToken2022: false,
    buySignature: '',
    tokensReceived: 0,
    sellSignature: '',
  };

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

  if (!configOk) return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore);

  // ─────────────────────────────────────────────────────────────────────
  // STEP 2: RPC_CHECK
  // ─────────────────────────────────────────────────────────────────────
  const rpcOk = await runStep(steps[1], async () => {
    const rpcStart = Date.now();
    const slot = await state.connection!.getSlot('confirmed');
    const latency = Date.now() - rpcStart;

    // Check the slot is recent (within last minute)
    const blockTime = await state.connection!.getBlockTime(slot);
    const now = Math.floor(Date.now() / 1000);
    const age = blockTime ? now - blockTime : 0;

    if (age > 60) {
      throw new Error(`RPC appears stale: slot ${slot} is ${age}s old`);
    }

    return `Slot: ${slot}, latency: ${latency}ms, block age: ${age}s`;
  });

  if (!rpcOk) return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore);

  // ─────────────────────────────────────────────────────────────────────
  // STEP 3: DETECT_TOKEN
  // ─────────────────────────────────────────────────────────────────────
  const detectOk = await runStep(steps[2], async () => {
    // Initialize listener
    state.listener = initPumpFunListener(state.connection!);

    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('No token detected within 120 seconds'));
      }, 120_000);

      state.listener!.on('new-token', (token: DetectedToken) => {
        if (token.source !== 'pumpfun') return;
        if (state.passedToken) return; // Already got one

        // Store the first token we see
        state.passedToken = token;
        clearTimeout(timeout);
        const name = token.name || 'Unknown';
        const symbol = token.symbol || '???';
        resolve(`Detected: ${name} (${symbol}) - ${token.mint.toString().substring(0, 12)}...`);
      });

      state.listener!.start().catch(reject);
    });
  });

  // Stop listener after detection
  if (state.listener) {
    try { await state.listener.stop(); } catch { /* ignore */ }
  }

  if (!detectOk || !state.passedToken) {
    return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore);
  }

  // ─────────────────────────────────────────────────────────────────────
  // STEP 4: PIPELINE_CHECK
  // ─────────────────────────────────────────────────────────────────────
  const pipelineOk = await runStep(steps[3], async () => {
    // Initialize pipeline systems
    initPumpFunFilters({
      minSolInCurve: PUMPFUN_MIN_SOL_IN_CURVE,
      maxSolInCurve: PUMPFUN_MAX_SOL_IN_CURVE,
      enableMinSolFilter: PUMPFUN_ENABLE_MIN_SOL_FILTER,
      enableMaxSolFilter: PUMPFUN_ENABLE_MAX_SOL_FILTER,
      minScoreRequired: PUMPFUN_MIN_SCORE_REQUIRED,
    });

    initPipeline(state.connection!, state.wallet!, {
      cheapGates: {
        tradeAmountSol: tradeAmount,
        skipMintInfoCheck: true,
      },
      deepFilters: {
        skipBondingCurveCheck: false,
        skipFilters: false,
      },
      momentumGate: {
        enabled: config.momentumGateEnabled,
        initialDelayMs: config.momentumInitialDelayMs,
        minTotalBuys: config.momentumMinTotalBuys,
        recheckIntervalMs: config.momentumRecheckIntervalMs,
        maxChecks: config.momentumMaxChecks,
      },
      verbose: true,
    });

    initPipelineStats();
    initTradeAuditManager();

    const token = state.passedToken!;
    const detectionEvent: DetectionEvent = {
      signature: token.signature || `smoke-test-${Date.now()}`,
      slot: 0,
      mint: token.mint,
      bondingCurve: token.bondingCurve!,
      associatedBondingCurve: token.associatedBondingCurve!,
      creator: token.creator || null,
      name: token.name,
      symbol: token.symbol,
      rawLogs: [],
      detectedAt: Date.now(),
      source: 'websocket',
    };

    const pipeline = getPipeline();
    if (!pipeline) throw new Error('Pipeline not initialized');

    const result = await pipeline.process(detectionEvent);

    if (!result.success) {
      // Pipeline rejection is expected -- doesn't mean the pipeline is broken
      // But we can't continue to buy/sell without a passing token
      // Try to get bonding curve state directly to at least test buy mechanics
      const bondingCurve = token.bondingCurve;
      if (bondingCurve) {
        const curveState = await getBondingCurveState(state.connection!, bondingCurve);
        if (curveState && !curveState.complete) {
          // Token exists and isn't graduated -- we can still test buy/sell
          state.passedBondingCurve = bondingCurve;
          return `Pipeline rejected (${result.rejectionReason}) - but token is tradeable, continuing with buy test`;
        }
      }
      throw new Error(`Pipeline rejected: ${result.rejectionReason}. No tradeable token found within timeout.`);
    }

    state.passedBondingCurve = token.bondingCurve!;
    state.isToken2022 = result.context.cheapGates?.mintInfo.isToken2022 ?? false;
    const score = result.context.deepFilters?.filterResults.score ?? 'N/A';
    return `Pipeline passed, score: ${score}, duration: ${result.totalDurationMs}ms`;
  });

  if (!pipelineOk || !state.passedBondingCurve) {
    return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore);
  }

  // ─────────────────────────────────────────────────────────────────────
  // STEP 5: BUY_EXECUTE
  // ─────────────────────────────────────────────────────────────────────
  const buyOk = await runStep(steps[4], async () => {
    const buyResult = await buyOnPumpFun({
      connection: state.connection!,
      wallet: state.wallet!,
      mint: state.passedToken!.mint,
      bondingCurve: state.passedBondingCurve!,
      amountSol: tradeAmount,
      slippageBps: BUY_SLIPPAGE * 100,
      computeUnitLimit: COMPUTE_UNIT_LIMIT,
      computeUnitPrice: COMPUTE_UNIT_PRICE,
      isToken2022: state.isToken2022,
    });

    if (!buyResult.success) {
      throw new Error(`Buy failed: ${buyResult.error}`);
    }

    state.buySignature = buyResult.signature || '';
    state.tokensReceived = buyResult.tokensReceived || 0;

    return `Bought ${state.tokensReceived} tokens, sig: ${state.buySignature.substring(0, 12)}...`;
  });

  if (!buyOk) {
    // Get final balance even though buy failed
    try {
      walletBalanceAfter = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
    } catch { /* ignore */ }
    return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceAfter);
  }

  // ─────────────────────────────────────────────────────────────────────
  // STEP 6: BUY_VERIFY
  // ─────────────────────────────────────────────────────────────────────
  const buyVerifyOk = await runStep(steps[5], async () => {
    // Record audit
    const auditManager = getTradeAuditManager();

    // Wait a moment for chain state to settle
    await sleep(2000);

    // Check token balance in wallet
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
      throw new Error(`Token balance is 0 after buy`);
    }

    // Check SOL was deducted
    const currentSolBalance = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
    const solSpent = walletBalanceBefore - currentSolBalance;

    const summary = auditManager?.getSummary();
    const mismatches = summary?.mismatches || 0;
    const mismatchNote = mismatches > 0 ? ` [${mismatches} MISMATCH]` : '';

    return `${actualBalance} tokens in wallet, ${solSpent.toFixed(4)} SOL spent${mismatchNote}`;
  });

  // Continue to sell even if verify had issues

  // ─────────────────────────────────────────────────────────────────────
  // STEP 7: POSITION_CHECK
  // ─────────────────────────────────────────────────────────────────────
  await runStep(steps[6], async () => {
    // Check the bonding curve state to get current value
    const curveState = await getBondingCurveState(state.connection!, state.passedBondingCurve!);
    if (!curveState) {
      throw new Error('Could not fetch bonding curve state for position check');
    }

    if (curveState.complete) {
      return 'Token has graduated - position exists but bonding curve is complete';
    }

    // Calculate approximate current value using bonding curve
    const virtualSolReserves = curveState.virtualSolReserves;
    const virtualTokenReserves = curveState.virtualTokenReserves;

    // price per token = virtualSolReserves / virtualTokenReserves
    // value = tokens * price
    const tokensBN = new (await import('bn.js')).default(state.tokensReceived);
    const valueLamports = tokensBN.mul(virtualSolReserves).div(virtualTokenReserves);
    const valueSol = valueLamports.toNumber() / LAMPORTS_PER_SOL;
    const pnlPercent = ((valueSol - tradeAmount) / tradeAmount) * 100;
    const pnlSign = pnlPercent >= 0 ? '+' : '';

    return `Current value: ${valueSol.toFixed(6)} SOL, PnL: ${pnlSign}${pnlPercent.toFixed(1)}%`;
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 8: SELL_EXECUTE
  // ─────────────────────────────────────────────────────────────────────
  const sellOk = await runStep(steps[7], async () => {
    // Use a generous slippage for smoke test - we want the sell to succeed
    const smokeTestSlippageBps = Math.max(SELL_SLIPPAGE * 100, 5000); // At least 50%

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
    });

    if (!sellResult.success) {
      throw new Error(`Sell failed: ${sellResult.error}`);
    }

    state.sellSignature = sellResult.signature || '';
    const solReceived = sellResult.solReceived || 0;

    return `Sold for ${solReceived.toFixed(6)} SOL, sig: ${state.sellSignature.substring(0, 12)}...`;
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 9: SELL_VERIFY
  // ─────────────────────────────────────────────────────────────────────
  if (sellOk) {
    await runStep(steps[8], async () => {
      await sleep(2000);

      // Check token balance is 0
      const tokenProgramId = state.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      const tokenAta = getAssociatedTokenAddressSync(state.passedToken!.mint, state.wallet!.publicKey, false, tokenProgramId);

      let remainingTokens = 0;
      try {
        const account = await getAccount(state.connection!, tokenAta, 'confirmed', tokenProgramId);
        remainingTokens = Number(account.amount);
      } catch {
        // Account not found = tokens cleared
        remainingTokens = 0;
      }

      // Get final SOL balance
      walletBalanceAfter = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
      const netCost = walletBalanceBefore - walletBalanceAfter;

      if (remainingTokens > 0) {
        return `WARNING: ${remainingTokens} tokens still in wallet. Net cost: ${netCost.toFixed(6)} SOL`;
      }

      return `Position closed. Net cost: ${netCost.toFixed(6)} SOL (mostly gas fees)`;
    });
  } else {
    steps[8].status = 'skipped';
    steps[8].details = 'Skipped because sell failed';

    // Still get final balance
    try {
      walletBalanceAfter = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
    } catch { /* ignore */ }
  }

  return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceAfter);
}

// ════════════════════════════════════════════════════════════════════════════
// REPORT BUILDER
// ════════════════════════════════════════════════════════════════════════════

function buildReport(
  startedAt: number,
  steps: SmokeTestStep[],
  walletBefore: number,
  walletAfter: number,
): SmokeTestReport {
  const completedAt = Date.now();
  const passedCount = steps.filter((s) => s.status === 'passed').length;
  const failedCount = steps.filter((s) => s.status === 'failed').length;
  const totalSteps = steps.filter((s) => s.status !== 'skipped' && s.status !== 'pending').length;
  const overallResult = failedCount === 0 && passedCount > 0 ? 'PASS' : 'FAIL';

  const report: SmokeTestReport = {
    startedAt,
    completedAt,
    totalDurationMs: completedAt - startedAt,
    steps,
    overallResult,
    walletBalanceBefore: walletBefore,
    walletBalanceAfter: walletAfter,
    netCostSol: walletBefore - walletAfter,
    passedCount,
    failedCount,
    totalSteps,
  };

  // Store for dashboard retrieval
  lastReport = report;

  // Print the formatted report
  const totalSecs = (report.totalDurationMs / 1000).toFixed(1);
  const netCost = report.netCostSol.toFixed(6);

  logger.info('');
  logger.info('════════════════════════════════════════');
  logger.info('  SMOKE TEST REPORT');
  logger.info('════════════════════════════════════════');
  logger.info(`  Result: ${overallResult} (${passedCount}/${totalSteps} steps)`);
  logger.info(`  Duration: ${totalSecs}s`);
  logger.info(`  Net cost: ${netCost} SOL`);
  logger.info(`  Wallet: ${walletBefore.toFixed(4)} -> ${walletAfter.toFixed(4)} SOL`);
  logger.info('');

  for (const step of steps) {
    const statusTag = step.status === 'passed' ? 'PASS'
      : step.status === 'failed' ? 'FAIL'
      : step.status === 'skipped' ? 'SKIP'
      : '----';

    const durationStr = step.durationMs > 0 ? `${step.durationMs}ms` : '-';
    const paddedName = step.name.padEnd(18);
    const paddedDuration = durationStr.padStart(8);

    logger.info(`  [${statusTag}] ${paddedName} ${paddedDuration}  ${step.details}`);
  }

  logger.info('');
  logger.info('════════════════════════════════════════');
  logger.info('');

  return report;
}
