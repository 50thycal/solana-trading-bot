import { initMintCache, getMintCache } from './cache';
import {
  PumpFunListener,
  initPumpFunListener,
  getPumpFunListener,
} from './listeners/pumpfun-listener';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { DetectedToken, getSourceDisplayName } from './types';
import { getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor, TransactionExecutor, FallbackTransactionExecutor } from './transactions';
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
  ONE_TOKEN_AT_A_TIME,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  AUTO_SELL,
  MAX_BUY_RETRIES,
  AUTO_BUY_DELAY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  TAKE_PROFIT,
  STOP_LOSS,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  PRICE_CHECK_INTERVAL,
  PRICE_CHECK_DURATION,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  DRY_RUN,
  HEALTH_PORT,
  MAX_TOTAL_EXPOSURE_SOL,
  MAX_TRADES_PER_HOUR,
  MIN_WALLET_BUFFER_SOL,
  MAX_HOLD_DURATION_MS,
  USE_FALLBACK_EXECUTOR,
  MAX_TOKEN_AGE_SECONDS,
  PUMPFUN_MIN_SOL_IN_CURVE,
  PUMPFUN_MAX_SOL_IN_CURVE,
  PUMPFUN_ENABLE_MIN_SOL_FILTER,
  PUMPFUN_ENABLE_MAX_SOL_FILTER,
  PUMPFUN_MIN_SCORE_REQUIRED,
  RUN_BOT,
} from './helpers';
import {
  buyOnPumpFun,
} from './helpers/pumpfun';
import { initTradeAuditManager, getTradeAuditManager } from './helpers/trade-audit';
import { initLogSummarizer, getLogSummarizer } from './helpers/log-summarizer';
import { initRpcManager } from './helpers/rpc-manager';
import { startDashboardServer, DashboardServer } from './dashboard';
import { version } from './package.json';
import { getConfig } from './helpers/config-validator';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import {
  getBlacklist,
  initExposureManager,
  getExposureManager,
  getPnlTracker,
  initPumpFunPositionMonitor,
  getPumpFunPositionMonitor,
  PumpFunTriggerEvent,
  initPaperTradeTracker,
  getPaperTradeTracker,
} from './risk';
import {
  initStateStore,
  getStateStore,
  closeStateStore,
} from './persistence';
import {
  initPumpFunFilters,
} from './filters';
import {
  initPipeline,
  getPipeline,
  DetectionEvent,
  initPipelineStats,
  getPipelineStats,
} from './pipeline';

// ============================================================================
// CONFIGURATION
// ============================================================================
const MAX_OPEN_POSITIONS = 5; // Max concurrent positions
const POSITION_CHECK_INTERVAL_MS = 500; // Check every 0.5 seconds

// Global references for graceful shutdown
let pumpFunListener: PumpFunListener | null = null;
let dashboardServer: DashboardServer | null = null;
let bot: Bot | null = null;
let isShuttingDown = false;

/**
 * Initialize RPC Manager with failover support
 */
function initializeRpcManager(): Connection {
  const rpcManager = initRpcManager({
    primaryEndpoint: RPC_ENDPOINT,
    primaryWsEndpoint: RPC_WEBSOCKET_ENDPOINT,
    backupEndpoints: RPC_BACKUP_ENDPOINTS,
    commitment: COMMITMENT_LEVEL,
  });

  return rpcManager.getConnection();
}

/**
 * Print bot configuration details
 */
function printDetails(wallet: Keypair, bot: Bot) {
  logger.info(`
                                        ..   :-===++++-
                                .-==+++++++- =+++++++++-
            ..:::--===+=.=:     .+++++++++++:=+++++++++:
    .==+++++++++++++++=:+++:    .+++++++++++.=++++++++-.
    .-+++++++++++++++=:=++++-   .+++++++++=:.=+++++-::-.
     -:+++++++++++++=:+++++++-  .++++++++-:- =+++++=-:
      -:++++++=++++=:++++=++++= .++++++++++- =+++++:
       -:++++-:=++=:++++=:-+++++:+++++====--:::::::.
        ::=+-:::==:=+++=::-:--::::::::::---------::.
         ::-:  .::::::::.  --------:::..
          :-    .:.-:::.

          PUMP.FUN TRADING BOT
          Version: ${version}
  `);

  const botConfig = bot.config;

  logger.info('------- CONFIGURATION START -------');

  // Mode indicator
  if (DRY_RUN) {
    logger.warn('*** DRY RUN MODE - Transactions will be logged but NOT executed ***');
  } else {
    logger.info('*** LIVE TRADING MODE ***');
  }

  logger.info(`Wallet: ${wallet.publicKey.toString()}`);
  logger.info('Mode: pump.fun ONLY');

  logger.info('- Bot -');
  logger.info(`Using ${TRANSACTION_EXECUTOR} executor`);
  if (bot.isWarp || bot.isJito) {
    logger.info(`${TRANSACTION_EXECUTOR} fee: ${CUSTOM_FEE}`);
  } else {
    logger.info(`Compute Unit limit: ${botConfig.unitLimit}`);
    logger.info(`Compute Unit price (micro lamports): ${botConfig.unitPrice}`);
  }

  logger.info('- Buy -');
  logger.info(`Buy amount: ${botConfig.quoteAmount} SOL`);
  logger.info(`Auto buy delay: ${botConfig.autoBuyDelay} ms`);
  logger.info(`Max buy retries: ${botConfig.maxBuyRetries}`);
  logger.info(`Buy slippage: ${botConfig.buySlippage}%`);

  logger.info('- Sell -');
  logger.info(`Auto sell: ${botConfig.autoSell}`);
  logger.info(`Sell slippage: ${botConfig.sellSlippage}%`);
  logger.info(`Take profit: ${botConfig.takeProfit}%`);
  logger.info(`Stop loss: ${botConfig.stopLoss}%`);

  logger.info('- Position Management -');
  logger.info(`Max open positions: ${botConfig.maxOpenPositions}`);
  logger.info(`Max hold duration: ${botConfig.maxHoldDurationMs > 0 ? `${botConfig.maxHoldDurationMs / 1000}s` : 'disabled'}`);
  logger.info(`Price check interval: ${POSITION_CHECK_INTERVAL_MS}ms`);

  logger.info('- Risk Controls -');
  logger.info(`Max total exposure: ${MAX_TOTAL_EXPOSURE_SOL} SOL`);
  logger.info(`Max trades per hour: ${MAX_TRADES_PER_HOUR}`);
  logger.info(`Min wallet buffer: ${MIN_WALLET_BUFFER_SOL} SOL`);

  logger.info('- pump.fun Filters -');
  logger.info(`Min SOL in curve: ${PUMPFUN_MIN_SOL_IN_CURVE}`);
  logger.info(`Max SOL in curve: ${PUMPFUN_MAX_SOL_IN_CURVE}`);

  logger.info('------- CONFIGURATION END -------');

  logger.info('Bot is running! Press CTRL + C to stop it.');
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.info('Shutdown already in progress...');
    return;
  }

  isShuttingDown = true;
  logger.info({ signal }, 'Received shutdown signal, cleaning up...');

  try {
    // Stop pump.fun position monitor
    const pumpFunMonitor = getPumpFunPositionMonitor();
    if (pumpFunMonitor) {
      logger.info('Stopping pump.fun position monitor...');
      pumpFunMonitor.stop();
    }

    // Stop paper trade monitor (dry run mode)
    const paperTracker = getPaperTradeTracker();
    if (paperTracker) {
      logger.info('Stopping paper trade monitor...');
      paperTracker.stop();
    }

    // Stop pump.fun listener
    if (pumpFunListener) {
      logger.info('Stopping pump.fun listener...');
      await pumpFunListener.stop();
    }

    // Stop mint cache cleanup
    const mintCacheInstance = getMintCache();
    if (mintCacheInstance) {
      mintCacheInstance.stop();
    }

    // Save P&L data
    const pnlTracker = getPnlTracker();
    logger.info('Saving P&L data...');
    await pnlTracker.forceSave();
    pnlTracker.logSessionSummary();

    // Stop dashboard server
    if (dashboardServer) {
      logger.info('Stopping dashboard server...');
      await dashboardServer.stop();
    }

    // Close state store (SQLite)
    logger.info('Closing state store...');
    closeStateStore();

    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

/**
 * Get count of currently open positions
 */
function getOpenPositionCount(): number {
  const pumpFunMonitor = getPumpFunPositionMonitor();
  if (pumpFunMonitor) {
    return pumpFunMonitor.getPositions().length;
  }

  // Also check paper trade tracker in dry run mode
  const paperTracker = getPaperTradeTracker();
  if (paperTracker) {
    return paperTracker.getActiveTradeCount();
  }

  return 0;
}

/**
 * Main bot entry point
 */
const runListener = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Bot is starting...');

  // Get config for dashboard settings
  const config = getConfig();

  // Start dashboard server early (includes health endpoints)
  if (config.dashboardEnabled) {
    try {
      dashboardServer = await startDashboardServer({
        port: config.dashboardPort,
        pollInterval: config.dashboardPollInterval,
      });
      logger.info({ port: config.dashboardPort }, 'Dashboard server started');
    } catch (error) {
      logger.error({ error }, 'Failed to start dashboard server');
    }
  }

  // === RUN_BOT Gate ===
  // When RUN_BOT=false, skip all RPC-consuming work. The dashboard/health
  // server stays alive so Railway doesn't restart the service.
  if (!RUN_BOT) {
    logger.info('RUN_BOT is set to false - bot is in standby mode');
    logger.info('Set RUN_BOT=true and restart to resume trading.');
    if (!dashboardServer) {
      // Keep the process alive even without dashboard, so Railway doesn't restart
      setInterval(() => {
        logger.debug('Standby heartbeat - RUN_BOT=false');
      }, 60_000);
    }
    return;
  }

  // Initialize RPC Manager with failover
  const connection = initializeRpcManager();

  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(CUSTOM_FEE, connection);
      break;
    }
    case 'jito': {
      const jitoExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);

      if (USE_FALLBACK_EXECUTOR) {
        const defaultExecutor = new DefaultTransactionExecutor(connection);
        txExecutor = new FallbackTransactionExecutor(
          jitoExecutor,
          defaultExecutor,
          'jito',
          'default',
        );
        logger.info('Transaction executor: Jito with Default RPC fallback');
      } else {
        txExecutor = jitoExecutor;
      }
      break;
    }
    default: {
      txExecutor = new DefaultTransactionExecutor(connection);
      break;
    }
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const tradeAmount = Number(QUOTE_AMOUNT);

  const botConfig: BotConfig = {
    wallet,
    quoteAmount: tradeAmount,
    oneTokenAtATime: ONE_TOKEN_AT_A_TIME,
    autoSell: AUTO_SELL,
    autoSellDelay: AUTO_SELL_DELAY,
    maxSellRetries: MAX_SELL_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    maxBuyRetries: MAX_BUY_RETRIES,
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,
    takeProfit: TAKE_PROFIT,
    stopLoss: STOP_LOSS,
    buySlippage: BUY_SLIPPAGE,
    sellSlippage: SELL_SLIPPAGE,
    priceCheckInterval: PRICE_CHECK_INTERVAL,
    priceCheckDuration: PRICE_CHECK_DURATION,
    maxOpenPositions: MAX_OPEN_POSITIONS,
    maxHoldDurationMs: MAX_HOLD_DURATION_MS > 0 ? MAX_HOLD_DURATION_MS : 180000, // Default 3 min
  };

  bot = new Bot(connection, txExecutor, botConfig);
  const valid = await bot.validate();

  if (!valid) {
    logger.info('Bot is exiting...');
    process.exit(1);
  }

  // === Initialize Persistence Layer ===
  logger.info('Initializing persistence layer...');
  const stateStore = initStateStore();

  if (stateStore) {
    const dbStats = stateStore.getStats();
    logger.info(
      {
        openPositions: dbStats.positions.open,
        closedPositions: dbStats.positions.closed,
        confirmedTrades: dbStats.trades.confirmed,
        seenPools: dbStats.seenPools,
      },
      'State store initialized',
    );
  } else {
    logger.warn('State store NOT available - running without persistence');
  }

  // === Initialize pump.fun Filters ===
  initPumpFunFilters({
    minSolInCurve: PUMPFUN_MIN_SOL_IN_CURVE,
    maxSolInCurve: PUMPFUN_MAX_SOL_IN_CURVE,
    enableMinSolFilter: PUMPFUN_ENABLE_MIN_SOL_FILTER,
    enableMaxSolFilter: PUMPFUN_ENABLE_MAX_SOL_FILTER,
    minScoreRequired: PUMPFUN_MIN_SCORE_REQUIRED,
  });
  logger.info(
    {
      minSolInCurve: PUMPFUN_MIN_SOL_IN_CURVE,
      maxSolInCurve: PUMPFUN_MAX_SOL_IN_CURVE,
    },
    'pump.fun filters initialized'
  );

  // === Initialize Risk Systems ===
  logger.info('Initializing risk control systems...');

  const blacklist = getBlacklist();
  await blacklist.init();

  initExposureManager(connection, wallet.publicKey, {
    maxTotalExposureSol: MAX_TOTAL_EXPOSURE_SOL,
    maxTradesPerHour: MAX_TRADES_PER_HOUR,
    minWalletBufferSol: MIN_WALLET_BUFFER_SOL,
  });

  const pnlTracker = getPnlTracker();
  await pnlTracker.init();

  // === Initialize pump.fun Pipeline ===
  initPipeline(connection, wallet, {
    cheapGates: {
      tradeAmountSol: tradeAmount,
      skipMintInfoCheck: true, // pump.fun tokens are safe by design
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
    verbose: LOG_LEVEL === 'debug' || LOG_LEVEL === 'trace',
  });
  logger.info('[pipeline] pump.fun processing pipeline initialized');

  initPipelineStats();

  // === Initialize Trade Audit ===
  initTradeAuditManager();

  // === Initialize Log Summarizer ===
  initLogSummarizer();

  // === Initialize Position Monitoring ===
  // In DRY_RUN mode, use paper trade tracker
  // In LIVE mode, use pump.fun position monitor
  if (DRY_RUN) {
    const paperTracker = initPaperTradeTracker(connection, {
      checkIntervalMs: POSITION_CHECK_INTERVAL_MS,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      maxHoldDurationMs: botConfig.maxHoldDurationMs,
      enabled: true,
    });
    paperTracker.start();
    logger.info(
      {
        checkInterval: `${POSITION_CHECK_INTERVAL_MS}ms`,
        takeProfit: `${TAKE_PROFIT}%`,
        stopLoss: `${STOP_LOSS}%`,
        maxHoldDuration: `${botConfig.maxHoldDurationMs / 1000}s`,
      },
      '[paper-trade] Paper trade tracker initialized'
    );
  }

  // Always initialize pump.fun position monitor (for live trades + recovery)
  const pumpFunMonitor = initPumpFunPositionMonitor(connection, wallet, {
    checkIntervalMs: POSITION_CHECK_INTERVAL_MS,
    takeProfit: TAKE_PROFIT,
    stopLoss: STOP_LOSS,
    maxHoldDurationMs: botConfig.maxHoldDurationMs,
  });

  pumpFunMonitor.on('trigger', async (event: PumpFunTriggerEvent) => {
    logger.info(
      {
        type: event.type,
        tokenMint: event.position.tokenMint,
        pnlPercent: `${event.pnlPercent >= 0 ? '+' : ''}${event.pnlPercent.toFixed(2)}%`,
        currentValue: `${event.currentValueSol.toFixed(4)} SOL`,
        reason: event.reason,
      },
      `[pump.fun] Position trigger: ${event.type}`,
    );
  });

  pumpFunMonitor.on('sell-complete', (data: { tokenMint: string; signature: string; exitValueSol: number; pnlPercent: number; reason: string }) => {
    logger.info(
      {
        mint: data.tokenMint,
        signature: data.signature,
        exitValueSol: data.exitValueSol.toFixed(4),
        pnlPercent: `${data.pnlPercent >= 0 ? '+' : ''}${data.pnlPercent.toFixed(2)}%`,
        reason: data.reason,
      },
      '[pump.fun] Position sell complete',
    );
  });

  // === Startup Recovery ===
  if (stateStore) {
    const openPositions = stateStore.getOpenPositions();
    if (openPositions.length > 0) {
      logger.info({ count: openPositions.length }, 'Recovering open positions from database...');

      for (const position of openPositions) {
        try {
          const tokenMint = new PublicKey(position.tokenMint);
          const tokenAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);

          try {
            const tokenAccount = await getAccount(connection, tokenAta, COMMITMENT_LEVEL);
            const tokenBalance = Number(tokenAccount.amount);

            if (tokenBalance > 0) {
              logger.info(
                {
                  tokenMint: position.tokenMint,
                  entryAmountSol: position.amountSol,
                  tokenBalance,
                },
                'Resuming position monitoring',
              );

              if (position.amountToken === 0) {
                stateStore.updatePositionTokenAmount(position.tokenMint, tokenBalance);
              }

              const expManager = getExposureManager();
              if (expManager) {
                expManager.addPosition({
                  tokenMint: position.tokenMint,
                  entryAmountSol: position.amountSol,
                  currentValueSol: position.lastPriceSol || position.amountSol,
                  entryTimestamp: position.entryTimestamp,
                  poolId: position.poolId,
                });
              }
            } else {
              logger.info({ tokenMint: position.tokenMint }, 'Token no longer in wallet, closing position');
              stateStore.closePosition(position.tokenMint, 'Token not in wallet on recovery');
            }
          } catch {
            logger.info({ tokenMint: position.tokenMint }, 'Token account not found, closing position');
            stateStore.closePosition(position.tokenMint, 'Token account not found on recovery');
          }
        } catch (error) {
          logger.error({ tokenMint: position.tokenMint, error }, 'Error recovering position');
        }
      }

      logger.info('Position recovery complete');
    }
  }

  // Start position monitor (only for live mode - paper tracker already started above)
  if (!DRY_RUN) {
    pumpFunMonitor.start();
    logger.info('[pump.fun] Live position monitor started');
  }

  // === Initialize Mint Cache ===
  initMintCache(MAX_TOKEN_AGE_SECONDS);

  // === Start pump.fun Listener ===
  pumpFunListener = initPumpFunListener(connection);

  pumpFunListener.on('error', (error) => {
    logger.error({ error }, 'pump.fun listener error');
  });

  if (dashboardServer) {
    pumpFunListener.on('started', () => {
      dashboardServer!.setWebSocketConnected(true);
      dashboardServer!.setRpcHealthy(true);
    });

    pumpFunListener.on('stopped', () => {
      dashboardServer!.setWebSocketConnected(false);
    });
  }

  await pumpFunListener.start();
  logger.info('pump.fun token detection listener started');

  // ══════════════════════════════════════════════════════════════════════════════
  // PUMP.FUN 'new-token' HANDLER
  // Flow: Detection → Pipeline (Cheap Gates + Deep Filters) → Execute Buy
  // ══════════════════════════════════════════════════════════════════════════════
  pumpFunListener.on('new-token', async (token: DetectedToken) => {
    if (token.source !== 'pumpfun') {
      return;
    }

    if (dashboardServer) {
      dashboardServer.recordWebSocketActivity();
    }

    const baseMintStr = token.mint.toString();
    const bondingCurveStr = token.bondingCurve?.toString() || 'unknown';
    const stateStore = getStateStore();

    // ═══════════════ POSITION LIMIT CHECK ═══════════════
    const openCount = getOpenPositionCount();
    if (openCount >= MAX_OPEN_POSITIONS) {
      logger.debug(
        { current: openCount, max: MAX_OPEN_POSITIONS, mint: baseMintStr },
        '[pump.fun] Max positions reached, skipping'
      );
      return;
    }

    logger.info(
      {
        mint: baseMintStr,
        name: token.name || 'Unknown',
        symbol: token.symbol || 'Unknown',
        bondingCurve: bondingCurveStr,
        openPositions: openCount,
      },
      '[pump.fun] New token detected'
    );

    // ═══════════════ PIPELINE PROCESSING ═══════════════
    const detectionEvent: DetectionEvent = {
      signature: token.signature || `detection-${Date.now()}`,
      slot: 0,
      mint: token.mint,
      bondingCurve: token.bondingCurve!,
      associatedBondingCurve: token.associatedBondingCurve!,
      creator: token.creator || null,
      name: token.name,
      symbol: token.symbol,
      rawLogs: token.rawLogs || [],
      detectedAt: Date.now(),
      source: 'websocket',
    };

    const pipeline = getPipeline();
    if (!pipeline) {
      logger.error({ mint: baseMintStr }, '[pump.fun] Pipeline not initialized');
      return;
    }

    const pipelineResult = await pipeline.process(detectionEvent);

    const pipelineStats = getPipelineStats();
    if (pipelineStats) {
      pipelineStats.recordResult(pipelineResult);
    }

    // Feed log summarizer
    const summarizer = getLogSummarizer();
    if (summarizer) {
      summarizer.recordTokenDetected();
      if (pipelineResult.success) {
        summarizer.recordTokenPassed();
      } else {
        summarizer.recordTokenRejected(pipelineResult.rejectionReason || 'unknown');
      }
    }

    if (!pipelineResult.success) {
      if (stateStore) {
        stateStore.recordSeenPool({
          poolId: bondingCurveStr,
          tokenMint: baseMintStr,
          actionTaken: 'filtered',
          filterReason: pipelineResult.rejectionReason || 'Pipeline rejected',
        });
        stateStore.recordPoolDetection({
          poolId: bondingCurveStr,
          tokenMint: baseMintStr,
          action: 'filtered',
          poolType: 'pumpfun',
          filterResults: pipelineResult.stageResults.map((s) => ({
            name: s.stage,
            displayName: s.stage,
            passed: s.pass,
            checked: true,
            reason: s.reason,
            expectedValue: '',
            actualValue: '',
          })),
          riskCheckPassed: false,
          riskCheckReason: pipelineResult.rejectionReason,
          summary: `[pipeline] Rejected at ${pipelineResult.rejectedAt}: ${pipelineResult.rejectionReason}`,
        });
      }
      return;
    }

    // ═══════════════ EXECUTE BUY ═══════════════
    const { context } = pipelineResult;
    const bondingCurveState = context.deepFilters?.bondingCurveState;

    if (!bondingCurveState) {
      logger.error({ mint: baseMintStr }, '[pump.fun] No bonding curve state after pipeline');
      return;
    }

    logger.info(
      {
        mint: baseMintStr,
        name: token.name || 'Unknown',
        symbol: token.symbol || 'Unknown',
        score: context.deepFilters?.filterResults.score,
        pipelineDurationMs: pipelineResult.totalDurationMs,
        amountSol: tradeAmount,
      },
      '[pump.fun] Pipeline passed - executing buy'
    );

    if (stateStore) {
      stateStore.recordSeenPool({
        poolId: bondingCurveStr,
        tokenMint: baseMintStr,
        actionTaken: 'buy_attempted',
      });
    }

    if (DRY_RUN) {
      logger.info(
        { mint: baseMintStr, amountSol: tradeAmount },
        '[pump.fun] DRY RUN - would have bought token'
      );

      const paperTracker = getPaperTradeTracker();
      if (paperTracker && pipelineResult.context.deepFilters?.bondingCurveState) {
        paperTracker.recordPaperTrade({
          mint: token.mint,
          bondingCurve: token.bondingCurve!,
          bondingCurveState: pipelineResult.context.deepFilters.bondingCurveState,
          hypotheticalSolSpent: tradeAmount,
          name: token.name,
          symbol: token.symbol,
          signature: token.signature || 'unknown',
          pipelineDurationMs: pipelineResult.totalDurationMs,
        });
      }

      if (stateStore) {
        stateStore.recordPoolDetection({
          poolId: bondingCurveStr,
          tokenMint: baseMintStr,
          action: 'bought',
          poolType: 'pumpfun',
          filterResults: [],
          riskCheckPassed: true,
          summary: '[pump.fun] DRY RUN - simulated buy',
        });
      }
    } else {
      // ═══════════════ LIVE BUY ═══════════════
      const isToken2022 = context.cheapGates?.mintInfo.isToken2022 ?? false;

      if (summarizer) summarizer.recordBuyAttempt();

      const buyResult = await buyOnPumpFun({
        connection,
        wallet,
        mint: token.mint,
        bondingCurve: token.bondingCurve!,
        amountSol: tradeAmount,
        slippageBps: BUY_SLIPPAGE * 100,
        computeUnitLimit: COMPUTE_UNIT_LIMIT,
        computeUnitPrice: COMPUTE_UNIT_PRICE,
        isToken2022,
      });

      if (buyResult.success) {
        logger.info(
          {
            mint: baseMintStr,
            signature: buyResult.signature,
            tokensReceived: buyResult.tokensReceived,
            amountSol: tradeAmount,
            verified: buyResult.actualVerified,
          },
          '[pump.fun] Buy successful'
        );

        if (buyResult.actualVerified && buyResult.slippagePercent !== undefined) {
          const slippageSign = buyResult.slippagePercent >= 0 ? '+' : '';
          logger.info(
            {
              mint: baseMintStr,
              expectedTokens: buyResult.expectedTokens,
              actualTokens: buyResult.tokensReceived,
              slippagePercent: `${slippageSign}${buyResult.slippagePercent.toFixed(2)}%`,
            },
            '[pump.fun] Trade verification complete'
          );
        }

        // Record trade audit
        const auditManager = getTradeAuditManager();
        if (auditManager) {
          const auditRecord = auditManager.recordBuy({
            tokenMint: baseMintStr,
            tokenSymbol: token.symbol || 'Unknown',
            intendedAmountSol: tradeAmount,
            instructionAmountLamports: buyResult.instructionAmountLamports || Math.floor(tradeAmount * 1e9),
            actualSolSpent: buyResult.actualSolSpent ?? null,
            actualTokensReceived: buyResult.tokensReceived ?? null,
            expectedTokens: buyResult.expectedTokens ?? null,
            verificationMethod: buyResult.verificationMethod || 'none',
            verified: buyResult.actualVerified,
            tokenSlippagePercent: buyResult.slippagePercent ?? null,
            signature: buyResult.signature || '',
            bondingCurve: bondingCurveStr,
          });

          // Wire verification alerts to log summarizer
          if (auditRecord.hasMismatch && summarizer) {
            summarizer.recordVerificationAlert();
          }
        }

        if (summarizer) summarizer.recordBuySuccess();

        // Record position
        const entryTimestamp = Date.now();

        pnlTracker.recordBuy({
          tokenMint: baseMintStr,
          amountSol: tradeAmount,
          amountToken: buyResult.tokensReceived || 0,
          txSignature: buyResult.signature || '',
          poolId: bondingCurveStr,
        });

        if (stateStore) {
          const tokensReceived = buyResult.tokensReceived || 0;
          const entryPrice = tokensReceived > 0 ? tradeAmount / tokensReceived : 0;
          stateStore.createPosition({
            tokenMint: baseMintStr,
            poolId: bondingCurveStr,
            amountSol: tradeAmount,
            amountToken: tokensReceived,
            entryPrice,
          });

          stateStore.recordPoolDetection({
            poolId: bondingCurveStr,
            tokenMint: baseMintStr,
            action: 'bought',
            poolType: 'pumpfun',
            filterResults: [],
            riskCheckPassed: true,
            summary: `[pump.fun] Buy successful: ${buyResult.tokensReceived} tokens for ${tradeAmount} SOL`,
          });
        }

        const exposureManager = getExposureManager();
        if (exposureManager) {
          exposureManager.addPosition({
            tokenMint: baseMintStr,
            entryAmountSol: tradeAmount,
            currentValueSol: tradeAmount,
            entryTimestamp,
            poolId: bondingCurveStr,
          });
        }

        // Add to position monitor for TP/SL monitoring
        pumpFunMonitor.addPosition({
          tokenMint: baseMintStr,
          bondingCurve: bondingCurveStr,
          entryAmountSol: tradeAmount,
          tokenAmount: buyResult.tokensReceived || 0,
          entryTimestamp,
          buySignature: buyResult.signature || '',
          isToken2022,
        });

        logger.info(
          {
            mint: baseMintStr,
            signature: buyResult.signature,
            tokensReceived: buyResult.tokensReceived,
            amountSol: tradeAmount,
          },
          '[pump.fun] Position recorded - monitoring for sell triggers'
        );
      } else {
        if (summarizer) {
          summarizer.recordBuyFailure();
          summarizer.recordError(`Buy failed: ${buyResult.error || 'unknown'}`);
        }

        logger.error(
          {
            mint: baseMintStr,
            error: buyResult.error,
          },
          '[pump.fun] Buy failed'
        );

        if (stateStore) {
          stateStore.recordPoolDetection({
            poolId: bondingCurveStr,
            tokenMint: baseMintStr,
            action: 'buy_failed',
            poolType: 'pumpfun',
            filterResults: [],
            riskCheckPassed: true,
            riskCheckReason: buyResult.error,
            summary: `[pump.fun] Buy failed: ${buyResult.error}`,
          });
        }
      }
    }
  });

  // Update health server status
  if (dashboardServer) {
    dashboardServer.setRpcHealthy(true);
  }

  printDetails(wallet, bot!);

  // Periodic heartbeat
  const heartbeatIntervalMs = 5 * 60 * 1000;
  setInterval(() => {
    const stateStore = getStateStore();
    const dbStats = stateStore?.getStats();
    const pumpFunPlatformStats = pumpFunListener?.getPlatformStats();
    const pumpfun = pumpFunPlatformStats || { detected: 0, isNew: 0, tokenTooOld: 0, buyAttempted: 0, errors: 0 };
    const monitorStats = pumpFunMonitor.getStats();
    const mintCacheStats = getMintCache().getStats();

    logger.info(
      {
        pumpfun,
        positions: {
          open: monitorStats.positionCount,
          unrealizedPnl: monitorStats.unrealizedPnl.toFixed(4),
          unrealizedPnlPercent: monitorStats.unrealizedPnlPercent.toFixed(2) + '%',
        },
        mintCache: {
          size: mintCacheStats.size,
          hitRate: (mintCacheStats.hitRate * 100).toFixed(1) + '%',
        },
        seenPools: dbStats?.seenPools || 0,
        openPositions: dbStats?.positions.open || 0,
        mode: DRY_RUN ? 'PAPER' : 'LIVE',
      },
      `Heartbeat: Detected=${pumpfun.detected} New=${pumpfun.isNew} Bought=${pumpfun.buyAttempted} | Positions: ${monitorStats.positionCount} | Mode: ${DRY_RUN ? 'PAPER' : 'LIVE'}`
    );

    pumpFunListener?.resetStats();

    // Update log summarizer snapshot
    const summarizer = getLogSummarizer();
    if (summarizer) {
      summarizer.updateSnapshot(monitorStats.positionCount, null);
    }
  }, heartbeatIntervalMs);
};

// Register graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});

// Start the bot
runListener().catch((error) => {
  logger.error({ error }, 'Failed to start bot');
  process.exit(1);
});
