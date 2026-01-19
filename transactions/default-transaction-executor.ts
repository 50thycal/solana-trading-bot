import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  Keypair,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger, SIMULATE_TRANSACTION } from '../helpers';

export class DefaultTransactionExecutor implements TransactionExecutor {
  constructor(
    private readonly connection: Connection,
    private readonly simulateEnabled: boolean = SIMULATE_TRANSACTION,
  ) {}

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    // Simulate transaction first if enabled
    if (this.simulateEnabled) {
      const simulationResult = await this.simulate(transaction);
      if (!simulationResult.success) {
        logger.debug({ error: simulationResult.error }, 'Transaction simulation failed');
        return { confirmed: false, error: `Simulation failed: ${simulationResult.error}` };
      }
      logger.debug('Transaction simulation passed');
    }

    logger.debug('Executing transaction...');
    const signature = await this.execute(transaction);

    logger.debug({ signature }, 'Confirming transaction...');
    return this.confirm(signature, latestBlockhash);
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

  private async execute(transaction: Transaction | VersionedTransaction) {
    return this.connection.sendRawTransaction(transaction.serialize(), {
      preflightCommitment: this.connection.commitment,
    });
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
}
