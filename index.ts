import { MarketCache, PoolCache } from './cache';
import { Listeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor, TransactionExecutor } from './transactions';
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
  logFilterPresetInfo,
} from './helpers';
import { initRpcManager } from './helpers/rpc-manager';
import { startHealthServer, HealthServer } from './health';
import { version } from './package.json';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

// Global references for graceful shutdown
let listeners: Listeners | null = null;
let healthServer: HealthServer | null = null;
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
    // Stop listeners first
    if (listeners) {
      logger.info('Stopping WebSocket listeners...');
      await listeners.stop();
    }

    // Stop health server
    if (healthServer) {
      logger.info('Stopping health server...');
      await healthServer.stop();
    }

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

  // Start health server early
  try {
    healthServer = await startHealthServer(HEALTH_PORT);
    logger.info({ port: HEALTH_PORT }, 'Health server started');
  } catch (error) {
    logger.error({ error }, 'Failed to start health server');
    // Continue without health server - not critical for bot operation
  }

  // Initialize RPC Manager with failover
  const connection = initializeRpcManager();

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(CUSTOM_FEE);
      break;
    }
    case 'jito': {
      txExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);
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

  const bot = new Bot(connection, marketCache, poolCache, txExecutor, botConfig);
  const valid = await bot.validate();

  if (!valid) {
    logger.info('Bot is exiting...');
    process.exit(1);
  }

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }

  const runTimestamp = Math.floor(new Date().getTime() / 1000);

  // Initialize listeners with reconnection support
  listeners = new Listeners(connection);

  // Connect listener events to health server
  if (healthServer) {
    listeners.on('connected', () => {
      healthServer!.setWebSocketConnected(true);
    });

    listeners.on('disconnected', () => {
      healthServer!.setWebSocketConnected(false);
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
  });

  // Update health server status
  if (healthServer) {
    healthServer.setWebSocketConnected(true);
    healthServer.setRpcHealthy(true);
  }

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), marketState);

    // Record activity
    if (healthServer) {
      healthServer.recordWebSocketActivity();
    }
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
    const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
    const exists = await poolCache.get(poolState.baseMint.toString());

    // Record activity
    if (healthServer) {
      healthServer.recordWebSocketActivity();
    }

    if (!exists && poolOpenTime > runTimestamp) {
      poolCache.save(updatedAccountInfo.accountId.toString(), poolState);
      await bot.buy(updatedAccountInfo.accountId, poolState);
    }
  });

  listeners.on('wallet', async (updatedAccountInfo: KeyedAccountInfo) => {
    const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);

    // Record activity
    if (healthServer) {
      healthServer.recordWebSocketActivity();
    }

    if (accountData.mint.equals(quoteToken.mint)) {
      return;
    }

    await bot.sell(updatedAccountInfo.accountId, accountData);
  });

  printDetails(wallet, quoteToken, bot);
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
