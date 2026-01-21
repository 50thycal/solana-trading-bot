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
import { PoolFilters, PoolFilterResults, DetailedFilterResult } from './filters';
import { TransactionExecutor } from './transactions';
import { StoredFilterResult } from './persistence';
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
import { getStateStore } from './persistence';
import { PRECOMPUTE_TRANSACTION } from './helpers/constants';

/**
 * Prepared transaction ready for execution
 */
interface PreparedTransaction {
  transaction: VersionedTransaction;
  latestBlockhash: { blockhash: string; lastValidBlockHeight: number };
  preparedAt: number; // timestamp when prepared
}

/**
 * Result from a buy operation
 */
export interface BuyResult {
  success: boolean;
  txSignature?: string;
  error?: string;
}

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

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4): Promise<BuyResult> {
    const tokenMint = poolState.baseMint.toString();
    const poolId = accountId.toString();
    logger.debug({ mint: tokenMint, poolId }, `Processing new pool...`);

    // === PERSISTENCE CHECK: Seen pools ===
    const stateStore = getStateStore();
    if (stateStore) {
      // Check if we've already processed this pool
      if (stateStore.hasSeenPool(poolId)) {
        logger.debug({ poolId, mint: tokenMint }, `Skipping - pool already processed`);
        return { success: false, error: 'Pool already processed' };
      }

      // Check if we already have an open position for this token
      if (stateStore.hasOpenPosition(tokenMint)) {
        logger.debug({ mint: tokenMint }, `Skipping buy - already have open position`);
        stateStore.recordSeenPool({
          poolId,
          tokenMint,
          actionTaken: 'skipped',
          filterReason: 'Already have open position',
        });
        return { success: false, error: 'Already have open position' };
      }

      // Check for pending buy trade (idempotency)
      const pendingTrade = stateStore.getPendingTradeForToken(tokenMint, 'buy');
      if (pendingTrade) {
        logger.debug({ mint: tokenMint, tradeId: pendingTrade.id }, `Skipping buy - pending trade exists`);
        return { success: false, error: 'Pending trade exists' };
      }
    }

    // === RISK CHECK 1: Blacklist ===
    const blacklist = getBlacklist();
    if (blacklist.isTokenBlacklisted(tokenMint)) {
      logger.debug({ mint: tokenMint }, `Skipping buy - token is blacklisted`);
      if (stateStore) {
        stateStore.recordSeenPool({
          poolId,
          tokenMint,
          actionTaken: 'blacklisted',
          filterReason: 'Token is blacklisted',
        });

        // Record for dashboard
        stateStore.recordPoolDetection({
          poolId,
          tokenMint,
          action: 'blacklisted',
          filterResults: [],
          riskCheckPassed: false,
          riskCheckReason: 'Token is blacklisted',
          summary: 'Blacklisted token - skipped',
        });
      }
      return { success: false, error: 'Token is blacklisted' };
    }

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(tokenMint)) {
      logger.debug({ mint: tokenMint }, `Skipping buy because token is not in a snipe list`);
      if (stateStore) {
        stateStore.recordSeenPool({
          poolId,
          tokenMint,
          actionTaken: 'skipped',
          filterReason: 'Not in snipe list',
        });

        // Record for dashboard
        stateStore.recordPoolDetection({
          poolId,
          tokenMint,
          action: 'skipped',
          filterResults: [],
          riskCheckPassed: true,
          riskCheckReason: 'Not in snipe list',
          summary: 'Not in snipe list - skipped',
        });
      }
      return { success: false, error: 'Not in snipe list' };
    }

    // === RISK CHECK 2: Exposure and balance ===
    const exposureManager = getExposureManager();
    if (exposureManager) {
      const tradeAmount = parseFloat(this.config.quoteAmount.toFixed());
      const exposureCheck = await exposureManager.canTrade(tradeAmount);

      if (!exposureCheck.allowed) {
        logger.warn({ mint: tokenMint, reason: exposureCheck.reason }, `Skipping buy - risk limit exceeded`);
        if (stateStore) {
          stateStore.recordSeenPool({
            poolId,
            tokenMint,
            actionTaken: 'skipped',
            filterReason: exposureCheck.reason || 'Risk limit exceeded',
          });

          // Record for dashboard
          stateStore.recordPoolDetection({
            poolId,
            tokenMint,
            action: 'skipped',
            filterResults: [],
            riskCheckPassed: false,
            riskCheckReason: exposureCheck.reason || 'Risk limit exceeded',
            summary: `Risk limit: ${exposureCheck.reason || 'Exposure limit exceeded'}`,
          });
        }
        return { success: false, error: exposureCheck.reason || 'Risk limit exceeded' };
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
        return { success: false, error: 'Another trade is in progress' };
      }

      await this.mutex.acquire();
    }

    try {
      const [market, mintAta] = await Promise.all([
        this.marketStorage.get(poolState.marketId.toString()),
        getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
      ]);
      const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);
      const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys.baseMint, poolKeys.baseDecimals);

      // Pre-compute optimization: prepare transaction in parallel with filter checks
      let preparedTx: PreparedTransaction | null = null;
      let filterResults: PoolFilterResults | null = null;

      if (!this.config.useSnipeList) {
        if (PRECOMPUTE_TRANSACTION) {
          // Run filter check and transaction preparation in parallel
          logger.trace({ mint: tokenMint }, 'Running filter check and tx preparation in parallel');

          const [detailedFilterResults, txPrep] = await Promise.all([
            this.filterMatchWithDetails(poolKeys),
            this.prepareSwapTransaction(
              poolKeys,
              this.config.quoteAta,
              mintAta,
              this.config.quoteToken,
              tokenOut,
              this.config.quoteAmount,
              this.config.buySlippage,
              this.config.wallet,
              'buy',
            ),
          ]);

          filterResults = detailedFilterResults;

          if (!filterResults.allPassed) {
            logger.debug({ mint: poolKeys.baseMint.toString(), summary: filterResults.summary }, `Skipping buy because pool doesn't match filters`);

            // Record detailed filter results for dashboard
            if (stateStore) {
              stateStore.recordSeenPool({
                poolId,
                tokenMint,
                actionTaken: 'filtered',
                filterReason: filterResults.summary,
              });

              // Record detailed pool detection for dashboard
              stateStore.recordPoolDetection({
                poolId,
                tokenMint,
                action: 'filtered',
                filterResults: this.convertToStoredFilterResults(filterResults.filters),
                riskCheckPassed: true,
                summary: filterResults.summary,
              });
            }
            return { success: false, error: `Filter failed: ${filterResults.summary}` };
          }

          preparedTx = txPrep;

          // Check if blockhash is still valid, refresh if needed
          if (preparedTx && !this.isBlockhashValid(preparedTx)) {
            logger.trace({ mint: tokenMint }, 'Blockhash expired, refreshing transaction');
            preparedTx = await this.refreshPreparedTransaction(
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
          }
        } else {
          // Sequential: run filter check first, then build transaction
          filterResults = await this.filterMatchWithDetails(poolKeys);

          if (!filterResults.allPassed) {
            logger.debug({ mint: poolKeys.baseMint.toString(), summary: filterResults.summary }, `Skipping buy because pool doesn't match filters`);

            // Record detailed filter results for dashboard
            if (stateStore) {
              stateStore.recordSeenPool({
                poolId,
                tokenMint,
                actionTaken: 'filtered',
                filterReason: filterResults.summary,
              });

              // Record detailed pool detection for dashboard
              stateStore.recordPoolDetection({
                poolId,
                tokenMint,
                action: 'filtered',
                filterResults: this.convertToStoredFilterResults(filterResults.filters),
                riskCheckPassed: true,
                summary: filterResults.summary,
              });
            }
            return { success: false, error: `Filter failed: ${filterResults.summary}` };
          }
        }
      }

      let lastError: string | undefined;
      let successSignature: string | undefined;

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          logger.info(
            { mint: tokenMint },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );

          let result;

          // Use pre-computed transaction on first attempt if available
          if (i === 0 && preparedTx) {
            logger.trace({ mint: tokenMint }, 'Using pre-computed transaction');
            result = await this.txExecutor.executeAndConfirm(
              preparedTx.transaction,
              this.config.wallet,
              preparedTx.latestBlockhash,
            );
          } else {
            // Fall back to regular swap for retries or if precompute failed
            result = await this.swap(
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
          }

          if (result.confirmed) {
            logger.info(
              {
                mint: tokenMint,
                signature: result.signature,
                url: `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`,
              },
              `Confirmed buy tx`,
            );

            successSignature = result.signature;

            // === Record trade and register position ===
            const entryAmountSol = parseFloat(this.config.quoteAmount.toFixed());

            // Create position in SQLite for persistence
            if (stateStore) {
              const takeProfitSol = entryAmountSol * (1 + this.config.takeProfit / 100);
              const stopLossSol = entryAmountSol * (1 - this.config.stopLoss / 100);

              stateStore.createPosition({
                tokenMint,
                entryPrice: entryAmountSol, // Will be updated with actual price
                amountToken: 0, // Will be updated when we know the exact amount
                amountSol: entryAmountSol,
                poolId,
                takeProfitSol,
                stopLossSol,
              });

              // Record as bought in seen pools
              stateStore.recordSeenPool({
                poolId,
                tokenMint,
                actionTaken: 'bought',
              });

              // Record detailed pool detection for dashboard (bought)
              stateStore.recordPoolDetection({
                poolId,
                tokenMint,
                action: 'bought',
                filterResults: filterResults
                  ? this.convertToStoredFilterResults(filterResults.filters)
                  : [],
                riskCheckPassed: true,
                summary: 'All filters passed - token purchased',
              });
            }

            // Record with P&L tracker
            const pnlTracker = getPnlTracker();
            pnlTracker.recordBuy({
              tokenMint,
              amountSol: entryAmountSol,
              amountToken: 0, // Will be updated when we know the exact amount
              poolId,
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
                poolId,
                poolKeys,
                tokenAmount,
                entryAmountSol,
              });
            }

            break;
          }

          // Transaction was not confirmed - store the error
          lastError = result.error || `Transaction not confirmed (signature: ${result.signature})`;
          logger.info(
            {
              mint: tokenMint,
              signature: result.signature,
              error: result.error,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          logger.debug({ mint: tokenMint, error }, `Error confirming buy transaction`);
        }
      }

      // Return result based on whether we succeeded
      if (successSignature) {
        return { success: true, txSignature: successSignature };
      }

      // All retries failed
      const errorMsg = `All ${this.config.maxBuyRetries} buy attempts failed. Last error: ${lastError || 'Unknown error'}`;
      logger.error({ mint: tokenMint, error: lastError }, errorMsg);
      return { success: false, error: errorMsg };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error({ mint: tokenMint, error }, `Failed to buy token`);
      return { success: false, error: errorMsg };
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

            // Close position in SQLite
            const stateStore = getStateStore();
            if (stateStore) {
              stateStore.closePosition(tokenMint, 'sold');
            }

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

    logger.debug(
      { mint: poolKeys.baseMint.toString(), totalChecks: timesToCheck, interval: this.config.filterCheckInterval },
      'Starting filter checks'
    );

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

  /**
   * Run filter checks and return detailed results for dashboard tracking.
   * Uses consecutive match system like filterMatch but returns full details.
   */
  private async filterMatchWithDetails(poolKeys: LiquidityPoolKeysV4): Promise<PoolFilterResults> {
    // If filtering is disabled, return all passed
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return {
        tokenMint: poolKeys.baseMint.toString(),
        poolId: poolKeys.id.toString(),
        filters: [],
        allPassed: true,
        summary: 'Filtering disabled',
        checkedAt: Date.now(),
      };
    }

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;
    let lastResults: PoolFilterResults | null = null;

    logger.debug(
      { mint: poolKeys.baseMint.toString(), totalChecks: timesToCheck, interval: this.config.filterCheckInterval },
      'Starting detailed filter checks'
    );

    do {
      try {
        // Get detailed filter results
        lastResults = await this.poolFilters.executeWithDetails(poolKeys);

        if (lastResults.allPassed) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return lastResults;
          }
        } else {
          matchCount = 0;
        }

        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    // Return the last results (which didn't pass)
    return lastResults || {
      tokenMint: poolKeys.baseMint.toString(),
      poolId: poolKeys.id.toString(),
      filters: [],
      allPassed: false,
      summary: 'Filter check timed out',
      checkedAt: Date.now(),
    };
  }

  /**
   * Convert DetailedFilterResult[] to StoredFilterResult[] for database storage
   */
  private convertToStoredFilterResults(filters: DetailedFilterResult[]): StoredFilterResult[] {
    return filters.map((f) => ({
      name: f.name,
      displayName: f.displayName,
      passed: f.passed,
      checked: f.checked,
      reason: f.reason,
      expectedValue: f.details?.expected,
      actualValue: f.details?.actual,
      numericValue: f.details?.value,
    }));
  }

  /**
   * Pre-compute a swap transaction for faster execution.
   * Prepares all transaction data but doesn't send it.
   */
  private async prepareSwapTransaction(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ): Promise<PreparedTransaction | null> {
    try {
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

      return {
        transaction,
        latestBlockhash,
        preparedAt: Date.now(),
      };
    } catch (error) {
      logger.trace({ error }, 'Failed to prepare swap transaction');
      return null;
    }
  }

  /**
   * Check if a prepared transaction's blockhash is still likely valid.
   * Blockhashes are valid for ~60-90 seconds (150 slots * 400ms).
   * We use a conservative threshold of 45 seconds.
   */
  private isBlockhashValid(preparedTx: PreparedTransaction): boolean {
    const maxAgeMs = 45000; // 45 seconds
    const age = Date.now() - preparedTx.preparedAt;
    return age < maxAgeMs;
  }

  /**
   * Refresh a prepared transaction with a new blockhash.
   */
  private async refreshPreparedTransaction(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ): Promise<PreparedTransaction | null> {
    logger.trace('Refreshing prepared transaction with new blockhash');
    return this.prepareSwapTransaction(
      poolKeys,
      ataIn,
      ataOut,
      tokenIn,
      tokenOut,
      amountIn,
      slippage,
      wallet,
      direction,
    );
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
