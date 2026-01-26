import { MarketCache, PoolCache, initMintCache, getMintCache } from './cache';
import { Listeners, initMintListener, getMintListener, MintListener, VerificationConfig } from './listeners';
import {
  PumpFunListener,
  initPumpFunListener,
  getPumpFunListener,
} from './listeners/pumpfun-listener';
import { Connection, KeyedAccountInfo, Keypair, PublicKey } from '@solana/web3.js';
import { MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { DetectedToken, getSourceDisplayName } from './types';
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
// verifyTokenAge is now called internally by listeners
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

    // pump.fun now emits 'new-token' event - handler set up below with unified handler
    pumpFunListener.on('error', (error) => {
      logger.error({ error }, 'pump.fun listener error');
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

  // Initialize listeners with reconnection support
  // Stats are now tracked internally by listeners via getStats()
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

  // Start listeners with verification config
  const verificationConfig: VerificationConfig = {
    maxTokenAgeSeconds: MAX_TOKEN_AGE_SECONDS,
    dexscreenerFallbackEnabled: DEXSCREENER_FALLBACK_ENABLED,
    runTimestamp,
  };

  await listeners.start({
    walletPublicKey: wallet.publicKey,
    quoteToken,
    autoSell: AUTO_SELL,
    cacheNewMarkets: CACHE_NEW_MARKETS,
    enableCpmm: ENABLE_CPMM,
    enableDlmm: ENABLE_DLMM,
    verification: verificationConfig,
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

  // ══════════════════════════════════════════════════════════════════════════════
  // UNIFIED 'new-token' EVENT HANDLER
  // All platforms (Raydium AmmV4, CPMM, Meteora DLMM) emit this single event
  // Verification (mint cache + DexScreener) is handled inside the listeners
  // ══════════════════════════════════════════════════════════════════════════════
  listeners.on('new-token', async (token: DetectedToken) => {
    // Record activity
    if (dashboardServer) {
      dashboardServer.recordWebSocketActivity();
    }

    const sourceName = getSourceDisplayName(token.source);
    const baseMintStr = token.mint.toString();

    logger.info(
      {
        mint: baseMintStr,
        source: token.source,
        poolId: token.poolId?.toString(),
        verificationSource: token.verificationSource,
        ageSeconds: token.ageSeconds,
        inMintCache: token.inMintCache,
      },
      `[${sourceName}] New token verified - executing buy`
    );

    if (!bot) {
      logger.error({ mint: baseMintStr }, 'Bot not initialized');
      return;
    }

    try {
      // Execute buy based on pool type
      switch (token.poolState.type) {
        case 'ammv4':
          poolCache.save(token.poolId!.toString(), token.poolState.state);
          await bot.buy(token.poolId!, token.poolState.state);
          break;

        case 'cpmm':
          // Note: CPMM uses mintA/mintB, not compatible with poolCache (designed for AmmV4)
          await bot.buyCpmm(token.poolId!, token.poolState.state);
          break;

        case 'dlmm':
          // Note: DLMM uses tokenXMint/tokenYMint, not compatible with poolCache (designed for AmmV4)
          await bot.buyDlmm(token.poolId!, token.poolState.state);
          break;

        default:
          logger.warn({ source: token.source }, 'Unknown pool type in DEX handler');
      }
    } catch (error) {
      logger.error({ error, mint: baseMintStr, source: token.source }, 'Error executing buy');
    }
  });

  // Token rejection handler (for stats/debugging)
  listeners.on('token-rejected', (partialToken: Partial<DetectedToken>, reason: string) => {
    logger.debug(
      {
        mint: partialToken.mint?.toString(),
        source: partialToken.source,
        reason,
      },
      'Token rejected during verification'
    );
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

  // ══════════════════════════════════════════════════════════════════════════════
  // PUMP.FUN UNIFIED 'new-token' HANDLER
  // pump.fun listener also emits 'new-token' with DetectedToken interface
  // ══════════════════════════════════════════════════════════════════════════════
  if (pumpFunListener) {
    pumpFunListener.on('new-token', async (token: DetectedToken) => {
      if (token.source !== 'pumpfun') {
        logger.warn({ source: token.source }, 'Non-pumpfun token received from pumpfun listener');
        return;
      }

      // Record activity
      if (dashboardServer) {
        dashboardServer.recordWebSocketActivity();
      }

      const baseMintStr = token.mint.toString();

      logger.info(
        {
          mint: baseMintStr,
          name: token.name || 'Unknown',
          symbol: token.symbol || 'Unknown',
          bondingCurve: token.bondingCurve?.toString(),
          creator: token.creator?.toString(),
        },
        '[pump.fun] New token detected on bonding curve'
      );

      // Verify bonding curve is active and not graduated
      try {
        const bondingCurveState = await getBondingCurveState(connection, token.bondingCurve!);
        if (!bondingCurveState) {
          logger.warn({ mint: baseMintStr }, '[pump.fun] Could not get bonding curve state');
          return;
        }

        if (bondingCurveState.complete) {
          logger.info({ mint: baseMintStr }, '[pump.fun] Token already graduated from bonding curve');
          return;
        }

        // Execute buy on pump.fun bonding curve
        logger.info(
          {
            mint: baseMintStr,
            name: token.name || 'Unknown',
            symbol: token.symbol || 'Unknown',
            virtualSolReserves: bondingCurveState.virtualSolReserves.toString(),
            virtualTokenReserves: bondingCurveState.virtualTokenReserves.toString(),
          },
          '[pump.fun] Executing buy on bonding curve'
        );

        if (DRY_RUN) {
          logger.info(
            { mint: baseMintStr, amountSol: QUOTE_AMOUNT.toString() },
            '[pump.fun] DRY RUN - would have bought token'
          );
        } else {
          const buyResult = await buyOnPumpFun({
            connection,
            wallet,
            mint: token.mint,
            bondingCurve: token.bondingCurve!,
            amountSol: Number(QUOTE_AMOUNT),
            slippageBps: BUY_SLIPPAGE * 100,
            computeUnitLimit: COMPUTE_UNIT_LIMIT,
            computeUnitPrice: COMPUTE_UNIT_PRICE,
          });

          if (buyResult.success) {
            logger.info(
              {
                mint: baseMintStr,
                signature: buyResult.signature,
                tokensReceived: buyResult.tokensReceived,
                amountSol: QUOTE_AMOUNT.toString(),
              },
              '[pump.fun] Buy successful'
            );
          } else {
            logger.error(
              {
                mint: baseMintStr,
                error: buyResult.error,
              },
              '[pump.fun] Buy failed'
            );
          }
        }
      } catch (error) {
        logger.error({ error, mint: baseMintStr }, '[pump.fun] Error processing token');
      }
    });
  }

  printDetails(wallet, quoteToken, bot!);

  // Periodic heartbeat log to show bot is still alive with pool detection stats
  const heartbeatIntervalMs = 5 * 60 * 1000; // 5 minutes
  let lastHeartbeat = Date.now();

  setInterval(() => {
    const uptimeMs = Date.now() - lastHeartbeat;
    const stateStore = getStateStore();
    const dbStats = stateStore?.getStats();

    // Get unified stats from listeners
    const listenerStats = listeners?.getStats();
    const pumpFunPlatformStats = pumpFunListener?.getPlatformStats();

    // Calculate totals across all pool types
    const ammv4 = listenerStats?.ammv4 || { detected: 0, isNew: 0, tokenTooOld: 0, buyAttempted: 0, errors: 0 };
    const cpmm = listenerStats?.cpmm || { detected: 0, isNew: 0, tokenTooOld: 0, buyAttempted: 0, errors: 0 };
    const dlmm = listenerStats?.dlmm || { detected: 0, isNew: 0, tokenTooOld: 0, buyAttempted: 0, errors: 0 };
    const pumpfun = pumpFunPlatformStats || { detected: 0, isNew: 0, tokenTooOld: 0, buyAttempted: 0, errors: 0 };

    const totalDetected = ammv4.detected + cpmm.detected + dlmm.detected + pumpfun.detected;
    const totalNew = ammv4.isNew + cpmm.isNew + dlmm.isNew + pumpfun.isNew;
    const totalTokenTooOld = ammv4.tokenTooOld + cpmm.tokenTooOld + dlmm.tokenTooOld + pumpfun.tokenTooOld;
    const totalBought = ammv4.buyAttempted + cpmm.buyAttempted + dlmm.buyAttempted + pumpfun.buyAttempted;

    // Get mint cache stats
    const mintCacheStats = getMintCache().getStats();

    // Log detailed stats as structured data
    logger.info(
      {
        period: '5min',
        ammv4,
        cpmm,
        dlmm,
        pumpfun,
        totals: {
          detected: totalDetected,
          isNew: totalNew,
          tokenTooOld: totalTokenTooOld,
          buyAttempted: totalBought,
        },
        mintCache: {
          size: mintCacheStats.size,
          heliusDetected: mintCacheStats.heliusDetected,
          fallbackDetected: mintCacheStats.fallbackDetected,
          hitRate: (mintCacheStats.hitRate * 100).toFixed(1) + '%',
        },
        seenPools: dbStats?.seenPools || 0,
        openPositions: dbStats?.positions.open || 0,
        uptimeMinutes: Math.floor(uptimeMs / 60000),
      },
      `Heartbeat (5min): Detected=${totalDetected} New=${totalNew} TokenOld=${totalTokenTooOld} Bought=${totalBought} | MintCache: ${mintCacheStats.size} | AmmV4: ${ammv4.detected}/${ammv4.isNew}/${ammv4.buyAttempted} | CPMM: ${cpmm.detected}/${cpmm.isNew}/${cpmm.buyAttempted} | DLMM: ${dlmm.detected}/${dlmm.isNew}/${dlmm.buyAttempted} | pump.fun: ${pumpfun.detected}/${pumpfun.isNew}/${pumpfun.buyAttempted}`
    );

    // Reset counters for next period
    listeners?.resetStats();
    pumpFunListener?.resetStats();
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
