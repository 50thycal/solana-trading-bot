import { MarketCache, PoolCache, initMintCache, getMintCache } from './cache';
import { Listeners, initMintListener, getMintListener, MintListener } from './listeners';
import {
  PumpFunListener,
  PumpFunToken,
  initPumpFunListener,
  getPumpFunListener,
} from './listeners/pumpfun-listener';
import { Connection, KeyedAccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor, TransactionExecutor, FallbackTransactionExecutor } from './transactions';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  RPC_BACKUP_ENDPOINTS,
  PRE_LOAD_EXISTING_MARKETS,
  LOG_LEVEL,
  CHECK_IF_MUTABLE,
  CHECK_IF_MINT_IS_RENOUNCED,
  CHECK_IF_FREEZABLE,
  CHECK_IF_BURNED,
  QUOTE_MINT,
  MAX_POOL_SIZE,
  MIN_POOL_SIZE,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  USE_SNIPE_LIST,
  ONE_TOKEN_AT_A_TIME,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  AUTO_SELL,
  MAX_BUY_RETRIES,
  AUTO_BUY_DELAY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  CACHE_NEW_MARKETS,
  ENABLE_CPMM,
  TAKE_PROFIT,
  STOP_LOSS,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  SNIPE_LIST_REFRESH_INTERVAL,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  FILTER_CHECK_INTERVAL,
  FILTER_CHECK_DURATION,
  CONSECUTIVE_FILTER_MATCHES,
  DRY_RUN,
  FILTER_PRESET,
  HEALTH_PORT,
  MAX_TOTAL_EXPOSURE_SOL,
  MAX_TRADES_PER_HOUR,
  MIN_WALLET_BUFFER_SOL,
  MAX_HOLD_DURATION_MS,
  USE_FALLBACK_EXECUTOR,
  SIMULATE_TRANSACTION,
  logFilterPresetInfo,
  CpmmPoolInfoLayout,
  ENABLE_DLMM,
  decodeDlmmPoolState,
  isDlmmPoolActivated,
  getTokenAge,
  MAX_TOKEN_AGE_SECONDS,
  ENABLE_TOKEN_AGE_CHECK,
  ENABLE_HELIUS_MINT_DETECTION,
  ENABLE_PUMPFUN_DETECTION,
  DEXSCREENER_FALLBACK_ENABLED,
} from './helpers';
import { verifyTokenAge } from './services/dexscreener';
import {
  deriveBondingCurve,
  getBondingCurveState,
  buyOnPumpFun,
} from './helpers/pumpfun';
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
  initPositionMonitor,
  getPositionMonitor,
  TriggerEvent,
} from './risk';
import {
  initStateStore,
  getStateStore,
  closeStateStore,
} from './persistence';

// Global references for graceful shutdown
let listeners: Listeners | null = null;
let mintListener: MintListener | null = null;
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
function printDetails(wallet: Keypair, quoteToken: Token, bot: Bot) {
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

          WARP DRIVE ACTIVATED
          Made with love by humans.
          Version: ${version}
  `);

  const botConfig = bot.config;

  logger.info('------- CONFIGURATION START -------');

  // Mode indicator
  if (DRY_RUN) {
    logger.warn('*** DRY RUN MODE - Transactions will be logged but NOT executed ***');
  }

  logger.info(`Wallet: ${wallet.publicKey.toString()}`);

  logger.info('- Bot -');

  logger.info(
    `Using ${TRANSACTION_EXECUTOR} executor: ${bot.isWarp || bot.isJito || (TRANSACTION_EXECUTOR === 'default' ? true : false)}`,
  );
  if (bot.isWarp || bot.isJito) {
    logger.info(`${TRANSACTION_EXECUTOR} fee: ${CUSTOM_FEE}`);
  } else {
    logger.info(`Compute Unit limit: ${botConfig.unitLimit}`);
    logger.info(`Compute Unit price (micro lamports): ${botConfig.unitPrice}`);
  }

  logger.info(`Single token at the time: ${botConfig.oneTokenAtATime}`);
  logger.info(`Pre load existing markets: ${PRE_LOAD_EXISTING_MARKETS}`);
  logger.info(`Cache new markets: ${CACHE_NEW_MARKETS}`);
  logger.info(`CPMM pools enabled: ${ENABLE_CPMM}`);
  logger.info(`DLMM pools enabled: ${ENABLE_DLMM}`);
  logger.info(`Log level: ${LOG_LEVEL}`);
  logger.info(`Health check port: ${HEALTH_PORT}`);

  logger.info('- Buy -');
  logger.info(`Buy amount: ${botConfig.quoteAmount.toFixed()} ${botConfig.quoteToken.name}`);
  logger.info(`Auto buy delay: ${botConfig.autoBuyDelay} ms`);
  logger.info(`Max buy retries: ${botConfig.maxBuyRetries}`);
  logger.info(`Buy slippage: ${botConfig.buySlippage}%`);

  logger.info('- Sell -');
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Auto sell delay: ${botConfig.autoSellDelay} ms`);
  logger.info(`Max sell retries: ${botConfig.maxSellRetries}`);
  logger.info(`Sell slippage: ${botConfig.sellSlippage}%`);
  logger.info(`Price check interval: ${botConfig.priceCheckInterval} ms`);
  logger.info(`Price check duration: ${botConfig.priceCheckDuration} ms`);
  logger.info(`Take profit: ${botConfig.takeProfit}%`);
  logger.info(`Stop loss: ${botConfig.stopLoss}%`);

  logger.info('- Snipe list -');
  logger.info(`Snipe list: ${botConfig.useSnipeList}`);
  logger.info(`Snipe list refresh interval: ${SNIPE_LIST_REFRESH_INTERVAL} ms`);

  if (botConfig.useSnipeList) {
    logger.info('- Filters -');
    logger.info(`Filters are disabled when snipe list is on`);
  } else {
    logger.info('- Filters -');
    logger.info(`Filter preset: ${FILTER_PRESET}`);
    logFilterPresetInfo();
    logger.info(`Filter check interval: ${botConfig.filterCheckInterval} ms`);
    logger.info(`Filter check duration: ${botConfig.filterCheckDuration} ms`);
    logger.info(`Consecutive filter matches: ${botConfig.consecutiveMatchCount}`);
  }

  logger.info('- Risk Controls -');
  logger.info(`Max total exposure: ${MAX_TOTAL_EXPOSURE_SOL} SOL`);
  logger.info(`Max trades per hour: ${MAX_TRADES_PER_HOUR}`);
  logger.info(`Min wallet buffer: ${MIN_WALLET_BUFFER_SOL} SOL`);
  logger.info(`Max hold duration: ${MAX_HOLD_DURATION_MS > 0 ? `${MAX_HOLD_DURATION_MS}ms` : 'disabled'}`);
  logger.info(`Persistent stop-loss monitoring: enabled`);

  logger.info('- Execution Quality -');
  logger.info(`Transaction simulation: ${SIMULATE_TRANSACTION}`);
  logger.info(`Fallback executor: ${USE_FALLBACK_EXECUTOR && TRANSACTION_EXECUTOR === 'jito' ? 'enabled' : 'disabled'}`);

  logger.info('- Mint Detection (Phase 0) -');
  logger.info(`Helius mint detection: ${ENABLE_HELIUS_MINT_DETECTION ? 'enabled' : 'disabled'}`);
  logger.info(`Token age validation: ${ENABLE_TOKEN_AGE_CHECK ? 'enabled' : 'disabled'}`);
  logger.info(`Max token age: ${MAX_TOKEN_AGE_SECONDS}s`);

  logger.info('- Token Monitoring (Phase 1) -');
  logger.info(`pump.fun detection: ${ENABLE_PUMPFUN_DETECTION ? 'enabled' : 'disabled'}`);
  logger.info(`DexScreener fallback: ${DEXSCREENER_FALLBACK_ENABLED ? 'enabled' : 'disabled'}`);

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
    // Stop position monitor first
    const positionMonitor = getPositionMonitor();
    if (positionMonitor) {
      logger.info('Stopping position monitor...');
      positionMonitor.stop();
    }

    // Stop listeners
    if (listeners) {
      logger.info('Stopping WebSocket listeners...');
      await listeners.stop();
    }

    // Stop mint listener
    if (mintListener) {
      logger.info('Stopping mint detection listener...');
      await mintListener.stop();
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
      // Continue without dashboard - not critical for bot operation
    }
  }

  // Initialize RPC Manager with failover
  const connection = initializeRpcManager();

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(CUSTOM_FEE, connection);
      break;
    }
    case 'jito': {
      const jitoExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);

      // Wrap Jito executor with fallback to default RPC if enabled
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
  const quoteToken = getToken(QUOTE_MINT);
  const botConfig = <BotConfig>{
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
    checkRenounced: CHECK_IF_MINT_IS_RENOUNCED,
    checkFreezable: CHECK_IF_FREEZABLE,
    checkBurned: CHECK_IF_BURNED,
    checkMutable: CHECK_IF_MUTABLE,
    minPoolSize: new TokenAmount(quoteToken, MIN_POOL_SIZE, false),
    maxPoolSize: new TokenAmount(quoteToken, MAX_POOL_SIZE, false),
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    oneTokenAtATime: ONE_TOKEN_AT_A_TIME,
    useSnipeList: USE_SNIPE_LIST,
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
    filterCheckInterval: FILTER_CHECK_INTERVAL,
    filterCheckDuration: FILTER_CHECK_DURATION,
    consecutiveMatchCount: CONSECUTIVE_FILTER_MATCHES,
  };

  bot = new Bot(connection, marketCache, poolCache, txExecutor, botConfig);
  const valid = await bot.validate();

  if (!valid) {
    logger.info('Bot is exiting...');
    process.exit(1);
  }

  // === Initialize Persistence Layer (Phase 3) ===
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
        blacklist: dbStats.blacklist,
      },
      'State store initialized',
    );
  } else {
    logger.warn('State store NOT available - running without persistence');
  }

  // === Initialize Risk Systems (Phase 2) ===
  logger.info('Initializing risk control systems...');

  // Initialize blacklist (now uses SQLite)
  const blacklist = getBlacklist();
  await blacklist.init();

  // Initialize exposure manager
  initExposureManager(connection, wallet.publicKey, {
    maxTotalExposureSol: MAX_TOTAL_EXPOSURE_SOL,
    maxTradesPerHour: MAX_TRADES_PER_HOUR,
    minWalletBufferSol: MIN_WALLET_BUFFER_SOL,
  });

  // Initialize P&L tracker (now uses SQLite)
  const pnlTracker = getPnlTracker();
  await pnlTracker.init();

  // Initialize position monitor (independent monitoring loop)
  const positionMonitor = initPositionMonitor(connection, quoteToken, {
    checkIntervalMs: PRICE_CHECK_INTERVAL,
    takeProfit: TAKE_PROFIT,
    stopLoss: STOP_LOSS,
    maxHoldDurationMs: MAX_HOLD_DURATION_MS,
  });

  // Set up position monitor trigger handler
  positionMonitor.on('trigger', async (event: TriggerEvent) => {
    logger.info(
      {
        type: event.type,
        tokenMint: event.position.tokenMint,
        pnlPercent: `${event.pnlPercent >= 0 ? '+' : ''}${event.pnlPercent.toFixed(2)}%`,
        currentValue: `${event.currentValueSol.toFixed(4)} SOL`,
      },
      `Position trigger: ${event.type}`,
    );

    // The sell will be triggered by wallet balance change detection
    // Position monitor just logs the trigger, the wallet listener handles the actual sell
    // This is because the sell needs the actual token balance from the wallet
  });

  // === Startup Recovery (Phase 3) ===
  // Load open positions from database and verify they still exist in wallet
  if (stateStore) {
    const openPositions = stateStore.getOpenPositions();
    if (openPositions.length > 0) {
      logger.info({ count: openPositions.length }, 'Recovering open positions from database...');

      for (const position of openPositions) {
        try {
          // Verify token is still in wallet by checking balance
          const tokenMint = new PublicKey(position.tokenMint);
          const tokenAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey);

          try {
            const tokenAccount = await getAccount(connection, tokenAta, COMMITMENT_LEVEL);
            const tokenBalance = Number(tokenAccount.amount);

            if (tokenBalance > 0) {
              // Token still in wallet, resume monitoring
              logger.info(
                {
                  tokenMint: position.tokenMint,
                  entryAmountSol: position.amountSol,
                  tokenBalance,
                },
                'Resuming position monitoring',
              );

              // Update position with current token amount if we have it
              if (position.amountToken === 0) {
                stateStore.updatePositionTokenAmount(position.tokenMint, tokenBalance);
              }

              // We need pool keys to monitor - we'll need to fetch pool data
              // For now, we'll add to exposure manager and the position will be
              // picked up when the wallet listener fires on any balance change
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
              // Token no longer in wallet, close position
              logger.info({ tokenMint: position.tokenMint }, 'Token no longer in wallet, closing position');
              stateStore.closePosition(position.tokenMint, 'Token not in wallet on recovery');
            }
          } catch (tokenError) {
            // Token account doesn't exist, close position
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

  // Start position monitor
  positionMonitor.start();
  logger.info('Risk control systems initialized');

  // === Initialize Mint Detection (Phase 0) ===
  // Initialize mint cache with TTL from config
  initMintCache(MAX_TOKEN_AGE_SECONDS);
  logger.info({ ttlSeconds: MAX_TOKEN_AGE_SECONDS }, 'Mint cache initialized');

  // Start mint listener if enabled
  if (ENABLE_HELIUS_MINT_DETECTION) {
    mintListener = initMintListener(connection);

    mintListener.on('mint-detected', (mint, signature, source) => {
      logger.debug(
        { mint: mint.toString(), signature, source },
        'Mint detected event received'
      );
    });

    mintListener.on('error', (error) => {
      logger.error({ error }, 'Mint listener error');
    });

    await mintListener.start();
    logger.info('Helius mint detection listener started');
  } else {
    logger.info('Helius mint detection disabled - using fallback token age validation');
  }

  // === Initialize pump.fun Detection (Token Monitoring Phase 1) ===
  if (ENABLE_PUMPFUN_DETECTION) {
    pumpFunListener = initPumpFunListener(connection);

    pumpFunListener.on('token-created', async (token: PumpFunToken) => {
      poolDetectionStats.pumpfun.detected++;
      poolDetectionStats.pumpfun.isNew++;

      logger.info(
        {
          mint: token.mint.toString(),
          name: token.name || 'Unknown',
          symbol: token.symbol || 'Unknown',
          bondingCurve: token.bondingCurve.toString(),
          creator: token.creator.toString(),
        },
        '[pump.fun] New token detected on bonding curve'
      );

      // Check if already in cache (duplicate detection)
      const mintCache = getMintCache();
      if (mintCache.has(token.mint)) {
        poolDetectionStats.pumpfun.alreadyCached++;
        logger.debug({ mint: token.mint.toString() }, '[pump.fun] Token already in cache, skipping');
        return;
      }

      // Verify bonding curve is active and not graduated
      try {
        const bondingCurveState = await getBondingCurveState(connection, token.bondingCurve);
        if (!bondingCurveState) {
          logger.warn({ mint: token.mint.toString() }, '[pump.fun] Could not get bonding curve state');
          poolDetectionStats.pumpfun.errors++;
          return;
        }

        if (bondingCurveState.complete) {
          poolDetectionStats.pumpfun.graduated++;
          logger.info({ mint: token.mint.toString() }, '[pump.fun] Token already graduated from bonding curve');
          return;
        }

        // TODO: Execute buy on pump.fun bonding curve
        // For now, we're just detecting and logging
        // The buy logic will be enabled once pump.fun trading is fully tested
        poolDetectionStats.pumpfun.proceededToBuy++;
        logger.info(
          {
            mint: token.mint.toString(),
            virtualSolReserves: bondingCurveState.virtualSolReserves.toString(),
            virtualTokenReserves: bondingCurveState.virtualTokenReserves.toString(),
          },
          '[pump.fun] Token detected - buy execution pending (pump.fun trading not yet enabled)'
        );

        // Placeholder for actual buy execution:
        // const buyResult = await buyOnPumpFun({
        //   connection,
        //   wallet,
        //   mint: token.mint,
        //   bondingCurve: token.bondingCurve,
        //   amountSol: Number(QUOTE_AMOUNT),
        //   slippageBps: BUY_SLIPPAGE * 100,
        //   computeUnitLimit: COMPUTE_UNIT_LIMIT,
        //   computeUnitPrice: COMPUTE_UNIT_PRICE,
        // });

      } catch (error) {
        poolDetectionStats.pumpfun.errors++;
        logger.error({ error, mint: token.mint.toString() }, '[pump.fun] Error processing token');
      }
    });

    pumpFunListener.on('error', (error) => {
      logger.error({ error }, 'pump.fun listener error');
      poolDetectionStats.pumpfun.errors++;
    });

    await pumpFunListener.start();
    logger.info('pump.fun token detection listener started');
  } else {
    logger.info('pump.fun detection disabled');
  }

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }

  const runTimestamp = Math.floor(new Date().getTime() / 1000);

  // Pool detection stats tracking for heartbeat
  const poolDetectionStats = {
    ammV4: { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0 },
    cpmm: { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0 },
    dlmm: { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0 },
    pumpfun: { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0, graduated: 0, errors: 0 },
  };

  // Initialize listeners with reconnection support
  listeners = new Listeners(connection);

  // Connect listener events to health server
  if (dashboardServer) {
    listeners.on('connected', () => {
      dashboardServer!.setWebSocketConnected(true);
    });

    listeners.on('disconnected', () => {
      dashboardServer!.setWebSocketConnected(false);
    });

    listeners.on('reconnecting', ({ attempt, delay }) => {
      logger.info({ attempt, delay }, 'WebSocket reconnecting...');
    });
  }

  // Start listeners
  await listeners.start({
    walletPublicKey: wallet.publicKey,
    quoteToken,
    autoSell: AUTO_SELL,
    cacheNewMarkets: CACHE_NEW_MARKETS,
    enableCpmm: ENABLE_CPMM,
    enableDlmm: ENABLE_DLMM,
  });

  // Update health server status
  if (dashboardServer) {
    dashboardServer.setWebSocketConnected(true);
    dashboardServer.setRpcHealthy(true);
  }

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), marketState);

    // Record activity
    if (dashboardServer) {
      dashboardServer.recordWebSocketActivity();
    }
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
    const exists = await poolCache.get(poolState.baseMint.toString());

    // Track stats
    poolDetectionStats.ammV4.detected++;
    if (exists) {
      poolDetectionStats.ammV4.alreadyCached++;
    }

    // Record activity
    if (dashboardServer) {
      dashboardServer.recordWebSocketActivity();
    }

    // Determine if pool is new (not cached AND created after bot startup)
    const isNewPool = !exists && poolOpenTime > runTimestamp;
    if (isNewPool) {
      poolDetectionStats.ammV4.isNew++;
    }

    logger.debug(
      {
        mint: poolState.baseMint.toString(),
        poolOpenTime,
        runTimestamp,
        isNew: isNewPool,
        alreadyCached: !!exists,
        poolType: 'AmmV4',
      },
      isNewPool ? 'New AmmV4 pool detected - processing' : 'AmmV4 pool event received - skipping (not new or already cached)'
    );

    if (isNewPool && bot) {
      poolDetectionStats.ammV4.proceededToBuy++;
      poolCache.save(updatedAccountInfo.accountId.toString(), poolState);
      await bot.buy(updatedAccountInfo.accountId, poolState);
    }
  });

  // Handle CPMM pool events
  listeners.on('cpmm-pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const cpmmPoolState = CpmmPoolInfoLayout.decode(updatedAccountInfo.accountInfo.data);
    const poolOpenTime = parseInt(cpmmPoolState.openTime.toString());

    // Track stats
    poolDetectionStats.cpmm.detected++;

    // Record activity
    if (dashboardServer) {
      dashboardServer.recordWebSocketActivity();
    }

    // Determine which mint is the base token (not the quote token)
    const isQuoteMintA = cpmmPoolState.mintA.equals(quoteToken.mint);
    const baseMint = isQuoteMintA ? cpmmPoolState.mintB : cpmmPoolState.mintA;
    const baseMintStr = baseMint.toString();

    // Check if pool is new
    const exists = await poolCache.get(baseMintStr);
    if (exists) {
      poolDetectionStats.cpmm.alreadyCached++;
    }

    const isNewPool = !exists && poolOpenTime > runTimestamp;
    if (isNewPool) {
      poolDetectionStats.cpmm.isNew++;
    }

    logger.debug(
      {
        mint: baseMintStr,
        poolOpenTime,
        runTimestamp,
        isNew: isNewPool,
        alreadyCached: !!exists,
        poolType: 'CPMM',
      },
      isNewPool ? 'New CPMM pool detected - checking token age' : 'CPMM pool event received - skipping (not new or already cached)'
    );

    // If pool passes basic checks, verify token age
    if (isNewPool && bot) {
      // Token age validation (Phase 1)
      if (ENABLE_TOKEN_AGE_CHECK) {
        const tokenAgeResult = await getTokenAge(connection, baseMint, MAX_TOKEN_AGE_SECONDS);

        logger.info(
          {
            mint: baseMintStr,
            ageSeconds: tokenAgeResult.ageSeconds,
            maxAgeSeconds: MAX_TOKEN_AGE_SECONDS,
            isNew: tokenAgeResult.isNew,
            poolType: 'CPMM',
          },
          `[CPMM] Token age check: ${tokenAgeResult.ageSeconds}s (max: ${MAX_TOKEN_AGE_SECONDS}s) ${tokenAgeResult.isNew ? 'PASS' : 'FAIL'}`
        );

        if (!tokenAgeResult.isNew) {
          poolDetectionStats.cpmm.tokenTooOld++;
          logger.info(
            {
              mint: baseMintStr,
              ageSeconds: tokenAgeResult.ageSeconds,
              maxAgeSeconds: MAX_TOKEN_AGE_SECONDS,
              poolType: 'CPMM',
            },
            `[CPMM] REJECTED: Token too old (${tokenAgeResult.ageSeconds}s > ${MAX_TOKEN_AGE_SECONDS}s)`
          );
          return;
        }
      }

      // All checks passed - proceed to buy
      poolDetectionStats.cpmm.proceededToBuy++;
      logger.info(
        {
          mint: baseMintStr,
          poolId: updatedAccountInfo.accountId.toString(),
          poolType: 'CPMM',
        },
        '[CPMM] EMITTING: New token pool detected - proceeding to buy'
      );
      // Save to cache using baseMint as key (same pattern as AmmV4)
      poolCache.save(updatedAccountInfo.accountId.toString(), cpmmPoolState as any);
      await bot.buyCpmm(updatedAccountInfo.accountId, cpmmPoolState);
    }
  });

  // Handle Meteora DLMM pool events
  listeners.on('dlmm-pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const dlmmPoolState = decodeDlmmPoolState(updatedAccountInfo.accountInfo.data);

    // Track stats
    poolDetectionStats.dlmm.detected++;

    // Record activity
    if (dashboardServer) {
      dashboardServer.recordWebSocketActivity();
    }

    // Determine which mint is the base token (not the quote token)
    const isQuoteX = dlmmPoolState.tokenXMint.equals(quoteToken.mint);
    const baseMint = isQuoteX ? dlmmPoolState.tokenYMint : dlmmPoolState.tokenXMint;
    const baseMintStr = baseMint.toString();

    // Check if pool is new - DLMM uses activationPoint
    const exists = await poolCache.get(baseMintStr);
    if (exists) {
      poolDetectionStats.dlmm.alreadyCached++;
    }

    // Check if pool is currently tradeable (activated)
    // activationPoint === 0 means immediately active
    // activationPoint <= currentTimestamp means activation time has passed
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const isActivated = isDlmmPoolActivated(dlmmPoolState.activationPoint, currentTimestamp);
    const isNewPool = !exists && isActivated;
    if (isNewPool) {
      poolDetectionStats.dlmm.isNew++;
    }

    const activationPoint = parseInt(dlmmPoolState.activationPoint.toString());
    logger.debug(
      {
        mint: baseMintStr,
        activationPoint,
        currentTimestamp,
        isActivated,
        isNew: isNewPool,
        alreadyCached: !!exists,
        poolType: 'DLMM',
        binStep: dlmmPoolState.binStep,
        activeId: dlmmPoolState.activeId,
      },
      isNewPool ? 'New DLMM pool detected - processing' : 'DLMM pool event received - skipping (not new, not activated, or already cached)'
    );

    if (isNewPool && bot) {
      poolDetectionStats.dlmm.proceededToBuy++;
      // Save to cache using baseMint as key (same pattern as other pool types)
      poolCache.save(updatedAccountInfo.accountId.toString(), dlmmPoolState as any);
      try {
        await bot.buyDlmm(updatedAccountInfo.accountId, dlmmPoolState);
      } catch (error) {
        logger.error({ error, mint: baseMintStr, poolType: 'DLMM' }, 'Error processing DLMM pool');
      }
    }
  });

  listeners.on('wallet', async (updatedAccountInfo: KeyedAccountInfo) => {
    const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);

    // Record activity
    if (dashboardServer) {
      dashboardServer.recordWebSocketActivity();
    }

    if (accountData.mint.equals(quoteToken.mint)) {
      return;
    }

    if (bot) {
      await bot.sell(updatedAccountInfo.accountId, accountData);
    }
  });

  printDetails(wallet, quoteToken, bot!);

  // Periodic heartbeat log to show bot is still alive with pool detection stats
  const heartbeatIntervalMs = 5 * 60 * 1000; // 5 minutes
  let lastHeartbeat = Date.now();

  setInterval(() => {
    const uptimeMs = Date.now() - lastHeartbeat;
    const stateStore = getStateStore();
    const stats = stateStore?.getStats();

    // Calculate totals across all pool types (including pump.fun)
    const totalDetected = poolDetectionStats.ammV4.detected + poolDetectionStats.cpmm.detected + poolDetectionStats.dlmm.detected + poolDetectionStats.pumpfun.detected;
    const totalNew = poolDetectionStats.ammV4.isNew + poolDetectionStats.cpmm.isNew + poolDetectionStats.dlmm.isNew + poolDetectionStats.pumpfun.isNew;
    const totalTokenTooOld = poolDetectionStats.ammV4.tokenTooOld + poolDetectionStats.cpmm.tokenTooOld + poolDetectionStats.dlmm.tokenTooOld + poolDetectionStats.pumpfun.tokenTooOld;
    const totalBought = poolDetectionStats.ammV4.proceededToBuy + poolDetectionStats.cpmm.proceededToBuy + poolDetectionStats.dlmm.proceededToBuy + poolDetectionStats.pumpfun.proceededToBuy;

    // Get mint cache stats
    const mintCacheStats = getMintCache().getStats();

    // Get pump.fun listener stats if available
    const pumpFunStats = pumpFunListener?.getStats();

    // Log detailed stats as structured data (won't be truncated)
    logger.info(
      {
        period: '5min',
        ammV4: { ...poolDetectionStats.ammV4 },
        cpmm: { ...poolDetectionStats.cpmm },
        dlmm: { ...poolDetectionStats.dlmm },
        pumpfun: { ...poolDetectionStats.pumpfun },
        totals: {
          detected: totalDetected,
          alreadyCached: poolDetectionStats.ammV4.alreadyCached + poolDetectionStats.cpmm.alreadyCached + poolDetectionStats.dlmm.alreadyCached + poolDetectionStats.pumpfun.alreadyCached,
          isNew: totalNew,
          tokenTooOld: totalTokenTooOld,
          proceededToBuy: totalBought,
        },
        mintCache: {
          size: mintCacheStats.size,
          heliusDetected: mintCacheStats.heliusDetected,
          fallbackDetected: mintCacheStats.fallbackDetected,
          hitRate: (mintCacheStats.hitRate * 100).toFixed(1) + '%',
        },
        pumpfunListener: pumpFunStats ? {
          logsReceived: pumpFunStats.logsReceived,
          tokensProcessed: pumpFunStats.tokensProcessed,
        } : null,
        seenPools: stats?.seenPools || 0,
        openPositions: stats?.positions.open || 0,
        uptimeMinutes: Math.floor(uptimeMs / 60000),
      },
      `Heartbeat (5min): Detected=${totalDetected} New=${totalNew} TokenOld=${totalTokenTooOld} Bought=${totalBought} | MintCache: ${mintCacheStats.size} (helius=${mintCacheStats.heliusDetected}, fallback=${mintCacheStats.fallbackDetected}) | AmmV4: ${poolDetectionStats.ammV4.detected}/${poolDetectionStats.ammV4.isNew}/${poolDetectionStats.ammV4.proceededToBuy} | CPMM: ${poolDetectionStats.cpmm.detected}/${poolDetectionStats.cpmm.isNew}/${poolDetectionStats.cpmm.tokenTooOld}/${poolDetectionStats.cpmm.proceededToBuy} | DLMM: ${poolDetectionStats.dlmm.detected}/${poolDetectionStats.dlmm.isNew}/${poolDetectionStats.dlmm.proceededToBuy} | pump.fun: ${poolDetectionStats.pumpfun.detected}/${poolDetectionStats.pumpfun.isNew}/${poolDetectionStats.pumpfun.proceededToBuy}`
    );

    // Reset counters for next period
    poolDetectionStats.ammV4 = { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0 };
    poolDetectionStats.cpmm = { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0 };
    poolDetectionStats.dlmm = { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0 };
    poolDetectionStats.pumpfun = { detected: 0, alreadyCached: 0, isNew: 0, tokenTooOld: 0, proceededToBuy: 0, graduated: 0, errors: 0 };
    lastHeartbeat = Date.now();
  }, heartbeatIntervalMs);
};

// Register graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error({ error }, 'Uncaught exception');
  gracefulShutdown('uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});

// Start the bot
runListener().catch((error) => {
  logger.error({ error }, 'Failed to start bot');
  process.exit(1);
});
