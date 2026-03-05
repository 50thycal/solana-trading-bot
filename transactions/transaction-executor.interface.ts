import { BlockhashWithExpiryBlockHeight, Keypair, VersionedTransaction } from '@solana/web3.js';

export interface TransactionExecutorResult {
  confirmed: boolean;
  signature?: string;
  error?: string;
  /** Which executor actually handled the transaction (e.g. 'jito', 'default') */
  executorUsed?: string;
}

export interface TransactionExecutor {
  executeAndConfirm(
    transaction: VersionedTransaction,
    payer: Keypair,
    latestBlockHash: BlockhashWithExpiryBlockHeight,
  ): Promise<TransactionExecutorResult>;
}
