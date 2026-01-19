import { BlockhashWithExpiryBlockHeight, Keypair, VersionedTransaction } from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers';

/**
 * Fallback transaction executor that tries a primary executor first,
 * then falls back to a secondary executor if the primary fails.
 *
 * Recommended configuration: Jito (primary) -> Default RPC (fallback)
 */
export class FallbackTransactionExecutor implements TransactionExecutor {
  constructor(
    private readonly primary: TransactionExecutor,
    private readonly fallback: TransactionExecutor,
    private readonly primaryName: string = 'primary',
    private readonly fallbackName: string = 'fallback',
  ) {}

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    // Try primary executor first
    logger.debug(`Attempting transaction with ${this.primaryName} executor`);
    const primaryResult = await this.primary.executeAndConfirm(transaction, payer, latestBlockhash);

    if (primaryResult.confirmed) {
      logger.debug(`Transaction confirmed via ${this.primaryName} executor`);
      return primaryResult;
    }

    // Primary failed, try fallback
    logger.debug(
      { error: primaryResult.error },
      `${this.primaryName} executor failed, falling back to ${this.fallbackName}`
    );

    // For fallback, we may need a fresh blockhash if significant time has passed
    // However, the latestBlockhash should still be valid (typically 60-90 seconds)
    // The caller can refresh if needed before retrying
    const fallbackResult = await this.fallback.executeAndConfirm(
      transaction,
      payer,
      latestBlockhash,
    );

    if (fallbackResult.confirmed) {
      logger.debug(`Transaction confirmed via ${this.fallbackName} executor`);
      return fallbackResult;
    }

    // Both failed
    logger.debug(
      { primaryError: primaryResult.error, fallbackError: fallbackResult.error },
      'Both primary and fallback executors failed'
    );

    return {
      confirmed: false,
      error: `Primary (${this.primaryName}): ${primaryResult.error || 'failed'}; Fallback (${this.fallbackName}): ${fallbackResult.error || 'failed'}`,
    };
  }
}
