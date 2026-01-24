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
import { makeSwapCpmmBaseInInstruction } from '@raydium-io/raydium-sdk-v2';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters, PoolFilterResults, DetailedFilterResult } from './filters';
import bs58 from 'bs58';
import { TransactionExecutor } from './transactions';
import { StoredFilterResult } from './persistence';
import {
  createPoolKeys,
  logger,
  NETWORK,
  sleep,
  CpmmPoolState,
  CpmmPoolKeys,
  createCpmmPoolKeys,
  getCpmmSwapAccounts,
  computeCpmmSwapOutput,
  computeMinAmountOut,
} from './helpers';
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

/**
 * Options for buy operation
 */
export interface BuyOptions {
  /** Skip persistence checks (seen pool, open position, pending trade) - used for manual/test trades */
  skipChecks?: boolean;
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

  public async buy(accountId: PublicKey, poolState: LiquidityStateV4, options?: BuyOptions): Promise<BuyResult> {
    const tokenMint = poolState.baseMint.toString();
    const poolId = accountId.toString();
    const skipChecks = options?.skipChecks ?? false;
    logger.debug({ mint: tokenMint, poolId, skipChecks }, `Processing new pool...`);

    // === PERSISTENCE CHECK: Seen pools ===
    // Skip these checks for manual/test trades
    const stateStore = getStateStore();
    if (stateStore && !skipChecks) {
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
          poolType: 'AmmV4',
          filterResults: [],
          riskCheckPassed: false,
          riskCheckReason: 'Token is blacklisted',
          summary: 'Blacklisted token - skipped',
        });
      }
      return { success: false, error: 'Token is blacklisted' };
    }

    if (!skipChecks && this.config.useSnipeList && !this.snipeListCache?.isInList(tokenMint)) {
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
          poolType: 'AmmV4',
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
            poolType: 'AmmV4',
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
                poolType: 'AmmV4',
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
                poolType: 'AmmV4',
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

      // Build transaction once before retry loop to avoid duplicate trades
      // Each retry will re-submit the SAME transaction, not create a new one
      let currentTx: PreparedTransaction | null = preparedTx;
      if (!currentTx) {
        currentTx = await this.prepareSwapTransaction(
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

      if (!currentTx) {
        logger.error({ mint: tokenMint }, 'Failed to prepare buy transaction');
        return { success: false, error: 'Failed to prepare transaction' };
      }

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          // Get current signature (may change if we refresh the transaction)
          const currentSig = bs58.encode(currentTx.transaction.signatures[0]);
          logger.info(
            { mint: tokenMint, signature: currentSig },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );

          // Check if blockhash expired - if so, rebuild transaction with new blockhash
          // but same instructions (this creates a new signature, so check if old tx landed first)
          if (i > 0 && !this.isBlockhashValid(currentTx)) {
            // Before creating new tx, check if the previous one actually landed
            logger.trace({ mint: tokenMint, signature: currentSig }, 'Blockhash expired, checking if tx landed');
            try {
              const txStatus = await this.connection.getSignatureStatus(currentSig);
              if (txStatus.value?.confirmationStatus === 'confirmed' ||
                  txStatus.value?.confirmationStatus === 'finalized') {
                logger.info({ mint: tokenMint, signature: currentSig }, 'Transaction already confirmed on retry check');
                successSignature = currentSig;
                break;
              }
            } catch {
              // Ignore errors checking status, proceed with new tx
            }

            logger.trace({ mint: tokenMint }, 'Previous tx not confirmed, creating new tx with fresh blockhash');
            const refreshedTx = await this.prepareSwapTransaction(
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
            if (!refreshedTx) {
              lastError = 'Failed to refresh transaction';
              continue;
            }
            currentTx = refreshedTx;
          }

          // Re-submit the same transaction (same signature unless blockhash was refreshed)
          const result = await this.txExecutor.executeAndConfirm(
            currentTx.transaction,
            this.config.wallet,
            currentTx.latestBlockhash,
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
                poolType: 'AmmV4',
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

  // ============================================================================
  // CPMM POOL SUPPORT
  // ============================================================================

  /**
   * Buy tokens from a CPMM pool.
   * CPMM pools are newer Raydium pools that don't require OpenBook markets.
   */
  public async buyCpmm(accountId: PublicKey, poolState: CpmmPoolState, options?: BuyOptions): Promise<BuyResult> {
    // Determine which mint is the base token (the one we're buying)
    // In CPMM, mintA and mintB are ordered, so we need to figure out which is quote and which is base
    const isQuoteMintA = poolState.mintA.equals(this.config.quoteToken.mint);
    const tokenMint = isQuoteMintA ? poolState.mintB.toString() : poolState.mintA.toString();
    const tokenDecimals = isQuoteMintA ? poolState.mintDecimalB : poolState.mintDecimalA;
    const poolId = accountId.toString();
    const skipChecks = options?.skipChecks ?? false;

    logger.debug({ mint: tokenMint, poolId, poolType: 'CPMM', skipChecks }, `Processing new CPMM pool...`);

    // === PERSISTENCE CHECK: Seen pools ===
    const stateStore = getStateStore();
    if (stateStore && !skipChecks) {
      if (stateStore.hasSeenPool(poolId)) {
        logger.debug({ poolId, mint: tokenMint }, `Skipping - CPMM pool already processed`);
        return { success: false, error: 'Pool already processed' };
      }

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
        stateStore.recordPoolDetection({
          poolId,
          tokenMint,
          action: 'blacklisted',
          poolType: 'CPMM',
          filterResults: [],
          riskCheckPassed: false,
          riskCheckReason: 'Token is blacklisted',
          summary: 'Blacklisted token - skipped',
        });
      }
      return { success: false, error: 'Token is blacklisted' };
    }

    if (!skipChecks && this.config.useSnipeList && !this.snipeListCache?.isInList(tokenMint)) {
      logger.debug({ mint: tokenMint }, `Skipping buy because token is not in a snipe list`);
      if (stateStore) {
        stateStore.recordSeenPool({
          poolId,
          tokenMint,
          actionTaken: 'skipped',
          filterReason: 'Not in snipe list',
        });
        stateStore.recordPoolDetection({
          poolId,
          tokenMint,
          action: 'skipped',
          poolType: 'CPMM',
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
          stateStore.recordPoolDetection({
            poolId,
            tokenMint,
            action: 'skipped',
            poolType: 'CPMM',
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
      logger.debug({ mint: tokenMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
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
      // Create CPMM pool keys
      const poolKeys = createCpmmPoolKeys(accountId, poolState);
      const baseMint = isQuoteMintA ? poolKeys.mintB : poolKeys.mintA;
      const mintAta = await getAssociatedTokenAddress(baseMint, this.config.wallet.publicKey);

      // For CPMM, we skip the market fetch and filter checks for now
      // (CPMM pools typically don't have the same filter requirements as AmmV4)
      // TODO: Add CPMM-specific filters if needed

      // Note: For CPMM pools, we skip detailed filter checks for now
      // since they have different characteristics than AmmV4 pools
      logger.debug({ mint: tokenMint, poolType: 'CPMM' }, 'Skipping filter checks for CPMM pool');

      // Build transaction
      let currentTx: PreparedTransaction | null = await this.prepareCpmmSwapTransaction(
        poolKeys,
        poolState,
        this.config.quoteAta,
        mintAta,
        this.config.quoteToken.mint,
        baseMint,
        this.config.quoteAmount,
        this.config.buySlippage,
        this.config.wallet,
        'buy',
      );

      if (!currentTx) {
        logger.error({ mint: tokenMint }, 'Failed to prepare CPMM buy transaction');
        return { success: false, error: 'Failed to prepare transaction' };
      }

      let lastError: string | undefined;
      let successSignature: string | undefined;

      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          // Ensure we have a valid transaction
          if (!currentTx) {
            lastError = 'No valid transaction to execute';
            continue;
          }

          const currentSig = bs58.encode(currentTx.transaction.signatures[0]);
          logger.info(
            { mint: tokenMint, signature: currentSig, poolType: 'CPMM' },
            `Send CPMM buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );

          // Check if blockhash expired
          if (i > 0 && !this.isBlockhashValid(currentTx)) {
            logger.trace({ mint: tokenMint, signature: currentSig }, 'Blockhash expired, checking if tx landed');
            try {
              const txStatus = await this.connection.getSignatureStatus(currentSig);
              if (txStatus.value?.confirmationStatus === 'confirmed' ||
                  txStatus.value?.confirmationStatus === 'finalized') {
                logger.info({ mint: tokenMint, signature: currentSig }, 'Transaction already confirmed on retry check');
                successSignature = currentSig;
                break;
              }
            } catch (e) {
              // Ignore status check errors
            }

            // Rebuild transaction with new blockhash
            currentTx = await this.prepareCpmmSwapTransaction(
              poolKeys,
              poolState,
              this.config.quoteAta,
              mintAta,
              this.config.quoteToken.mint,
              baseMint,
              this.config.quoteAmount,
              this.config.buySlippage,
              this.config.wallet,
              'buy',
            );

            if (!currentTx) {
              lastError = 'Failed to refresh transaction';
              continue;
            }
          }

          const result = await this.txExecutor.executeAndConfirm(
            currentTx.transaction,
            this.config.wallet,
            currentTx.latestBlockhash,
          );

          if (result.confirmed) {
            successSignature = result.signature;
            logger.info(
              { mint: tokenMint, signature: successSignature, poolType: 'CPMM' },
              `Confirmed CPMM buy tx`,
            );
            break;
          } else {
            lastError = result.error || 'Unknown error';
            logger.debug({ mint: tokenMint, error: lastError }, `CPMM buy transaction not confirmed, retrying...`);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          lastError = errMsg;
          logger.debug({ mint: tokenMint, error: errMsg }, `CPMM buy transaction failed, retrying...`);
        }
      }

      // Record result
      if (successSignature) {
        const entryAmountSol = parseFloat(this.config.quoteAmount.toFixed());

        if (stateStore) {
          stateStore.createPosition({
            tokenMint,
            poolId,
            entryPrice: entryAmountSol,
            amountToken: 0, // Will be updated after sell
            amountSol: entryAmountSol,
          });

          stateStore.recordSeenPool({
            poolId,
            tokenMint,
            actionTaken: 'bought',
          });

          stateStore.recordPoolDetection({
            poolId,
            tokenMint,
            action: 'bought',
            poolType: 'CPMM',
            filterResults: [],
            riskCheckPassed: true,
            summary: 'CPMM pool - bought',
          });
        }

        // Record with P&L tracker
        const pnlTracker = getPnlTracker();
        if (pnlTracker) {
          pnlTracker.recordBuy({
            tokenMint,
            amountSol: entryAmountSol,
            amountToken: 0,
            poolId,
            txSignature: successSignature,
          });
        }

        // Record exposure
        if (exposureManager) {
          exposureManager.recordTrade();
        }

        // Note: Position monitor is skipped for CPMM pools as it requires LiquidityPoolKeysV4
        // CPMM positions will be sold via wallet listener when token balance changes
        logger.debug({ mint: tokenMint, poolType: 'CPMM' }, 'CPMM position tracked - auto-sell via wallet listener');

        return { success: true, txSignature: successSignature };
      }

      // Failed
      if (stateStore) {
        stateStore.recordSeenPool({
          poolId,
          tokenMint,
          actionTaken: 'error',
          filterReason: lastError || 'Transaction failed',
        });
      }

      return { success: false, error: lastError || 'Max retries exceeded' };
    } finally {
      if (this.config.oneTokenAtATime) {
        this.mutex.release();
      }
    }
  }

  /**
   * Prepare a CPMM swap transaction.
   */
  private async prepareCpmmSwapTransaction(
    poolKeys: CpmmPoolKeys,
    poolState: CpmmPoolState,
    ataIn: PublicKey,
    ataOut: PublicKey,
    inputMint: PublicKey,
    outputMint: PublicKey,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ): Promise<PreparedTransaction | null> {
    try {
      // Get swap accounts based on direction
      const swapAccounts = getCpmmSwapAccounts(poolKeys, inputMint);

      // Fetch vault balances to compute output
      const [inputVaultInfo, outputVaultInfo] = await Promise.all([
        this.connection.getTokenAccountBalance(swapAccounts.inputVault),
        this.connection.getTokenAccountBalance(swapAccounts.outputVault),
      ]);

      const inputReserve = new BN(inputVaultInfo.value.amount);
      const outputReserve = new BN(outputVaultInfo.value.amount);

      // Get trade fee rate from config (default to 0.25% = 2500 basis points)
      // Note: In production, you might want to fetch this from the pool's configId
      const tradeFeeRate = new BN(2500); // 0.25% in basis points (1e6 = 100%)

      // Compute output amount
      const { amountOut } = computeCpmmSwapOutput(
        amountIn.raw,
        inputReserve,
        outputReserve,
        tradeFeeRate,
      );

      // Apply slippage
      const minAmountOut = computeMinAmountOut(amountOut, slippage);

      logger.trace({
        inputReserve: inputReserve.toString(),
        outputReserve: outputReserve.toString(),
        amountIn: amountIn.raw.toString(),
        amountOut: amountOut.toString(),
        minAmountOut: minAmountOut.toString(),
      }, 'CPMM swap calculation');

      const latestBlockhash = await this.connection.getLatestBlockhash();

      // Build swap instruction using V2 SDK
      const swapInstruction = makeSwapCpmmBaseInInstruction(
        poolKeys.programId,
        wallet.publicKey,
        poolKeys.authority,
        poolKeys.configId,
        poolKeys.id,
        ataIn,
        ataOut,
        swapAccounts.inputVault,
        swapAccounts.outputVault,
        swapAccounts.inputTokenProgram,
        swapAccounts.outputTokenProgram,
        swapAccounts.inputMint,
        swapAccounts.outputMint,
        poolKeys.observationId,
        amountIn.raw,
        minAmountOut,
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
            outputMint,
          ),
        );

        // If input token is WSOL (native SOL), wrap SOL to WSOL
        if (inputMint.equals(NATIVE_MINT)) {
          preInstructions.push(
            createAssociatedTokenAccountIdempotentInstruction(
              wallet.publicKey,
              ataIn,
              wallet.publicKey,
              NATIVE_MINT,
            ),
          );
          preInstructions.push(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: ataIn,
              lamports: BigInt(amountIn.raw.toString()),
            }),
          );
          preInstructions.push(createSyncNativeInstruction(ataIn));
        }
      }

      // Handle sell direction
      if (direction === 'sell') {
        // Ensure output token account exists (for receiving quote token)
        preInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            ataOut,
            wallet.publicKey,
            outputMint,
          ),
        );
        // Close the input token account after selling to recover rent
        postInstructions.push(createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey));
      }

      const messageV0 = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          ...preInstructions,
          swapInstruction,
          ...postInstructions,
        ],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([wallet]);

      return {
        transaction,
        latestBlockhash,
        preparedAt: Date.now(),
      };
    } catch (error) {
      logger.trace({ error }, 'Failed to prepare CPMM swap transaction');
      return null;
    }
  }

  /**
   * Sell tokens from a CPMM pool.
   * Called when wallet listener detects token balance change for a CPMM position.
   */
  public async sellCpmm(
    accountId: PublicKey,
    poolState: CpmmPoolState,
    rawAccount: RawAccount,
  ): Promise<void> {
    // Determine which mint is the base token (the one we're selling)
    const isQuoteMintA = poolState.mintA.equals(this.config.quoteToken.mint);
    const baseMint = isQuoteMintA ? poolState.mintB : poolState.mintA;
    const tokenMint = baseMint.toString();
    const poolId = accountId.toString();

    if (this.config.autoSellDelay > 0) {
      logger.debug({ mint: tokenMint }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
      await sleep(this.config.autoSellDelay);
    }

    const tokenAmount = new BN(rawAccount.amount.toString());
    if (tokenAmount.isZero()) {
      logger.debug({ mint: tokenMint }, 'Token balance is zero, skipping sell');
      return;
    }

    const tokenDecimals = isQuoteMintA ? poolState.mintDecimalB : poolState.mintDecimalA;
    const amountIn = new TokenAmount(
      new Token(TOKEN_PROGRAM_ID, baseMint, tokenDecimals),
      tokenAmount,
      true,
    );

    this.sellExecutionCount++;

    try {
      const poolKeys = createCpmmPoolKeys(accountId, poolState);
      const ataIn = await getAssociatedTokenAddress(baseMint, this.config.wallet.publicKey);
      const ataOut = this.config.quoteAta;

      let currentTx: PreparedTransaction | null = await this.prepareCpmmSwapTransaction(
        poolKeys,
        poolState,
        ataIn,
        ataOut,
        baseMint,
        this.config.quoteToken.mint,
        amountIn,
        this.config.sellSlippage,
        this.config.wallet,
        'sell',
      );

      if (!currentTx) {
        logger.error({ mint: tokenMint }, 'Failed to prepare CPMM sell transaction');
        return;
      }

      let successSignature: string | undefined;

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          // Ensure we have a valid transaction
          if (!currentTx) {
            continue;
          }

          const currentSig = bs58.encode(currentTx.transaction.signatures[0]);
          logger.info(
            { mint: tokenMint, signature: currentSig, poolType: 'CPMM' },
            `Send CPMM sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          // Check if blockhash expired
          if (i > 0 && !this.isBlockhashValid(currentTx)) {
            try {
              const txStatus = await this.connection.getSignatureStatus(currentSig);
              if (txStatus.value?.confirmationStatus === 'confirmed' ||
                  txStatus.value?.confirmationStatus === 'finalized') {
                logger.info({ mint: tokenMint, signature: currentSig }, 'CPMM sell transaction already confirmed');
                successSignature = currentSig;
                break;
              }
            } catch (e) {
              // Ignore
            }

            currentTx = await this.prepareCpmmSwapTransaction(
              poolKeys,
              poolState,
              ataIn,
              ataOut,
              baseMint,
              this.config.quoteToken.mint,
              amountIn,
              this.config.sellSlippage,
              this.config.wallet,
              'sell',
            );

            if (!currentTx) {
              continue;
            }
          }

          const result = await this.txExecutor.executeAndConfirm(
            currentTx.transaction,
            this.config.wallet,
            currentTx.latestBlockhash,
          );

          if (result.confirmed) {
            successSignature = result.signature;
            logger.info(
              { mint: tokenMint, signature: successSignature, poolType: 'CPMM' },
              `Confirmed CPMM sell tx`,
            );
            break;
          } else {
            logger.debug({ mint: tokenMint, error: result.error }, `CPMM sell transaction not confirmed, retrying...`);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          logger.debug({ mint: tokenMint, error: errMsg }, `CPMM sell transaction failed, retrying...`);
        }
      }

      if (successSignature) {
        const stateStore = getStateStore();
        if (stateStore) {
          stateStore.closePosition(tokenMint, successSignature);
        }

        // Record with P&L tracker
        const pnlTracker = getPnlTracker();
        if (pnlTracker) {
          // Calculate approximate sell value based on current price
          // This is a simplification - in production you might want to use actual received amount
          pnlTracker.recordSell({
            tokenMint,
            amountSol: parseFloat(this.config.quoteAmount.toFixed()),
            amountToken: parseFloat(tokenAmount.toString()),
            poolId,
            txSignature: successSignature,
          });
        }

        // Remove from position monitor
        const positionMonitor = getPositionMonitor();
        if (positionMonitor) {
          positionMonitor.removePosition(tokenMint);
        }

        // Remove from exposure manager
        const exposureManager = getExposureManager();
        if (exposureManager) {
          exposureManager.removePosition(tokenMint);
        }
      }
    } finally {
      this.sellExecutionCount--;
    }
  }
}
