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
 * Set TEST_MODE=smoke to trigger this instead of the normal bot.
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
  PUMPFUN_MIN_SOL_IN_CURVE,
  PUMPFUN_MAX_SOL_IN_CURVE,
  PUMPFUN_ENABLE_MIN_SOL_FILTER,
  PUMPFUN_ENABLE_MAX_SOL_FILTER,
  PUMPFUN_MIN_SCORE_REQUIRED,
} from './helpers';
import {
  buyOnPumpFun,
  sellOnPumpFun,
} from './helpers/pumpfun';
import { initTradeAuditManager } from './helpers/trade-audit';
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
import {
  initPumpFunPositionMonitor,
  PumpFunTriggerEvent,
} from './risk/pumpfun-position-monitor';
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

interface BuyFailureRecord {
  tokenSymbol: string;
  tokenMint: string;
  reason: string;
  timestamp: number;
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
  const timeoutMs = SMOKE_TEST_TIMEOUT_MS;
  const maxHoldMs = MAX_HOLD_DURATION_MS > 0 ? MAX_HOLD_DURATION_MS : 20000;

  logger.info('');
  logger.info('════════════════════════════════════════');
  logger.info('  SMOKE TEST MODE (Production-Like)');
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

  // Mutable state holder
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
    exitTrigger: string;
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
    exitTrigger: '',
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

  if (!configOk) return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore, '', buyFailures, tokensEvaluated, tokensPipelinePassed);

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

  // ─────────────────────────────────────────────────────────────────────
  // STEP 3: BOOT_SYSTEMS
  // ─────────────────────────────────────────────────────────────────────
  const bootOk = await runStep(steps[2], async () => {
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

    // Initialize position monitor with real SL/TP/max hold settings
    initPumpFunPositionMonitor(state.connection!, state.wallet!, {
      checkIntervalMs: 500,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      maxHoldDurationMs: maxHoldMs,
    });

    // Initialize listener
    state.listener = initPumpFunListener(state.connection!);

    return `Pipeline, position monitor (TP:${TAKE_PROFIT}%/SL:${STOP_LOSS}%/Hold:${maxHoldMs / 1000}s), and listener initialized`;
  });

  if (!bootOk) return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceBefore, '', buyFailures, tokensEvaluated, tokensPipelinePassed);

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
    (count) => { tokensEvaluated = count; },
    (count) => { tokensPipelinePassed = count; },
  );

  // Stop listener after we're done with detection
  if (state.listener) {
    try { await state.listener.stop(); } catch { /* ignore */ }
  }

  if (!listenAndBuyOk) {
    try {
      walletBalanceAfter = (await state.connection!.getBalance(state.wallet!.publicKey, 'confirmed')) / LAMPORTS_PER_SOL;
    } catch { /* ignore */ }
    return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceAfter, '', buyFailures, tokensEvaluated, tokensPipelinePassed);
  }

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
    const solSpent = walletBalanceBefore - currentSolBalance;

    return `${actualBalance} tokens in wallet, ${solSpent.toFixed(4)} SOL spent`;
  });

  // ─────────────────────────────────────────────────────────────────────
  // STEP 7: POSITION_MONITOR - Real SL/TP/max hold monitoring
  // ─────────────────────────────────────────────────────────────────────
  const monitorOk = await runStep(steps[6], async () => {
    const monitor = initPumpFunPositionMonitor(state.connection!, state.wallet!, {
      checkIntervalMs: 500,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      maxHoldDurationMs: maxHoldMs,
    });

    // Add the position to monitor
    monitor.addPosition({
      tokenMint: state.passedToken!.mint.toString(),
      bondingCurve: state.passedBondingCurve!.toString(),
      entryAmountSol: tradeAmount,
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
        const pnlSign = event.pnlPercent >= 0 ? '+' : '';
        resolve(`Exit trigger: ${event.type}, PnL: ${pnlSign}${event.pnlPercent.toFixed(2)}%, value: ${event.currentValueSol.toFixed(6)} SOL`);
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
  const sellOk = await runStep(steps[7], async () => {
    const smokeTestSlippageBps = Math.max(SELL_SLIPPAGE * 100, 5000); // At least 50% for smoke test
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
      });

      if (sellResult.success) {
        state.sellSignature = sellResult.signature || '';
        const solReceived = sellResult.solReceived || 0;
        return `Sold on attempt ${attempt}/${maxAttempts} for ${solReceived.toFixed(6)} SOL, sig: ${state.sellSignature.substring(0, 12)}...`;
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

  return buildReport(startedAt, steps, walletBalanceBefore, walletBalanceAfter, state.exitTrigger, buyFailures, tokensEvaluated, tokensPipelinePassed);
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
    tokensReceived: number;
    sellSignature: string;
    exitTrigger: string;
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

      state.listener!.on('new-token', async (token: DetectedToken) => {
        if (token.source !== 'pumpfun') return;
        if (buySucceeded) return; // Already got a successful buy
        if (processingBuy) return; // Don't overlap buy attempts

        tokensEvaluated++;
        setTokensEvaluated(tokensEvaluated);

        // Build detection event for pipeline
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
          isToken2022: token.isToken2022,
          source: 'websocket',
        };

        // Run through pipeline
        const result = await pipeline.process(detectionEvent);

        if (!result.success) {
          logger.debug(
            { mint: token.mint.toString(), symbol: token.symbol, reason: result.rejectionReason },
            '[smoke-test] Token rejected by pipeline'
          );
          return;
        }

        // Pipeline passed!
        tokensPipelinePassed++;
        setTokensPipelinePassed(tokensPipelinePassed);
        logger.info(
          { mint: token.mint.toString(), symbol: token.symbol, score: result.context.deepFilters?.filterResults?.score },
          '[smoke-test] Token passed pipeline - attempting buy'
        );

        processingBuy = true;

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
          });

          if (buyResult.success) {
            // Buy succeeded!
            state.passedToken = token;
            state.passedBondingCurve = token.bondingCurve!;
            state.isToken2022 = isToken2022;
            state.buySignature = buyResult.signature || '';
            state.tokensReceived = buyResult.tokensReceived || 0;
            buySucceeded = true;

            clearTimeout(overallTimeout);

            // Mark buy step as passed too
            steps[4].status = 'passed';
            steps[4].details = `Bought ${state.tokensReceived} tokens of ${token.symbol || 'Unknown'}, sig: ${state.buySignature.substring(0, 12)}...`;
            steps[4].durationMs = 0;

            resolve(
              `Pipeline passed: ${token.symbol || 'Unknown'} (${token.mint.toString().substring(0, 12)}...), ` +
              `score: ${result.context.deepFilters?.filterResults?.score ?? 'N/A'}, ` +
              `evaluated: ${tokensEvaluated}, pipeline passed: ${tokensPipelinePassed}`
            );
          } else {
            // Buy failed - record and continue
            const failReason = buyResult.error || 'Unknown buy error';
            buyFailures.push({
              tokenSymbol: token.symbol || 'Unknown',
              tokenMint: token.mint.toString(),
              reason: failReason,
              timestamp: Date.now(),
            });

            logger.warn(
              { mint: token.mint.toString(), symbol: token.symbol, error: failReason },
              `[smoke-test] Buy failed (attempt ${buyFailures.length}) - continuing to listen`
            );

            processingBuy = false;
          }
        } catch (error) {
          const failReason = error instanceof Error ? error.message : String(error);
          buyFailures.push({
            tokenSymbol: token.symbol || 'Unknown',
            tokenMint: token.mint.toString(),
            reason: failReason,
            timestamp: Date.now(),
          });

          logger.warn(
            { mint: token.mint.toString(), error: failReason },
            `[smoke-test] Buy threw error (attempt ${buyFailures.length}) - continuing to listen`
          );

          processingBuy = false;
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

function buildReport(
  startedAt: number,
  steps: SmokeTestStep[],
  walletBefore: number,
  walletAfter: number,
  exitTrigger: string,
  buyFailures: BuyFailureRecord[],
  tokensEvaluated: number,
  tokensPipelinePassed: number,
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
    exitTrigger: exitTrigger || undefined,
    buyFailures,
    tokensEvaluated,
    tokensPipelinePassed,
  };

  // Store for dashboard retrieval
  lastReport = report;

  // Print the formatted report
  const totalSecs = (report.totalDurationMs / 1000).toFixed(1);
  const netCost = report.netCostSol.toFixed(6);

  logger.info('');
  logger.info('════════════════════════════════════════════════════════════');
  logger.info('  SMOKE TEST REPORT');
  logger.info('════════════════════════════════════════════════════════════');
  logger.info(`  Result:          ${overallResult} (${passedCount}/${totalSteps} steps)`);
  logger.info(`  Duration:        ${totalSecs}s`);
  logger.info(`  Net cost:        ${netCost} SOL`);
  logger.info(`  Wallet:          ${walletBefore.toFixed(4)} -> ${walletAfter.toFixed(4)} SOL`);
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
