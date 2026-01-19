import {
  BlockhashWithExpiryBlockHeight,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TransactionExecutor } from './transaction-executor.interface';
import { logger, SIMULATE_TRANSACTION } from '../helpers';
import axios, { AxiosError } from 'axios';
import bs58 from 'bs58';
import { Currency, CurrencyAmount } from '@raydium-io/raydium-sdk';

export class WarpTransactionExecutor implements TransactionExecutor {
  private readonly warpFeeWallet = new PublicKey('WARPzUMPnycu9eeCZ95rcAUxorqpBqHndfV3ZP5FSyS');

  constructor(
    private readonly warpFee: string,
    private readonly connection?: Connection,
    private readonly simulateEnabled: boolean = SIMULATE_TRANSACTION,
  ) {}

  public async executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockhash: BlockhashWithExpiryBlockHeight,
  ): Promise<{ confirmed: boolean; signature?: string; error?: string }> {
    // Simulate transaction first if enabled and connection is available
    if (this.simulateEnabled && this.connection) {
      const simulationResult = await this.simulate(transaction);
      if (!simulationResult.success) {
        logger.debug({ error: simulationResult.error }, 'Transaction simulation failed');
        return { confirmed: false, error: `Simulation failed: ${simulationResult.error}` };
      }
      logger.debug('Transaction simulation passed');
    }

    logger.debug('Executing transaction...');

    try {
      const fee = new CurrencyAmount(Currency.SOL, this.warpFee, false).raw.toNumber();
      const warpFeeMessage = new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions: [
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: this.warpFeeWallet,
            lamports: fee,
          }),
        ],
      }).compileToV0Message();

      const warpFeeTx = new VersionedTransaction(warpFeeMessage);
      warpFeeTx.sign([payer]);

      const response = await axios.post<{ confirmed: boolean; signature: string; error?: string }>(
        'https://tx.warp.id/transaction/execute',
        {
          transactions: [bs58.encode(warpFeeTx.serialize()), bs58.encode(transaction.serialize())],
          latestBlockhash,
        },
        {
          timeout: 100000,
        },
      );

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        logger.trace({ error: error.response?.data }, 'Failed to execute warp transaction');
      }
    }

    return { confirmed: false };
  }

  private async simulate(
    transaction: VersionedTransaction,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.connection) {
      return { success: true }; // Skip simulation if no connection
    }

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
}
