/**
 * Test Trade Script
 *
 * This script allows you to execute a test trade directly, bypassing all filters.
 * Use this to verify that your trading setup (wallet, RPC, transaction executor) works correctly.
 *
 * Usage:
 *   npx ts-node test-trade.ts <pool_id>
 *   npx ts-node test-trade.ts <pool_id> --dry-run    # Simulate without executing
 *   npx ts-node test-trade.ts <pool_id> --amount 0.005  # Custom amount
 *
 * Example:
 *   npx ts-node test-trade.ts 8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  Liquidity,
  LiquidityPoolKeysV4,
  LiquidityStateV4,
  LIQUIDITY_STATE_LAYOUT_V4,
  MARKET_STATE_LAYOUT_V3,
  MAINNET_PROGRAM_ID,
  Token,
  TokenAmount,
  Percent,
} from '@raydium-io/raydium-sdk';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { createPoolKeys } from './helpers/liquidity';
import { MinimalMarketLayoutV3 } from './helpers/market';
import {
  logger,
  getWallet,
  getToken,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  QUOTE_MINT,
  QUOTE_AMOUNT,
  BUY_SLIPPAGE,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  SIMULATE_TRANSACTION,
  DRY_RUN,
  NETWORK,
  PRIVATE_KEY,
} from './helpers';
import { DefaultTransactionExecutor, TransactionExecutor } from './transactions';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';

// Parse command line arguments
function parseArgs(): { poolId: string; dryRun: boolean; amount: number | null } {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
Test Trade Script - Execute a test trade bypassing all filters

Usage:
  npx ts-node test-trade.ts <pool_id> [options]

Options:
  --dry-run       Simulate the trade without executing (overrides .env setting)
  --amount <SOL>  Custom amount to trade (default: uses QUOTE_AMOUNT from .env)
  --help          Show this help message

Examples:
  npx ts-node test-trade.ts 8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj
  npx ts-node test-trade.ts 8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj --dry-run
  npx ts-node test-trade.ts 8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj --amount 0.005

How to find a pool ID:
  1. Go to https://raydium.io/swap/
  2. Search for any token and start a swap
  3. The pool ID is in the URL or transaction details
  4. Or use https://solscan.io to find Raydium AMM accounts for a token
`);
    process.exit(0);
  }

  let poolId = '';
  let dryRun = DRY_RUN; // Default to .env setting
  let amount: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--amount' && args[i + 1]) {
      amount = parseFloat(args[i + 1]);
      i++;
    } else if (arg === '--help') {
      // Re-run with no args to show help
      process.argv = process.argv.slice(0, 2);
      return parseArgs();
    } else if (!arg.startsWith('--')) {
      poolId = arg;
    }
  }

  if (!poolId) {
    console.error('Error: Pool ID is required');
    process.exit(1);
  }

  // Validate pool ID is a valid public key
  try {
    new PublicKey(poolId);
  } catch {
    console.error('Error: Invalid pool ID. Must be a valid Solana public key.');
    process.exit(1);
  }

  return { poolId, dryRun, amount };
}

/**
 * Fetch pool state from chain
 */
async function fetchPoolState(connection: Connection, poolId: PublicKey): Promise<LiquidityStateV4> {
  logger.info({ poolId: poolId.toString() }, 'Fetching pool state...');

  const accountInfo = await connection.getAccountInfo(poolId);
  if (!accountInfo) {
    throw new Error(`Pool not found: ${poolId.toString()}`);
  }

  const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(accountInfo.data);
  return poolState;
}

/**
 * Fetch market state from chain
 */
async function fetchMarketState(
  connection: Connection,
  marketId: PublicKey
): Promise<MinimalMarketLayoutV3> {
  logger.info({ marketId: marketId.toString() }, 'Fetching market state...');

  const accountInfo = await connection.getAccountInfo(marketId);
  if (!accountInfo) {
    throw new Error(`Market not found: ${marketId.toString()}`);
  }

  const marketState = MARKET_STATE_LAYOUT_V3.decode(accountInfo.data);
  return {
    bids: marketState.bids,
    asks: marketState.asks,
    eventQueue: marketState.eventQueue,
  };
}

/**
 * Create the transaction executor based on configuration
 */
function createTransactionExecutor(connection: Connection): TransactionExecutor {
  switch (TRANSACTION_EXECUTOR) {
    case 'warp':
      return new WarpTransactionExecutor(CUSTOM_FEE, connection);
    case 'jito':
      return new JitoTransactionExecutor(CUSTOM_FEE, connection);
    default:
      return new DefaultTransactionExecutor(connection, SIMULATE_TRANSACTION);
  }
}

/**
 * Execute a test swap
 */
async function executeTestSwap(
  connection: Connection,
  poolKeys: LiquidityPoolKeysV4,
  wallet: Keypair,
  quoteToken: Token,
  quoteAmount: TokenAmount,
  slippage: number,
  txExecutor: TransactionExecutor,
  dryRun: boolean
) {
  const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);

  const ataIn = await getAssociatedTokenAddress(quoteToken.mint, wallet.publicKey);
  const ataOut = await getAssociatedTokenAddress(poolKeys.baseMint, wallet.publicKey);

  logger.info('Fetching pool info for swap calculation...');
  const poolInfo = await Liquidity.fetchInfo({
    connection,
    poolKeys,
  });

  const slippagePercent = new Percent(slippage, 100);
  const computedAmountOut = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn: quoteAmount,
    currencyOut: tokenOut,
    slippage: slippagePercent,
  });

  logger.info({
    amountIn: quoteAmount.toFixed(),
    expectedOut: computedAmountOut.amountOut.toFixed(),
    minOut: computedAmountOut.minAmountOut.toFixed(),
    priceImpact: computedAmountOut.priceImpact.toFixed(),
    slippage: `${slippage}%`,
  }, 'Swap calculation complete');

  if (dryRun) {
    logger.info('=== DRY RUN MODE - Transaction will NOT be executed ===');
    logger.info({
      action: 'BUY',
      tokenMint: poolKeys.baseMint.toString(),
      amountIn: `${quoteAmount.toFixed()} ${quoteToken.symbol}`,
      expectedOut: `${computedAmountOut.amountOut.toFixed()} tokens`,
      minOut: `${computedAmountOut.minAmountOut.toFixed()} tokens`,
    }, 'Would execute swap');
    return { confirmed: true, signature: 'DRY_RUN_SIMULATED' };
  }

  // Build transaction
  const latestBlockhash = await connection.getLatestBlockhash();
  const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys,
      userKeys: {
        tokenAccountIn: ataIn,
        tokenAccountOut: ataOut,
        owner: wallet.publicKey,
      },
      amountIn: quoteAmount.raw,
      minAmountOut: computedAmountOut.minAmountOut.raw,
    },
    poolKeys.version
  );

  // Build pre-swap instructions
  const preInstructions = [];

  // Add compute budget instructions if not using Warp/Jito
  const isWarpOrJito = TRANSACTION_EXECUTOR === 'warp' || TRANSACTION_EXECUTOR === 'jito';
  if (!isWarpOrJito) {
    preInstructions.push(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT })
    );
  }

  // Create output token account
  preInstructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      ataOut,
      wallet.publicKey,
      tokenOut.mint
    )
  );

  // If input token is WSOL (native SOL), wrap SOL to WSOL
  if (quoteToken.mint.equals(NATIVE_MINT)) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        ataIn,
        wallet.publicKey,
        NATIVE_MINT
      )
    );
    preInstructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: ataIn,
        lamports: BigInt(quoteAmount.raw.toString()),
      })
    );
    preInstructions.push(createSyncNativeInstruction(ataIn));
  }

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [...preInstructions, ...innerTransaction.instructions],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet, ...innerTransaction.signers]);

  logger.info('Executing swap transaction...');
  return txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
}

/**
 * Main test trade function
 */
async function main() {
  const { poolId, dryRun, amount } = parseArgs();

  console.log('\n========================================');
  console.log('        TEST TRADE SCRIPT');
  console.log('========================================\n');

  // Initialize connection
  const connection = new Connection(RPC_ENDPOINT, {
    commitment: COMMITMENT_LEVEL,
  });

  // Get wallet
  const wallet = getWallet(PRIVATE_KEY.trim());
  logger.info({ wallet: wallet.publicKey.toString() }, 'Wallet loaded');

  // Check wallet balance
  const balance = await connection.getBalance(wallet.publicKey);
  logger.info({ balance: (balance / LAMPORTS_PER_SOL).toFixed(4) }, 'Wallet balance (SOL)');

  // Get quote token configuration
  const quoteToken = getToken(QUOTE_MINT);

  // Determine trade amount (convert to number for arithmetic)
  const tradeAmount = amount !== null ? amount : parseFloat(QUOTE_AMOUNT);
  const quoteAmount = new TokenAmount(quoteToken, tradeAmount, false);

  logger.info({
    quoteToken: quoteToken.symbol,
    amount: quoteAmount.toFixed(),
    slippage: `${BUY_SLIPPAGE}%`,
    executor: TRANSACTION_EXECUTOR,
    dryRun,
  }, 'Trade configuration');

  // Check balance is sufficient
  const requiredLamports = Math.ceil(tradeAmount * LAMPORTS_PER_SOL) + 0.01 * LAMPORTS_PER_SOL; // Add buffer for fees
  if (balance < requiredLamports) {
    logger.error({
      have: (balance / LAMPORTS_PER_SOL).toFixed(4),
      need: (requiredLamports / LAMPORTS_PER_SOL).toFixed(4),
    }, 'Insufficient balance');
    process.exit(1);
  }

  // Fetch pool state
  const poolPubkey = new PublicKey(poolId);
  const poolState = await fetchPoolState(connection, poolPubkey);

  logger.info({
    baseMint: poolState.baseMint.toString(),
    quoteMint: poolState.quoteMint.toString(),
    lpMint: poolState.lpMint.toString(),
    baseDecimals: poolState.baseDecimal.toNumber(),
    quoteDecimals: poolState.quoteDecimal.toNumber(),
  }, 'Pool state loaded');

  // Verify quote token matches
  if (!poolState.quoteMint.equals(quoteToken.mint)) {
    logger.error({
      expected: quoteToken.mint.toString(),
      actual: poolState.quoteMint.toString(),
    }, 'Quote token mismatch! Pool uses different quote token');
    process.exit(1);
  }

  // Fetch market state
  const marketState = await fetchMarketState(connection, poolState.marketId);

  // Create pool keys
  const poolKeys = createPoolKeys(poolPubkey, poolState, marketState);
  logger.info({ poolId: poolKeys.id.toString() }, 'Pool keys created');

  // Create transaction executor
  const txExecutor = createTransactionExecutor(connection);

  // Execute the swap
  console.log('\n----------------------------------------');
  console.log(dryRun ? '  SIMULATING SWAP (DRY RUN)' : '  EXECUTING SWAP');
  console.log('----------------------------------------\n');

  try {
    const result = await executeTestSwap(
      connection,
      poolKeys,
      wallet,
      quoteToken,
      quoteAmount,
      BUY_SLIPPAGE,
      txExecutor,
      dryRun
    );

    if (result.confirmed) {
      console.log('\n========================================');
      console.log('  SWAP SUCCESSFUL!');
      console.log('========================================');
      logger.info({
        signature: result.signature,
        url: result.signature !== 'DRY_RUN_SIMULATED'
          ? `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`
          : 'N/A (dry run)',
      }, 'Transaction confirmed');
    } else {
      console.log('\n========================================');
      console.log('  SWAP FAILED');
      console.log('========================================');
      logger.error({ error: result.error }, 'Transaction failed');
      process.exit(1);
    }
  } catch (error) {
    console.log('\n========================================');
    console.log('  SWAP ERROR');
    console.log('========================================');
    logger.error({ error: error instanceof Error ? error.message : error }, 'Swap execution failed');
    process.exit(1);
  }
}

// Run
main().catch((error) => {
  logger.error({ error }, 'Test trade script failed');
  process.exit(1);
});
