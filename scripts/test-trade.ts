/**
 * Test Trade Script
 *
 * Executes a test trade for a given Raydium pool ID.
 * Can run in dry-run mode (simulation only) or execute actual transactions.
 *
 * Usage:
 *   npm run test-trade <pool_id>
 *   npm run test-trade <pool_id> -- --dry-run
 *   npm run test-trade <pool_id> -- --amount 0.005
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Bot, BotConfig } from '../bot';
import { DefaultTransactionExecutor, TransactionExecutor, FallbackTransactionExecutor } from '../transactions';
import { MarketCache, PoolCache } from '../cache';
import { WarpTransactionExecutor } from '../transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from '../transactions/jito-rpc-transaction-executor';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  QUOTE_MINT,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  TAKE_PROFIT,
  STOP_LOSS,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  CONSECUTIVE_FILTER_MATCHES,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  USE_FALLBACK_EXECUTOR,
  MIN_POOL_SIZE,
  MAX_POOL_SIZE,
} from '../helpers';
import {
  initExposureManager,
  getExposureManager,
  initPositionMonitor,
  getPositionMonitor,
  getBlacklist,
  getPnlTracker,
} from '../risk';
import {
  initStateStore,
  getStateStore,
  closeStateStore,
} from '../persistence';

interface TestTradeOptions {
  poolId: string;
  dryRun: boolean;
  amount?: number;
}

interface TestTradeResult {
  success: boolean;
  message: string;
  details?: {
    poolId: string;
    tokenMint: string;
    amount: number;
    dryRun: boolean;
    txSignature?: string;
    error?: string;
  };
}

/**
 * Check if we're running within the main bot process
 * (services already initialized)
 */
function isRunningWithinBot(): boolean {
  return getStateStore() !== null;
}

/**
 * Execute a test trade for a given pool
 */
export async function executeTestTrade(options: TestTradeOptions): Promise<TestTradeResult> {
  const { poolId, dryRun, amount } = options;
  const runningWithinBot = isRunningWithinBot();

  logger.info({ poolId, dryRun, amount, runningWithinBot }, 'Starting test trade...');

  // Track if we initialized services (for cleanup)
  let initializedServices = false;

  try {
    // Initialize connection
    const connection = new Connection(RPC_ENDPOINT, {
      commitment: COMMITMENT_LEVEL,
    });

    // Get wallet and quote token
    const wallet = getWallet(PRIVATE_KEY.trim());
    const quoteToken = getToken(QUOTE_MINT);
    const tradeAmount = amount || parseFloat(QUOTE_AMOUNT.toString());

    logger.info({
      wallet: wallet.publicKey.toString(),
      quoteToken: quoteToken.symbol,
      tradeAmount,
    }, 'Configuration loaded');

    // Fetch pool account data
    logger.info({ poolId }, 'Fetching pool data...');
    const poolPubkey = new PublicKey(poolId);
    const poolAccountInfo = await connection.getAccountInfo(poolPubkey);

    if (!poolAccountInfo) {
      return {
        success: false,
        message: 'Pool not found',
        details: {
          poolId,
          tokenMint: '',
          amount: tradeAmount,
          dryRun,
          error: 'Pool account not found on chain',
        },
      };
    }

    // Decode pool state
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(poolAccountInfo.data);
    const tokenMint = poolState.baseMint.toString();

    logger.info({
      tokenMint,
      quoteMint: poolState.quoteMint.toString(),
      lpMint: poolState.lpMint.toString(),
    }, 'Pool data decoded');

    // If dry run, just return success without executing
    if (dryRun) {
      logger.info({ tokenMint, poolId, amount: tradeAmount }, 'DRY RUN - Would execute buy transaction');
      return {
        success: true,
        message: 'Dry run completed - trade would be executed',
        details: {
          poolId,
          tokenMint,
          amount: tradeAmount,
          dryRun: true,
        },
      };
    }

    // Initialize caches
    const marketCache = new MarketCache(connection);
    const poolCache = new PoolCache();

    // Fetch and cache market data
    logger.info({ marketId: poolState.marketId.toString() }, 'Fetching market data...');
    const marketAccountInfo = await connection.getAccountInfo(poolState.marketId);

    if (!marketAccountInfo) {
      return {
        success: false,
        message: 'Market not found',
        details: {
          poolId,
          tokenMint,
          amount: tradeAmount,
          dryRun,
          error: 'Market account not found on chain',
        },
      };
    }

    const marketState = MARKET_STATE_LAYOUT_V3.decode(marketAccountInfo.data);
    marketCache.save(poolState.marketId.toString(), marketState);

    // Save pool to cache
    poolCache.save(poolId, poolState);

    // Initialize transaction executor
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

    // Initialize risk systems if not running within bot
    if (!runningWithinBot) {
      initializedServices = true;
      logger.info('Initializing services for standalone test trade...');

      initStateStore();
      initExposureManager(connection, wallet.publicKey, {
        maxTotalExposureSol: 100, // High limit for test
        maxTradesPerHour: 100,
        minWalletBufferSol: 0.01,
      });

      const blacklist = getBlacklist();
      await blacklist.init();

      const pnlTracker = getPnlTracker();
      await pnlTracker.init();

      initPositionMonitor(connection, quoteToken, {
        checkIntervalMs: PRICE_CHECK_INTERVAL,
        takeProfit: TAKE_PROFIT,
        stopLoss: STOP_LOSS,
        maxHoldDurationMs: 0,
      });
    }

    // Create bot config
    const botConfig: BotConfig = {
      wallet,
      quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
      checkRenounced: false, // Skip filters for test trade
      checkFreezable: false,
      checkBurned: false,
      minPoolSize: new TokenAmount(quoteToken, MIN_POOL_SIZE, false),
      maxPoolSize: new TokenAmount(quoteToken, MAX_POOL_SIZE, false),
      quoteToken,
      quoteAmount: new TokenAmount(quoteToken, tradeAmount, false),
      oneTokenAtATime: false,
      useSnipeList: true, // Bypass filters
      autoSell: false,
      autoSellDelay: 0,
      maxSellRetries: 3,
      autoBuyDelay: 0,
      maxBuyRetries: 3,
      unitLimit: COMPUTE_UNIT_LIMIT,
      unitPrice: COMPUTE_UNIT_PRICE,
      takeProfit: TAKE_PROFIT,
      stopLoss: STOP_LOSS,
      buySlippage: BUY_SLIPPAGE,
      sellSlippage: SELL_SLIPPAGE,
      priceCheckInterval: PRICE_CHECK_INTERVAL,
      priceCheckDuration: PRICE_CHECK_DURATION,
      filterCheckInterval: 0, // Disable filters
      filterCheckDuration: 0,
      consecutiveMatchCount: CONSECUTIVE_FILTER_MATCHES,
    };

    // Create bot instance
    const bot = new Bot(connection, marketCache, poolCache, txExecutor, botConfig);

    // Validate wallet has sufficient balance
    const valid = await bot.validate();
    if (!valid) {
      return {
        success: false,
        message: 'Insufficient wallet balance',
        details: {
          poolId,
          tokenMint,
          amount: tradeAmount,
          dryRun,
          error: 'Wallet validation failed - check SOL balance',
        },
      };
    }

    // Execute the buy
    logger.info({ tokenMint, amount: tradeAmount }, 'Executing buy transaction...');
    await bot.buy(poolPubkey, poolState);

    return {
      success: true,
      message: 'Test trade executed',
      details: {
        poolId,
        tokenMint,
        amount: tradeAmount,
        dryRun: false,
      },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMessage, poolId }, 'Test trade failed');

    return {
      success: false,
      message: 'Test trade failed',
      details: {
        poolId,
        tokenMint: '',
        amount: options.amount || parseFloat(QUOTE_AMOUNT.toString()),
        dryRun,
        error: errorMessage,
      },
    };
  } finally {
    // Only clean up services if we initialized them
    if (initializedServices) {
      logger.info('Cleaning up standalone test trade services...');
      const positionMonitor = getPositionMonitor();
      if (positionMonitor) {
        positionMonitor.stop();
      }
      closeStateStore();
    }
  }
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Test Trade Script - Execute a test trade for a Raydium pool

Usage:
  npm run test-trade <pool_id>              Execute a real trade
  npm run test-trade <pool_id> -- --dry-run Simulate without executing
  npm run test-trade <pool_id> -- --amount 0.005  Custom amount in SOL

Arguments:
  pool_id    The Raydium pool ID to trade on

Options:
  --dry-run  Simulate the trade without executing
  --amount   Custom trade amount in SOL (default: from QUOTE_AMOUNT env var)
  --help     Show this help message

Examples:
  npm run test-trade 7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX
  npm run test-trade 7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX -- --dry-run
  npm run test-trade 7XawhbbxtsRcQA8KTkHT9f9nc6d69UwqCDh6U5EEbEmX -- --amount 0.01
`);
    process.exit(0);
  }

  const poolId = args[0];
  const dryRun = args.includes('--dry-run');

  let amount: number | undefined;
  const amountIndex = args.indexOf('--amount');
  if (amountIndex !== -1 && args[amountIndex + 1]) {
    amount = parseFloat(args[amountIndex + 1]);
    if (isNaN(amount) || amount <= 0) {
      console.error('Error: Invalid amount value');
      process.exit(1);
    }
  }

  // Validate pool ID format (should be a base58 string)
  try {
    new PublicKey(poolId);
  } catch {
    console.error('Error: Invalid pool ID format');
    process.exit(1);
  }

  console.log('\n=== Test Trade ===');
  console.log(`Pool ID: ${poolId}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (simulation)' : 'LIVE TRADE'}`);
  if (amount) {
    console.log(`Amount: ${amount} SOL`);
  }
  console.log('');

  const result = await executeTestTrade({ poolId, dryRun, amount });

  console.log('\n=== Result ===');
  console.log(`Success: ${result.success}`);
  console.log(`Message: ${result.message}`);
  if (result.details) {
    console.log('Details:', JSON.stringify(result.details, null, 2));
  }

  process.exit(result.success ? 0 : 1);
}

// Run if executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
