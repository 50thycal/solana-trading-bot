import {
  BlockhashWithExpiryBlockHeight,
  Keypair,
  PublicKey,
  SystemProgram,
  Connection,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import {
  logger,
  SIMULATE_TRANSACTION,
  JITO_BUNDLE_TIMEOUT,
  JITO_BUNDLE_POLL_INTERVAL,
} from '../helpers';
import axios, { AxiosError } from 'axios';
import bs58 from 'bs58';
import { Currency, CurrencyAmount } from '@raydium-io/raydium-sdk';

export class JitoTransactionExecutor implements TransactionExecutor {
  // https://jito-labs.gitbook.io/mev/searcher-resources/json-rpc-api-reference/bundles/gettipaccounts
  private jitpTipAccounts = [
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  ];

  private JitoFeeWallet: PublicKey;
  private readonly bundleTimeout: number;
  private readonly bundlePollInterval: number;
  private readonly simulateEnabled: boolean;

  constructor(
    private readonly jitoFee: string,
    private readonly connection: Connection,
    simulateEnabled: boolean = SIMULATE_TRANSACTION,
    bundleTimeout: number = JITO_BUNDLE_TIMEOUT,
    bundlePollInterval: number = JITO_BUNDLE_POLL_INTERVAL,
  ) {
    this.JitoFeeWallet = this.getRandomValidatorKey();
    this.simulateEnabled = simulateEnabled;
    this.bundleTimeout = bundleTimeout;
    this.bundlePollInterval = bundlePollInterval;
  }

  private getRandomValidatorKey(): PublicKey {
    const randomValidator = this.jitpTipAccounts[Math.floor(Math.random() * this.jitpTipAccounts.length)];
    return new PublicKey(randomValidator);
  }

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    logger.debug('Starting Jito transaction execution...');

    // Simulate the main transaction first if enabled
    if (this.simulateEnabled) {
      const simulationResult = await this.simulate(transaction);
      if (!simulationResult.success) {
        logger.debug({ error: simulationResult.error }, 'Transaction simulation failed');
        return { confirmed: false, error: `Simulation failed: ${simulationResult.error}` };
      }
      logger.debug('Transaction simulation passed');
    }

    this.JitoFeeWallet = this.getRandomValidatorKey(); // Update wallet key each execution
    logger.trace(`Selected Jito fee wallet: ${this.JitoFeeWallet.toBase58()}`);

    try {
      const fee = new CurrencyAmount(Currency.SOL, this.jitoFee, false).raw.toNumber();
      logger.trace(`Calculated fee: ${fee} lamports`);

      const jitTipTxFeeMessage = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: this.JitoFeeWallet,
            lamports: fee,
          }),
        ],
      }).compileToV0Message();

      const jitoFeeTx = new VersionedTransaction(jitTipTxFeeMessage);
      jitoFeeTx.sign([payer]);

      const jitoTxsignature = bs58.encode(jitoFeeTx.signatures[0]);

      // Serialize the transactions once here
      const serializedjitoFeeTx = bs58.encode(jitoFeeTx.serialize());
      const serializedTransaction = bs58.encode(transaction.serialize());
      const serializedTransactions = [serializedjitoFeeTx, serializedTransaction];

      // https://jito-labs.gitbook.io/mev/searcher-resources/json-rpc-api-reference/url
      const endpoints = [
        'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
        'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
      ];

      const requests = endpoints.map((url) =>
        axios.post(url, {
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [serializedTransactions],
        }),
      );

      logger.trace('Sending bundle to Jito endpoints...');
      const results = await Promise.all(requests.map((p) => p.catch((e) => e)));

      const successfulResults = results.filter((result) => !(result instanceof Error));

      if (successfulResults.length > 0) {
        // Extract bundle ID from the first successful response
        const bundleId = successfulResults[0]?.data?.result;
        logger.trace({ bundleId }, 'Bundle submitted successfully');

        if (bundleId) {
          // Poll for bundle status instead of just confirming the tip tx
          logger.debug('Polling for bundle status...');
          const bundleStatus = await this.pollBundleStatus(bundleId, endpoints[0]);

          if (bundleStatus.landed) {
            logger.debug({ bundleId }, 'Bundle landed successfully');
            // Also confirm the transaction on-chain for the signature
            return await this.confirm(jitoTxsignature, latestBlockhash);
          } else {
            logger.debug({ bundleId, status: bundleStatus.status }, 'Bundle did not land');
            return {
              confirmed: false,
              error: `Bundle status: ${bundleStatus.status || 'unknown'}`,
            };
          }
        } else {
          // Fallback to old confirmation method if no bundle ID returned
          logger.debug('No bundle ID in response, using legacy confirmation');
          return await this.confirm(jitoTxsignature, latestBlockhash);
        }
      } else {
        logger.debug('No successful responses received from Jito endpoints');
      }

      return { confirmed: false, error: 'All Jito endpoints failed' };
    } catch (error) {
      if (error instanceof AxiosError) {
        logger.trace({ error: error.response?.data }, 'Failed to execute jito transaction');
      }
      logger.error('Error during transaction execution', error);
      return { confirmed: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async confirm(signature: string, latestBlockhash: BlockhashWithExpiryBlockHeight) {
    const confirmation = await this.connection.confirmTransaction(
      {
        signature,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        blockhash: latestBlockhash.blockhash,
      },
      this.connection.commitment,
    );

    return { confirmed: !confirmation.value.err, signature };
  }

  private async simulate(
    transaction: VersionedTransaction,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const simulation = await this.connection.simulateTransaction(transaction, {
        commitment: this.connection.commitment,
      });

      if (simulation.value.err) {
        const errorMsg =
          typeof simulation.value.err === 'string'
            ? simulation.value.err
            : JSON.stringify(simulation.value.err);
        return { success: false, error: errorMsg };
      }

      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Poll Jito's getBundleStatuses API to check if bundle has landed
   */
  private async pollBundleStatus(
    bundleId: string,
    endpoint: string,
  ): Promise<{ landed: boolean; status?: string }> {
    const startTime = Date.now();
    const maxAttempts = Math.ceil(this.bundleTimeout / this.bundlePollInterval);
    let consecutiveRateLimits = 0;
    const maxConsecutiveRateLimits = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await axios.post(endpoint, {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        });

        // Reset rate limit counter on successful request
        consecutiveRateLimits = 0;

        const result = response.data?.result?.value?.[0];

        if (result) {
          const status = result.confirmation_status;
          logger.trace({ bundleId, status, attempt }, 'Bundle status check');

          // Check if bundle has landed (confirmed or finalized)
          if (status === 'confirmed' || status === 'finalized') {
            return { landed: true, status };
          }

          // Check for failed/rejected status
          if (status === 'failed' || result.err) {
            return { landed: false, status: status || 'failed' };
          }
        }

        // Check timeout
        if (Date.now() - startTime >= this.bundleTimeout) {
          logger.debug({ bundleId }, 'Bundle status polling timed out');
          return { landed: false, status: 'timeout' };
        }

        // Wait before next poll
        await new Promise((resolve) => setTimeout(resolve, this.bundlePollInterval));
      } catch (error) {
        // Handle rate limiting (429) specially
        if (error instanceof AxiosError && error.response?.status === 429) {
          consecutiveRateLimits++;
          logger.trace({ bundleId, attempt, consecutiveRateLimits }, 'Rate limited by Jito API');

          // If we've hit too many rate limits, assume the bundle was submitted
          // and return early to let the fallback handle confirmation
          if (consecutiveRateLimits >= maxConsecutiveRateLimits) {
            logger.debug(
              { bundleId },
              'Too many rate limits from Jito API - bundle likely submitted, returning to allow fallback confirmation'
            );
            return { landed: false, status: 'rate_limited' };
          }

          // Exponential backoff on rate limits: 500ms, 1000ms, 2000ms
          const backoffMs = Math.min(500 * Math.pow(2, consecutiveRateLimits - 1), 5000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        logger.trace({ bundleId, error }, 'Error polling bundle status');
        // Continue polling on other transient errors
      }
    }

    return { landed: false, status: 'timeout' };
  }
}
