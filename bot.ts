import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { logger, COMMITMENT_LEVEL } from './helpers';
import { TransactionExecutor } from './transactions';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { FallbackTransactionExecutor } from './transactions';

export interface BotConfig {
  wallet: Keypair;
  quoteAmount: number;
  oneTokenAtATime: boolean;
  autoBuyDelay: number;
  maxBuyRetries: number;
  autoSell: boolean;
  autoSellDelay: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  maxOpenPositions: number;
  maxHoldDurationMs: number;
}

export class Bot {
  private readonly connection: Connection;
  private readonly txExecutor: TransactionExecutor;

  // Expose executor type flags for config display
  public readonly isWarp: boolean;
  public readonly isJito: boolean;
  public readonly config: BotConfig;

  constructor(
    connection: Connection,
    txExecutor: TransactionExecutor,
    config: BotConfig,
  ) {
    this.connection = connection;
    this.txExecutor = txExecutor;
    this.config = config;

    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito =
      txExecutor instanceof JitoTransactionExecutor ||
      (txExecutor instanceof FallbackTransactionExecutor &&
        (txExecutor as FallbackTransactionExecutor).primaryName === 'jito');
  }

  async validate(): Promise<boolean> {
    try {
      const balance = await this.connection.getBalance(
        this.config.wallet.publicKey,
        COMMITMENT_LEVEL,
      );
      const solBalance = balance / LAMPORTS_PER_SOL;

      logger.info(
        {
          wallet: this.config.wallet.publicKey.toString(),
          balance: `${solBalance.toFixed(4)} SOL`,
        },
        'Wallet validated',
      );

      if (solBalance < this.config.quoteAmount) {
        logger.error(
          {
            balance: solBalance,
            required: this.config.quoteAmount,
          },
          'Insufficient balance for trading. Top up your wallet.',
        );
        return false;
      }

      return true;
    } catch (error) {
      logger.error({ error }, 'Failed to validate wallet');
      return false;
    }
  }
}
