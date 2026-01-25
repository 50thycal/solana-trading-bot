import { Connection, PublicKey, Logs } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { getMintCache } from '../cache/mint.cache';
import { logger } from '../helpers/logger';

/**
 * Token Program IDs for mint detection
 */
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/**
 * Events emitted by MintListener
 */
export interface MintListenerEvents {
  'mint-detected': (mint: PublicKey, signature: string, source: string) => void;
  'error': (error: Error) => void;
  'started': () => void;
  'stopped': () => void;
}

/**
 * Statistics for mint detection
 */
interface MintListenerStats {
  logsReceived: number;
  mintsDetected: number;
  errors: number;
  lastDetectedAt: number | null;
}

/**
 * MintListener - Detects newly minted tokens via Helius WebSocket
 *
 * This listener monitors the Token Program for InitializeMint instructions,
 * which indicate a new token is being created. When detected, the mint
 * is added to the mint cache for later verification during pool detection.
 *
 * Uses Helius Geyser-enhanced WebSocket subscriptions for reliable
 * real-time detection of new token mints.
 *
 * @example
 * ```typescript
 * const mintListener = new MintListener(connection);
 * await mintListener.start();
 *
 * mintListener.on('mint-detected', (mint, signature, source) => {
 *   console.log(`New token minted: ${mint.toString()}`);
 * });
 * ```
 */
export class MintListener extends EventEmitter {
  private connection: Connection;
  private subscriptionIds: number[] = [];
  private isRunning: boolean = false;
  private stats: MintListenerStats = {
    logsReceived: 0,
    mintsDetected: 0,
    errors: 0,
    lastDetectedAt: null,
  };

  // Track recently processed signatures to avoid duplicates
  private processedSignatures: Set<string> = new Set();
  private maxProcessedSignatures: number = 10000;

  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }

  /**
   * Start listening for mint events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('MintListener already running');
      return;
    }

    logger.info('Starting Helius mint detection listener');

    try {
      // Subscribe to Token Program logs
      const tokenSubId = this.connection.onLogs(
        TOKEN_PROGRAM_ID,
        (logs) => this.handleLogs(logs, 'token-program'),
        'confirmed'
      );
      this.subscriptionIds.push(tokenSubId);
      logger.debug({ subscriptionId: tokenSubId }, 'Subscribed to Token Program logs');

      // Subscribe to Token 2022 Program logs
      const token2022SubId = this.connection.onLogs(
        TOKEN_2022_PROGRAM_ID,
        (logs) => this.handleLogs(logs, 'token-2022'),
        'confirmed'
      );
      this.subscriptionIds.push(token2022SubId);
      logger.debug({ subscriptionId: token2022SubId }, 'Subscribed to Token 2022 Program logs');

      this.isRunning = true;
      this.emit('started');
      logger.info(
        { subscriptions: this.subscriptionIds.length },
        'Mint detection subscriptions active'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to start mint listener');
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Handle incoming logs from Token Program
   */
  private handleLogs(logs: Logs, source: string): void {
    this.stats.logsReceived++;

    // Skip if transaction errored
    if (logs.err) {
      return;
    }

    const signature = logs.signature;

    // Skip if we've already processed this signature
    if (this.processedSignatures.has(signature)) {
      return;
    }

    // Check for InitializeMint instructions in the logs
    const logMessages = logs.logs || [];
    let hasInitializeMint = false;

    for (const log of logMessages) {
      if (
        log.includes('Instruction: InitializeMint') ||
        log.includes('Instruction: InitializeMint2')
      ) {
        hasInitializeMint = true;
        break;
      }
    }

    if (!hasInitializeMint) {
      return;
    }

    // Add to processed signatures
    this.addProcessedSignature(signature);

    // Process the mint transaction asynchronously
    this.processMintTransaction(signature, source).catch((error) => {
      logger.error({ signature, error }, 'Error processing mint transaction');
      this.stats.errors++;
    });
  }

  /**
   * Process a transaction that contains an InitializeMint instruction
   */
  private async processMintTransaction(signature: string, source: string): Promise<void> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta || tx.meta.err) {
        return;
      }

      // Find the mint account from the parsed instructions
      const instructions = tx.transaction.message.instructions;

      for (const ix of instructions) {
        // Check for parsed instructions (only Token Program instructions are parsed)
        if ('parsed' in ix && ix.parsed) {
          const parsed = ix.parsed as { type?: string; info?: { mint?: string } };

          if (
            (parsed.type === 'initializeMint' || parsed.type === 'initializeMint2') &&
            parsed.info?.mint
          ) {
            const mintAddress = new PublicKey(parsed.info.mint);

            // Add to mint cache
            const mintCache = getMintCache();
            mintCache.add(mintAddress, 'helius', signature);

            // Update stats
            this.stats.mintsDetected++;
            this.stats.lastDetectedAt = Date.now();

            // Emit event
            this.emit('mint-detected', mintAddress, signature, source);

            logger.info(
              {
                mint: mintAddress.toString(),
                signature,
                source,
              },
              'New token mint detected via Helius'
            );
          }
        }
      }
    } catch (error) {
      // Log at debug level - transaction fetch failures are common and not critical
      logger.debug({ signature, error }, 'Failed to fetch mint transaction details');
      this.stats.errors++;
    }
  }

  /**
   * Add a signature to the processed set with size limit
   */
  private addProcessedSignature(signature: string): void {
    this.processedSignatures.add(signature);

    // Limit size to prevent memory issues
    if (this.processedSignatures.size > this.maxProcessedSignatures) {
      // Remove oldest entries (first 20%)
      const toRemove = Math.floor(this.maxProcessedSignatures * 0.2);
      const iterator = this.processedSignatures.values();
      for (let i = 0; i < toRemove; i++) {
        const value = iterator.next().value;
        if (value) {
          this.processedSignatures.delete(value);
        }
      }
    }
  }

  /**
   * Stop listening for mint events
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping mint detection listener');

    for (const subId of this.subscriptionIds) {
      try {
        await this.connection.removeOnLogsListener(subId);
      } catch (error) {
        logger.debug({ subscriptionId: subId, error }, 'Error removing logs listener');
      }
    }

    this.subscriptionIds = [];
    this.isRunning = false;
    this.processedSignatures.clear();

    this.emit('stopped');
    logger.info('Mint detection listener stopped');
  }

  /**
   * Check if the listener is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get listener statistics
   */
  getStats(): MintListenerStats & { cacheStats: ReturnType<typeof getMintCache>['getStats'] } {
    return {
      ...this.stats,
      cacheStats: getMintCache().getStats(),
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      logsReceived: 0,
      mintsDetected: 0,
      errors: 0,
      lastDetectedAt: null,
    };
  }

  /**
   * Update the connection (for RPC failover)
   */
  async updateConnection(connection: Connection): Promise<void> {
    const wasRunning = this.isRunning;

    if (wasRunning) {
      await this.stop();
    }

    this.connection = connection;

    if (wasRunning) {
      await this.start();
    }
  }
}

// Singleton instance
let mintListenerInstance: MintListener | null = null;

/**
 * Get the global mint listener instance
 */
export function getMintListener(): MintListener | null {
  return mintListenerInstance;
}

/**
 * Initialize the mint listener
 */
export function initMintListener(connection: Connection): MintListener {
  if (mintListenerInstance) {
    logger.warn('MintListener already initialized, returning existing instance');
    return mintListenerInstance;
  }
  mintListenerInstance = new MintListener(connection);
  return mintListenerInstance;
}
