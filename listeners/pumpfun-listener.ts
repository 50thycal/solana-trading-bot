import { Connection, PublicKey, Logs, ParsedTransactionWithMeta } from '@solana/web3.js';
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import { getMintCache } from '../cache/mint.cache';
import { logger } from '../helpers/logger';
import {
  DetectedToken,
  PumpFunState,
  PlatformStats,
  createEmptyPlatformStats,
} from '../types';

/**
 * pump.fun Program ID
 * This is the program that handles bonding curve creation and trading
 */
export const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/**
 * Global Account (stores fee configuration)
 */
export const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

/**
 * Fee Recipient
 */
export const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

/**
 * Event Authority
 */
export const PUMP_FUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

/**
 * WSOL mint address (quote token for pump.fun)
 */
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Data structure for a pump.fun token (internal parsing)
 */
export interface PumpFunToken {
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  signature: string;
  detectedAt: number;
}

/**
 * Events emitted by PumpFunListener
 */
export interface PumpFunListenerEvents {
  /** Unified event - new token detected and ready for buy */
  'new-token': (token: DetectedToken) => void;
  /** Token rejected during processing */
  'token-rejected': (token: Partial<DetectedToken>, reason: string) => void;
  /** Error occurred */
  'error': (error: Error) => void;
  /** Listener started */
  'started': () => void;
  /** Listener stopped */
  'stopped': () => void;
}

/**
 * Statistics for pump.fun detection
 */
interface PumpFunListenerStats {
  logsReceived: number;
  createInstructionsDetected: number;
  tokensProcessed: number;
  errors: number;
  lastDetectedAt: number | null;
}

/**
 * PumpFunListener - Detects new tokens launching on pump.fun bonding curves
 *
 * This listener monitors the pump.fun program for "Create" instructions,
 * which indicate a new token is being launched on the bonding curve.
 * When detected, the token is added to the mint cache and a unified
 * 'new-token' event is emitted with the DetectedToken interface.
 *
 * pump.fun tokens launch on a bonding curve mechanism:
 * - Price starts low and increases as people buy
 * - At ~$69k market cap, token "graduates" to Raydium
 * - Early detection allows for early entry on promising tokens
 *
 * @example
 * ```typescript
 * const listener = new PumpFunListener(connection);
 * await listener.start();
 *
 * listener.on('new-token', (token: DetectedToken) => {
 *   if (token.source === 'pumpfun') {
 *     console.log(`New pump.fun token: ${token.name} (${token.symbol})`);
 *     console.log(`Mint: ${token.mint.toString()}`);
 *     console.log(`Bonding Curve: ${token.bondingCurve?.toString()}`);
 *   }
 * });
 * ```
 */
export class PumpFunListener extends EventEmitter {
  private connection: Connection;
  private subscriptionId: number | null = null;
  private isRunning: boolean = false;
  private stats: PumpFunListenerStats = {
    logsReceived: 0,
    createInstructionsDetected: 0,
    tokensProcessed: 0,
    errors: 0,
    lastDetectedAt: null,
  };

  // Platform stats for unified reporting
  private platformStats: PlatformStats = createEmptyPlatformStats();

  // Track recently processed signatures to avoid duplicates
  private processedSignatures: Set<string> = new Set();
  private maxProcessedSignatures: number = 10000;

  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }

  /**
   * Start listening for pump.fun token creation events
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('PumpFunListener already running');
      return;
    }

    logger.info('Starting pump.fun token detection listener');

    try {
      // Subscribe to pump.fun program logs
      this.subscriptionId = this.connection.onLogs(
        PUMP_FUN_PROGRAM,
        (logs) => this.handleLogs(logs),
        'confirmed'
      );

      this.isRunning = true;
      this.emit('started');
      logger.info(
        { subscriptionId: this.subscriptionId, program: PUMP_FUN_PROGRAM.toString() },
        'pump.fun listener active'
      );
    } catch (error) {
      logger.error({ error }, 'Failed to start pump.fun listener');
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Handle incoming logs from pump.fun program
   */
  private handleLogs(logs: Logs): void {
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

    // Look for "Create" instruction in the logs
    // pump.fun logs "Instruction: Create" when a new token is created
    // Also match "CreateV2" for Token-2022 based pump.fun tokens
    // IMPORTANT: Must match EXACTLY - not "CreateTokenAccount" or "CreateIdempotent"
    const logMessages = logs.logs || [];
    let hasCreate = false;
    let createLogLine = '';

    for (const log of logMessages) {
      // Exact match for token creation - NOT CreateTokenAccount, CreateIdempotent, etc.
      // Match both Create (legacy) and CreateV2 (Token-2022)
      if (log === 'Program log: Instruction: Create' || log === 'Program log: Instruction: CreateV2') {
        hasCreate = true;
        createLogLine = log;
        break;
      }
    }

    if (!hasCreate) {
      return;
    }

    // DEBUG: Log all the log messages for Create transactions
    logger.info(
      {
        signature,
        createLogLine,
        allLogs: logMessages.filter(l =>
          l.includes('Program log:') || l.includes('Instruction:')
        ),
      },
      '[pump.fun DEBUG] Create instruction detected in logs'
    );

    this.stats.createInstructionsDetected++;
    this.platformStats.detected++;

    // Add to processed signatures
    this.addProcessedSignature(signature);

    // Process the create transaction asynchronously
    this.processCreateTransaction(signature).catch((error) => {
      logger.error({ signature, error }, 'Error processing pump.fun create transaction');
      this.stats.errors++;
      this.platformStats.errors++;
    });
  }

  /**
   * Process a transaction that contains a pump.fun Create instruction
   */
  private async processCreateTransaction(signature: string): Promise<void> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx?.meta || tx.meta.err) {
        return;
      }

      // Parse the create instruction to extract token details
      const token = this.parseCreateTransaction(tx, signature);

      if (token) {
        // Add to mint cache (high confidence - we detected the creation)
        const mintCache = getMintCache();
        mintCache.add(token.mint, 'helius', signature);

        // Update stats
        this.stats.tokensProcessed++;
        this.stats.lastDetectedAt = Date.now();
        this.platformStats.isNew++;

        // Try to fetch Token-2022 metadata if name/symbol not extracted from logs
        let tokenName = token.name;
        let tokenSymbol = token.symbol;
        let tokenUri = token.uri;

        if (!tokenName || !tokenSymbol) {
          const metadata = await this.fetchToken2022Metadata(token.mint);
          if (metadata.name) tokenName = metadata.name;
          if (metadata.symbol) tokenSymbol = metadata.symbol;
          if (metadata.uri && !tokenUri) tokenUri = metadata.uri;
        }

        // Build the unified DetectedToken
        const currentTime = Math.floor(Date.now() / 1000);

        const pumpFunState: PumpFunState = {
          bondingCurve: token.bondingCurve,
          associatedBondingCurve: token.associatedBondingCurve,
          complete: false, // Just created, not graduated yet
        };

        const detectedToken: DetectedToken = {
          source: 'pumpfun',
          mint: token.mint,
          bondingCurve: token.bondingCurve,
          associatedBondingCurve: token.associatedBondingCurve,
          quoteMint: WSOL_MINT,
          name: tokenName || undefined,
          symbol: tokenSymbol || undefined,
          uri: tokenUri || undefined,
          creator: token.creator,
          detectedAt: currentTime,
          inMintCache: true, // We just added it
          verificationSource: 'mint-cache',
          verified: true,
          signature: token.signature,
          poolState: {
            type: 'pumpfun',
            state: pumpFunState,
          },
        };

        // Update stats and emit unified event
        this.platformStats.buyAttempted++;
        this.emit('new-token', detectedToken);

        logger.info(
          {
            mint: token.mint.toString(),
            name: tokenName,
            symbol: tokenSymbol,
            bondingCurve: token.bondingCurve.toString(),
            creator: token.creator.toString(),
            signature,
          },
          'New pump.fun token detected'
        );
      }
    } catch (error) {
      // Log at debug level - transaction fetch failures can happen
      logger.debug({ signature, error }, 'Failed to fetch pump.fun transaction details');
      this.stats.errors++;
      this.platformStats.errors++;
    }
  }

  /**
   * Parse a pump.fun create transaction to extract token details
   *
   * pump.fun Create instruction account layout:
   * 0: mint - The new token mint account
   * 1: mintAuthority - PDA that controls minting
   * 2: bondingCurve - The bonding curve account for this token
   * 3: associatedBondingCurve - ATA for bonding curve to hold tokens
   * 4: global - Global config account
   * 5: mplTokenMetadata - Metaplex Token Metadata program
   * 6: metadata - The metadata account for the token
   * 7: user - The creator/payer
   * 8: systemProgram
   * 9: tokenProgram
   * 10: associatedTokenProgram
   * 11: rent
   * 12: eventAuthority
   * 13: program (pump.fun)
   */
  private parseCreateTransaction(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): PumpFunToken | null {
    try {
      const instructions = tx.transaction.message.instructions;
      const accountKeys = tx.transaction.message.accountKeys;

      // DEBUG: Log all account keys in the transaction
      logger.debug(
        {
          signature,
          accountKeyCount: accountKeys.length,
          accountKeys: accountKeys.slice(0, 15).map((k, i) => `[${i}] ${k.pubkey.toString()}`),
        },
        '[pump.fun DEBUG] Transaction account keys'
      );

      // Find the pump.fun program instruction
      let ixIndex = 0;
      for (const ix of instructions) {
        // Check if this is a pump.fun instruction (unparsed)
        if (!('parsed' in ix) && 'programId' in ix) {
          const programId = ix.programId;

          if (programId.equals(PUMP_FUN_PROGRAM)) {
            // Get the accounts from this instruction
            const accounts = ix.accounts;

            // DEBUG: Log all accounts for this instruction
            logger.info(
              {
                signature,
                ixIndex,
                accountCount: accounts.length,
                accounts: accounts.map((a, i) => `[${i}] ${a.toString()}`),
              },
              '[pump.fun DEBUG] pump.fun instruction accounts'
            );

            if (accounts.length >= 8) {
              // Extract key accounts based on the layout
              const mint = accounts[0];
              const bondingCurve = accounts[2];
              const associatedBondingCurve = accounts[3];
              const creator = accounts[7];

              // DEBUG: Log extracted values
              logger.info(
                {
                  signature,
                  extractedMint: mint.toString(),
                  extractedBondingCurve: bondingCurve.toString(),
                  extractedAssociatedBondingCurve: associatedBondingCurve.toString(),
                  extractedCreator: creator.toString(),
                  isPumpFunGlobal: mint.equals(PUMP_FUN_GLOBAL),
                  isMintAProgram: mint.toString().length < 44, // Programs have shorter addresses
                },
                '[pump.fun DEBUG] Extracted accounts from assumed layout'
              );

              // VALIDATION: Skip if mint is actually PUMP_FUN_GLOBAL (wrong instruction)
              if (mint.equals(PUMP_FUN_GLOBAL)) {
                logger.warn(
                  { signature, mint: mint.toString() },
                  '[pump.fun] Skipping - mint is PUMP_FUN_GLOBAL (wrong instruction type)'
                );
                ixIndex++;
                continue;
              }

              // Try to extract metadata from inner instructions or logs
              const { name, symbol, uri } = this.extractMetadataFromLogs(tx);

              return {
                mint,
                bondingCurve,
                associatedBondingCurve,
                creator,
                name,
                symbol,
                uri,
                signature,
                detectedAt: Date.now(),
              };
            }
          }
        }
        ixIndex++;
      }

      // If we couldn't find it in outer instructions, check inner instructions
      logger.debug({ signature }, '[pump.fun DEBUG] Checking inner instructions');
      const innerInstructions = tx.meta?.innerInstructions || [];
      for (const innerIx of innerInstructions) {
        for (const ix of innerIx.instructions) {
          if (!('parsed' in ix) && 'programId' in ix) {
            const programId = ix.programId;

            if (programId.equals(PUMP_FUN_PROGRAM) && ix.accounts.length >= 8) {
              const accounts = ix.accounts;

              // DEBUG: Log inner instruction accounts
              logger.info(
                {
                  signature,
                  innerIxIndex: innerIx.index,
                  accountCount: accounts.length,
                  accounts: accounts.map((a, i) => `[${i}] ${a.toString()}`),
                },
                '[pump.fun DEBUG] Inner pump.fun instruction accounts'
              );

              const mint = accounts[0];
              const bondingCurve = accounts[2];
              const associatedBondingCurve = accounts[3];
              const creator = accounts[7];

              // Skip if mint is PUMP_FUN_GLOBAL
              if (mint.equals(PUMP_FUN_GLOBAL)) {
                logger.warn(
                  { signature },
                  '[pump.fun] Skipping inner instruction - mint is PUMP_FUN_GLOBAL'
                );
                continue;
              }

              const { name, symbol, uri } = this.extractMetadataFromLogs(tx);

              return {
                mint,
                bondingCurve,
                associatedBondingCurve,
                creator,
                name,
                symbol,
                uri,
                signature,
                detectedAt: Date.now(),
              };
            }
          }
        }
      }

      // Fallback: Try to extract from post token balances
      // The newly created mint should appear in postTokenBalances
      logger.debug({ signature }, '[pump.fun DEBUG] Using postTokenBalances fallback');
      const postBalances = tx.meta?.postTokenBalances || [];
      if (postBalances.length > 0) {
        // DEBUG: Log post token balances
        logger.info(
          {
            signature,
            postBalanceCount: postBalances.length,
            mints: postBalances.map((b, i) => `[${i}] ${b.mint}`),
          },
          '[pump.fun DEBUG] Post token balances'
        );

        // The first new token balance is likely our new mint
        for (const balance of postBalances) {
          if (balance.mint) {
            const mint = new PublicKey(balance.mint);

            // Skip known constants
            if (mint.equals(PUMP_FUN_GLOBAL) || mint.equals(WSOL_MINT)) {
              continue;
            }

            // Derive bonding curve PDA
            const [bondingCurve] = PublicKey.findProgramAddressSync(
              [Buffer.from('bonding-curve'), mint.toBuffer()],
              PUMP_FUN_PROGRAM
            );

            const { name, symbol, uri } = this.extractMetadataFromLogs(tx);

            // Get creator from fee payer
            const creator = accountKeys[0].pubkey;

            logger.info(
              {
                signature,
                mint: mint.toString(),
                bondingCurve: bondingCurve.toString(),
                creator: creator.toString(),
              },
              '[pump.fun DEBUG] Extracted from postTokenBalances fallback'
            );

            return {
              mint,
              bondingCurve,
              associatedBondingCurve: bondingCurve, // Will be derived properly in buy
              creator,
              name,
              symbol,
              uri,
              signature,
              detectedAt: Date.now(),
            };
          }
        }
      }

      logger.warn({ signature }, '[pump.fun DEBUG] Failed to extract token from transaction');
      return null;
    } catch (error) {
      logger.debug({ signature, error }, 'Failed to parse pump.fun create transaction');
      return null;
    }
  }

  /**
   * Extract token metadata (name, symbol, uri) from transaction logs
   *
   * pump.fun logs contain metadata in the CreateEvent
   */
  private extractMetadataFromLogs(tx: ParsedTransactionWithMeta): {
    name: string;
    symbol: string;
    uri: string;
  } {
    const logs = tx.meta?.logMessages || [];
    let name = '';
    let symbol = '';
    let uri = '';

    // pump.fun emits structured logs that may contain metadata
    // Look for patterns in logs
    for (const log of logs) {
      // Some pump.fun implementations log the name/symbol directly
      // Pattern: "Program log: name: <name>, symbol: <symbol>"
      if (log.includes('name:') && log.includes('symbol:')) {
        const nameMatch = log.match(/name:\s*([^,]+)/);
        const symbolMatch = log.match(/symbol:\s*([^,\s]+)/);
        if (nameMatch) name = nameMatch[1].trim();
        if (symbolMatch) symbol = symbolMatch[1].trim();
      }

      // Check for URI in logs
      if (log.includes('uri:') || log.includes('URI:')) {
        const uriMatch = log.match(/uri:\s*(\S+)/i);
        if (uriMatch) uri = uriMatch[1].trim();
      }
    }

    return { name, symbol, uri };
  }

  /**
   * Fetch Token-2022 metadata from the mint account
   *
   * pump.fun CreateV2 tokens use Token-2022 with embedded metadata.
   * This fetches the actual name/symbol from the on-chain metadata.
   */
  private async fetchToken2022Metadata(mint: PublicKey): Promise<{
    name: string;
    symbol: string;
    uri: string;
  }> {
    try {
      const metadata = await getTokenMetadata(
        this.connection,
        mint,
        'confirmed',
        TOKEN_2022_PROGRAM_ID
      );

      if (metadata) {
        logger.debug(
          {
            mint: mint.toString(),
            name: metadata.name,
            symbol: metadata.symbol,
            uri: metadata.uri,
          },
          '[pump.fun] Fetched Token-2022 metadata'
        );

        return {
          name: metadata.name || '',
          symbol: metadata.symbol || '',
          uri: metadata.uri || '',
        };
      }
    } catch (error) {
      // Token might not be Token-2022 or metadata not available
      logger.debug(
        { mint: mint.toString(), error: String(error) },
        '[pump.fun] Could not fetch Token-2022 metadata (may be SPL token)'
      );
    }

    return { name: '', symbol: '', uri: '' };
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
   * Stop listening for pump.fun events
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping pump.fun listener');

    if (this.subscriptionId !== null) {
      try {
        await this.connection.removeOnLogsListener(this.subscriptionId);
      } catch (error) {
        logger.debug({ subscriptionId: this.subscriptionId, error }, 'Error removing logs listener');
      }
      this.subscriptionId = null;
    }

    this.isRunning = false;
    this.processedSignatures.clear();

    this.emit('stopped');
    logger.info('pump.fun listener stopped');
  }

  /**
   * Check if the listener is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get listener statistics (internal stats)
   */
  getStats(): PumpFunListenerStats {
    return { ...this.stats };
  }

  /**
   * Get platform statistics (unified format)
   */
  getPlatformStats(): PlatformStats {
    return { ...this.platformStats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      logsReceived: 0,
      createInstructionsDetected: 0,
      tokensProcessed: 0,
      errors: 0,
      lastDetectedAt: null,
    };
    this.platformStats = createEmptyPlatformStats();
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
let pumpFunListenerInstance: PumpFunListener | null = null;

/**
 * Get the global pump.fun listener instance
 */
export function getPumpFunListener(): PumpFunListener | null {
  return pumpFunListenerInstance;
}

/**
 * Initialize the pump.fun listener
 */
export function initPumpFunListener(connection: Connection): PumpFunListener {
  if (pumpFunListenerInstance) {
    logger.warn('PumpFunListener already initialized, returning existing instance');
    return pumpFunListenerInstance;
  }
  pumpFunListenerInstance = new PumpFunListener(connection);
  return pumpFunListenerInstance;
}
