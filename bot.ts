import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddress,
  NATIVE_MINT,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import { TransactionExecutor } from './transactions';
import { createPoolKeys, logger, NETWORK, sleep } from './helpers';
import { Mutex } from 'async-mutex';
import BN from 'bn.js';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import {
  getBlacklist,
  getExposureManager,
  getPnlTracker,
  getPositionMonitor,
} from './risk';

export interface BotConfig {
  wallet: Keypair;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkBurned: boolean;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  oneTokenAtATime: boolean;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
}

export class Bot {
  private readonly poolFilters: PoolFilters;

  // snipe list
  private readonly snipeListCache?: SnipeListCache;

  // one token at the time
  private readonly mutex: Mutex;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.mutex = new Mutex();
    this.poolFilters = new PoolFilters(connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    });

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    // For WSOL (native SOL), check native balance instead of token account
    if (this.config.quoteToken.mint.equals(NATIVE_MINT)) {
      const balance = await this.connection.getBalance(this.config.wallet.publicKey);
      const requiredLamports = Math.ceil(parseFloat(this.config.quoteAmount.toFixed()) * LAMPORTS_PER_SOL);
      const minBalance = requiredLamports + 0.05 * LAMPORTS_PER_SOL; // Add buffer for fees

      if (balance < minBalance) {
        logger.error(
          `Insufficient SOL balance. Have: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, Need: ${(minBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL (${this.config.quoteAmount.toFixed()} for trading + 0.05 for fees)`,
        );
        return false;
      }

      logger.info(`SOL balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL (sufficient for trading)`);
      return true;
    }

    // For other tokens (like USDC), check the token account exists
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4) {
    logger.trace({ mint: poolState.baseMint }, `Processing new pool...`);
    const tokenMint = poolState.baseMint.toString();

    // === RISK CHECK 1: Blacklist ===
    const blacklist = getBlacklist();
    if (blacklist.isTokenBlacklisted(tokenMint)) {
      logger.debug({ mint: tokenMint }, `Skipping buy - token is blacklisted`);
      return;
    }

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(tokenMint)) {
      logger.debug({ mint: tokenMint }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    // === RISK CHECK 2: Exposure and balance ===
    const exposureManager = getExposureManager();
    if (exposureManager) {
      const tradeAmount = parseFloat(this.config.quoteAmount.toFixed());
      const exposureCheck = await exposureManager.canTrade(tradeAmount);

      if (!exposureCheck.allowed) {
        logger.warn({ mint: tokenMint, reason: exposureCheck.reason }, `Skipping buy - risk limit exceeded`);
        return;
      }
    }

    if (this.config.autoBuyDelay > 0) {
      logger.debug({ mint: poolState.baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
      await sleep(this.config.autoBuyDelay);
    }

    if (this.config.oneTokenAtATime) {
      if (this.mutex.isLocked() || this.sellExecutionCount > 0) {
        logger.debug(
          { mint: tokenMint },
          `Skipping buy because one token at a time is turned on and token is already being processed`,
        );
        return;
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

      if (!this.config.useSnipeList) {
        const match = await this.filterMatch(poolKeys);

        if (!match) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
          return;
        }
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: tokenMint },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );
          const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);
          const result = await this.swap(
            poolKeys,
            this.config.quoteAta,
            mintAta,
            this.config.quoteToken,
            tokenOut,
            this.config.quoteAmount,
            this.config.buySlippage,
            this.config.wallet,
            'buy',
          );

          if (result.confirmed) {
            logger.info(
              {
                mint: tokenMint,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            // === Record trade and register position ===
            const entryAmountSol = parseFloat(this.config.quoteAmount.toFixed());

            // Record with P&L tracker
            const pnlTracker = getPnlTracker();
            pnlTracker.recordBuy({
              tokenMint,
              amountSol: entryAmountSol,
              amountToken: 0, // Will be updated when we know the exact amount
              poolId: accountId.toString(),
              txSignature: result.signature,
            });

            // Record trade with exposure manager
            if (exposureManager) {
              exposureManager.recordTrade();
            }

            // Register position with monitor for persistent TP/SL
            const positionMonitor = getPositionMonitor();
            if (positionMonitor) {
              // We need to fetch the actual token amount received
              // For now, estimate based on pool info
              const tokenAmount = new TokenAmount(tokenOut, 0, true);
              positionMonitor.addPosition({
                tokenMint,
                poolId: accountId.toString(),
                poolKeys,
                tokenAmount,
                entryAmountSol,
              });
            }

            break;
          }

          logger.info(
            {
              mint: tokenMint,
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: tokenMint, error }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: tokenMint, error }, `Failed to buy token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    if (this.config.oneTokenAtATime) {
      this.sellExecutionCount++;
    }

    const tokenMint = rawAccount.mint.toString();

    try {
      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      const poolData = await this.poolStorage.get(tokenMint);

      if (!poolData) {
        logger.trace({ mint: tokenMint }, `Token pool data is not found, can't sell`);
        return;
      }

      const tokenIn = new Token(TOKEN_PROGRAM_ID, poolData.state.baseMint, poolData.state.baseDecimal.toNumber());
      const tokenAmountIn = new TokenAmount(tokenIn, rawAccount.amount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: tokenMint }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: rawAccount.mint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      const market = await this.marketStorage.get(poolData.state.marketId.toString());
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(new PublicKey(poolData.id), poolData.state, market);

      // Check if position monitor is managing this position
      const positionMonitor = getPositionMonitor();
      const isMonitoredPosition = positionMonitor?.hasPosition(tokenMint);

      // Only run legacy priceMatch if position monitor is not handling this position
      if (!isMonitoredPosition) {
        await this.priceMatch(tokenAmountIn, poolKeys);
      }

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          logger.info(
            { mint: rawAccount.mint },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          const result = await this.swap(
            poolKeys,
            accountId,
            this.config.quoteAta,
            tokenIn,
            this.config.quoteToken,
            tokenAmountIn,
            this.config.sellSlippage,
            this.config.wallet,
            'sell',
          );

          if (result.confirmed) {
            logger.info(
              {
                dex: `https://dexscreener.com/solana/${tokenMint}?maker=${this.config.wallet.publicKey}`,
                mint: tokenMint,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed sell tx`,
            );

            // === Record sell with P&L tracker ===
            const pnlTracker = getPnlTracker();
            // Estimate SOL received (actual amount comes from tx, but we estimate here)
            const tokenAmount = parseFloat(tokenAmountIn.toFixed());
            pnlTracker.recordSell({
              tokenMint,
              amountSol: 0, // Will be calculated from entry price
              amountToken: tokenAmount,
              poolId: poolData.id,
              txSignature: result.signature,
            });

            // Remove from position monitor
            if (positionMonitor) {
              positionMonitor.removePosition(tokenMint);
            }

            // Remove from exposure manager
            const exposureManager = getExposureManager();
            if (exposureManager) {
              exposureManager.removePosition(tokenMint);
            }

            break;
          }

          logger.info(
            {
              mint: tokenMint,
              signature: result.signature,
              error: result.error,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: tokenMint, error }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: tokenMint, error }, `Failed to sell token`);
    } finally {
      if (this.config.oneTokenAtATime) {
        this.sellExecutionCount--;
      }
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    // Build pre-swap instructions
    const preInstructions = [];
    const postInstructions = [];

    // Add compute budget instructions if not using Warp/Jito
    if (!this.isWarp && !this.isJito) {
      preInstructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
      );
    }

    // Handle WSOL wrapping for buy direction
    if (direction === 'buy') {
      // Create output token account
      preInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey,
          ataOut,
          wallet.publicKey,
          tokenOut.mint,
        ),
      );

      // If input token is WSOL (native SOL), wrap SOL to WSOL
      if (tokenIn.mint.equals(NATIVE_MINT)) {
        // Create WSOL account if needed
        preInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            ataIn,
            wallet.publicKey,
            NATIVE_MINT,
          ),
        );
        // Transfer SOL to the WSOL account
        preInstructions.push(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: ataIn,
            lamports: BigInt(amountIn.raw.toString()),
          }),
        );
        // Sync native to update the WSOL balance
        preInstructions.push(createSyncNativeInstruction(ataIn));
      }
    }

    // Handle sell direction
    if (direction === 'sell') {
      // Close the input token account after selling to recover rent
      postInstructions.push(createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey));
    }

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...preInstructions,
        ...innerTransaction.instructions,
        ...postInstructions,
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await this.poolFilters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }

  private async priceMatch(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
    if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
      return;
    }

    const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
    const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
    const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
    const takeProfit = this.config.quoteAmount.add(profitAmount);

    const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
    const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
    const stopLoss = this.config.quoteAmount.subtract(lossAmount);
    const slippage = new Percent(this.config.sellSlippage, 100);
    let timesChecked = 0;

    do {
      try {
        const poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys,
        });

        const amountOut = Liquidity.computeAmountOut({
          poolKeys,
          poolInfo,
          amountIn: amountIn,
          currencyOut: this.config.quoteToken,
          slippage,
        }).amountOut;

        logger.debug(
          { mint: poolKeys.baseMint.toString() },
          `Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
        );

        if (amountOut.lt(stopLoss)) {
          break;
        }

        if (amountOut.gt(takeProfit)) {
          break;
        }

        await sleep(this.config.priceCheckInterval);
      } catch (e) {
        logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);
  }
}
