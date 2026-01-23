import { BlockhashWithExpiryBlockHeight, Keypair, VersionedTransaction } from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger } from '../helpers';
import bs58 from 'bs58';

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
    // Get the transaction signature for potential confirmation later
    const txSignature = bs58.encode(transaction.signatures[0]);

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

    // Check if the fallback failed because the transaction was already processed
    // This typically means the primary executor actually submitted successfully
    // but failed to confirm (e.g., due to rate limiting during status polling)
    if (fallbackResult.error?.includes('AlreadyProcessed') ||
        fallbackResult.error?.includes('already been processed')) {
      logger.info(
        { signature: txSignature },
        'Transaction was already processed - likely submitted by primary executor. Treating as success.'
      );
      return {
        confirmed: true,
        signature: primaryResult.signature || txSignature,
        error: undefined,
      };
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
