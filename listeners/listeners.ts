import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import { Connection, KeyedAccountInfo, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import {
  logger,
  CPMM_PROGRAM_ID,
  CpmmPoolInfoLayout,
  DLMM_PROGRAM_ID,
  decodeDlmmPoolState,
  isDlmmPoolEnabled,
  isLbPairAccount,
  DLMM_MIN_ACCOUNT_SIZE,
} from '../helpers';
import { getMintCache } from '../cache/mint.cache';
import { verifyTokenAge } from '../services/dexscreener';
import {
  DetectedToken,
  TokenSource,
  VerificationSource,
  PlatformStats,
  createEmptyPlatformStats,
} from '../types';

/**
 * Reconnection configuration
 */
interface ReconnectionConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
}

const DEFAULT_RECONNECTION_CONFIG: ReconnectionConfig = {
  maxAttempts: 10,
  baseDelay: 1000,   // 1 second
  maxDelay: 60000,   // 60 seconds max
};

/**
 * Token verification configuration
 */
export interface VerificationConfig {
  /** Maximum token age in seconds to be considered "new" */
  maxTokenAgeSeconds: number;
  /** Whether to use DexScreener API as fallback for cache misses */
  dexscreenerFallbackEnabled: boolean;
  /** Bot startup timestamp - pools must be created after this */
  runTimestamp: number;
}

/**
 * Listener configuration
 */
export interface ListenerConfig {
  walletPublicKey: PublicKey;
  quoteToken: Token;
  autoSell: boolean;
  cacheNewMarkets: boolean;
  enableCpmm: boolean;
  enableDlmm: boolean;
  /** Token verification settings (optional - defaults applied if not provided) */
  verification?: VerificationConfig;
}

/**
 * Default verification config
 */
const DEFAULT_VERIFICATION_CONFIG: VerificationConfig = {
  maxTokenAgeSeconds: 300, // 5 minutes
  dexscreenerFallbackEnabled: true,
  runTimestamp: Math.floor(Date.now() / 1000),
};

/**
 * Listener statistics
 */
export interface ListenerStats {
  ammv4: PlatformStats;
  cpmm: PlatformStats;
  dlmm: PlatformStats;
}

/**
 * Listeners class - Manages WebSocket subscriptions with automatic reconnection
 *
 * Events emitted:
 * - 'new-token': Unified event for all verified new tokens (DetectedToken)
 * - 'token-rejected': Token failed verification (mint, reason)
 * - 'market': New OpenBook market detected (raw KeyedAccountInfo)
 * - 'wallet': Wallet account changed (raw KeyedAccountInfo)
 * - 'connected': WebSocket connected/reconnected
 * - 'disconnected': WebSocket disconnected
 * - 'reconnecting': Attempting reconnection
 * - 'error': Error occurred
 */
/** Internal config with required verification */
type InternalListenerConfig = ListenerConfig & { verification: VerificationConfig };

export class Listeners extends EventEmitter {
  private subscriptions: number[] = [];
  private config: InternalListenerConfig | null = null;
  private reconnectionConfig: ReconnectionConfig;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting: boolean = false;
  private isStopped: boolean = false;

  // Statistics per platform
  private stats: ListenerStats = {
    ammv4: createEmptyPlatformStats(),
    cpmm: createEmptyPlatformStats(),
    dlmm: createEmptyPlatformStats(),
  };

  // Deduplication: track pools we've already processed to avoid repeat events
  // onProgramAccountChange fires on ANY update to an account, not just creation
  private processedPools: Set<string> = new Set();

  constructor(
    private connection: Connection,
    reconnectionConfig?: Partial<ReconnectionConfig>
  ) {
    super();
    this.reconnectionConfig = { ...DEFAULT_RECONNECTION_CONFIG, ...reconnectionConfig };
  }

  /**
   * Update the connection (used for RPC failover)
   */
  public updateConnection(connection: Connection): void {
    this.connection = connection;
  }

  /**
   * Start all subscriptions
   */
  public async start(config: ListenerConfig): Promise<void> {
    // Apply default verification config if not provided
    this.config = {
      ...config,
      verification: config.verification ?? {
        ...DEFAULT_VERIFICATION_CONFIG,
        runTimestamp: Math.floor(Date.now() / 1000), // Fresh timestamp on start
      },
    };
    this.isStopped = false;
    await this.setupSubscriptions();
  }

  /**
   * Get current statistics
   */
  public getStats(): ListenerStats {
    return {
      ammv4: { ...this.stats.ammv4 },
      cpmm: { ...this.stats.cpmm },
      dlmm: { ...this.stats.dlmm },
    };
  }

  /**
   * Reset statistics
   */
  public resetStats(): void {
    this.stats = {
      ammv4: createEmptyPlatformStats(),
      cpmm: createEmptyPlatformStats(),
      dlmm: createEmptyPlatformStats(),
    };
  }

  /**
   * Verify a token and emit 'new-token' event if it passes
   */
  private async verifyAndEmitToken(
    source: TokenSource,
    baseMint: PublicKey,
    poolId: PublicKey,
    quoteMint: PublicKey,
    poolOpenTime: number,
    poolState: any,
    stats: PlatformStats
  ): Promise<void> {
    if (!this.config) return;

    const { verification, quoteToken } = this.config;
    const baseMintStr = baseMint.toString();
    const mintCache = getMintCache();
    const currentTime = Math.floor(Date.now() / 1000);

    // Check if pool is new (created after bot startup)
    // poolOpenTime === 0 means immediately active (no scheduled opening), so allow those through
    if (poolOpenTime !== 0 && poolOpenTime <= verification.runTimestamp) {
      stats.isNew--; // Wasn't actually new
      return;
    }

    // Brief delay to allow Helius mint detection to catch up
    // Pool detection can be faster than mint detection, causing race conditions
    const MINT_CACHE_DELAY_MS = 150;
    await new Promise(resolve => setTimeout(resolve, MINT_CACHE_DELAY_MS));

    // Determine verification source and status
    let verificationSource: VerificationSource = 'none';
    let verified = false;
    let ageSeconds: number | undefined;
    let rejectionReason: string | undefined;

    // Check if we detected this token via Helius mint listener (cache hit = definitely new)
    if (mintCache.has(baseMint)) {
      verificationSource = 'mint-cache';
      verified = true;
      // Note: isNew already incremented by subscription handler

      logger.info(
        { mint: baseMintStr, source, verificationSource },
        `[${source}] Token in mint cache - verified`
      );
    } else if (verification.dexscreenerFallbackEnabled) {
      // Cache miss - verify via DexScreener API
      logger.debug(
        { mint: baseMintStr, source },
        `[${source}] Token not in mint cache - verifying via DexScreener`
      );

      const result = await verifyTokenAge(baseMintStr, verification.maxTokenAgeSeconds);

      if (result.isVerified) {
        verificationSource = 'dexscreener';
        verified = true;
        ageSeconds = result.ageSeconds ?? undefined;
        // Note: isNew already incremented by subscription handler

        logger.info(
          { mint: baseMintStr, source, verificationSource, ageSeconds },
          `[${source}] DexScreener verified token is new`
        );
      } else if (result.source === 'not_indexed') {
        // Token not indexed on DexScreener - could be very new, proceed with caution
        verificationSource = 'not-indexed';
        verified = true;
        // Note: isNew already incremented by subscription handler

        logger.info(
          { mint: baseMintStr, source, verificationSource },
          `[${source}] Token not indexed on DexScreener (may be very new) - proceeding`
        );
      } else {
        // Token is too old or verification failed
        verificationSource = 'dexscreener';
        verified = false;
        ageSeconds = result.ageSeconds ?? undefined;
        rejectionReason = result.reason;
        stats.tokenTooOld++;

        logger.info(
          { mint: baseMintStr, source, reason: result.reason, ageSeconds },
          `[${source}] REJECTED: Token failed DexScreener verification`
        );

        // Emit rejection event for stats/debugging
        this.emit('token-rejected', { mint: baseMint, source }, rejectionReason);
        return;
      }
    } else {
      // No verification available - proceed without checks
      verificationSource = 'none';
      verified = true;
      // Note: isNew already incremented by subscription handler

      logger.debug(
        { mint: baseMintStr, source },
        `[${source}] No verification enabled - proceeding without checks`
      );
    }

    // Build the DetectedToken object
    const poolStateTyped = this.buildPoolState(source, poolState);

    const detectedToken: DetectedToken = {
      source,
      mint: baseMint,
      poolId,
      quoteMint,
      detectedAt: currentTime,
      poolOpenTime,
      ageSeconds,
      inMintCache: mintCache.has(baseMint),
      verificationSource,
      verified,
      rejectionReason,
      poolState: poolStateTyped,
    };

    // Update stats and emit
    stats.buyAttempted++;
    this.emit('new-token', detectedToken);
  }

  /**
   * Build typed pool state for DetectedToken
   */
  private buildPoolState(source: TokenSource, rawState: any) {
    switch (source) {
      case 'raydium-ammv4':
        return { type: 'ammv4' as const, state: rawState };
      case 'raydium-cpmm':
        return { type: 'cpmm' as const, state: rawState };
      case 'meteora-dlmm':
        return { type: 'dlmm' as const, state: rawState };
      default:
        throw new Error(`Unknown source: ${source}`);
    }
  }

  /**
   * Set up all WebSocket subscriptions
   */
  private async setupSubscriptions(): Promise<void> {
    if (!this.config || this.isStopped) return;

    try {
      // Clear any existing subscriptions
      await this.clearSubscriptions();

      if (this.config.cacheNewMarkets) {
        const openBookSubscription = await this.subscribeToOpenBookMarkets(this.config);
        this.subscriptions.push(openBookSubscription);
      }

      const raydiumSubscription = await this.subscribeToRaydiumPools(this.config);
      this.subscriptions.push(raydiumSubscription);

      if (this.config.enableCpmm) {
        const cpmmSubscription = await this.subscribeToCpmmPools(this.config);
        this.subscriptions.push(cpmmSubscription);
        logger.info('CPMM pool subscription enabled');
      }

      if (this.config.enableDlmm) {
        const dlmmSubscription = await this.subscribeToDlmmPools(this.config);
        this.subscriptions.push(dlmmSubscription);
        logger.info('Meteora DLMM pool subscription enabled');
      }

      if (this.config.autoSell) {
        const walletSubscription = await this.subscribeToWalletChanges(this.config);
        this.subscriptions.push(walletSubscription);
      }

      // Mark as connected
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.emit('connected');
      logger.info({ subscriptionCount: this.subscriptions.length }, 'WebSocket subscriptions established');

    } catch (error) {
      logger.error({ error }, 'Failed to setup WebSocket subscriptions');
      this.handleDisconnection();
    }
  }

  /**
   * Handle WebSocket disconnection
   */
  private handleDisconnection(): void {
    if (this.isStopped) return;

    this.isConnected = false;
    this.emit('disconnected');
    logger.warn('WebSocket disconnected');

    // Start reconnection process
    this.scheduleReconnection();
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnection(): void {
    if (this.isStopped || this.isReconnecting) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > this.reconnectionConfig.maxAttempts) {
      logger.error(
        { attempts: this.reconnectAttempts },
        'Max reconnection attempts reached. Exiting...'
      );
      this.emit('error', new Error('Max reconnection attempts reached'));
      // Exit process - Railway will restart the container
      process.exit(1);
    }

    // Calculate delay with exponential backoff
    const delay = Math.min(
      this.reconnectionConfig.baseDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.reconnectionConfig.maxDelay
    );

    logger.info(
      { attempt: this.reconnectAttempts, maxAttempts: this.reconnectionConfig.maxAttempts, delayMs: delay },
      'Scheduling reconnection attempt'
    );

    this.isReconnecting = true;
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    this.reconnectTimer = setTimeout(async () => {
      await this.attemptReconnection();
    }, delay);
  }

  /**
   * Attempt to reconnect
   */
  private async attemptReconnection(): Promise<void> {
    if (this.isStopped) return;

    logger.info({ attempt: this.reconnectAttempts }, 'Attempting WebSocket reconnection');

    try {
      await this.setupSubscriptions();
    } catch (error) {
      logger.error({ error, attempt: this.reconnectAttempts }, 'Reconnection attempt failed');
      this.isReconnecting = false;
      this.scheduleReconnection();
    }
  }

  /**
   * Subscribe to OpenBook markets
   */
  private async subscribeToOpenBookMarkets(config: { quoteToken: Token }): Promise<number> {
    return this.connection.onProgramAccountChange(
      MAINNET_PROGRAM_ID.OPENBOOK_MARKET,
      async (updatedAccountInfo) => {
        this.emit('market', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        { dataSize: MARKET_STATE_LAYOUT_V3.span },
        {
          memcmp: {
            offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
      ],
    );
  }

  /**
   * Subscribe to Raydium AmmV4 pools
   */
  private async subscribeToRaydiumPools(config: InternalListenerConfig): Promise<number> {
    const stats = this.stats.ammv4;

    return this.connection.onProgramAccountChange(
      MAINNET_PROGRAM_ID.AmmV4,
      async (updatedAccountInfo: KeyedAccountInfo) => {
        stats.detected++;

        try {
          const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
          const poolId = updatedAccountInfo.accountId.toString();
          const poolOpenTime = parseInt(poolState.poolOpenTime.toString());
          const baseMint = poolState.baseMint;

          // Deduplication check - only process each pool once
          if (this.processedPools.has(poolId)) {
            return;
          }

          // Check if pool is new enough
          // poolOpenTime === 0 means immediately active (no scheduled opening)
          if (poolOpenTime !== 0 && poolOpenTime <= config.verification.runTimestamp) {
            return;
          }

          // Mark pool as processed
          this.processedPools.add(poolId);
          stats.isNew++;

          // Verify and emit unified event
          await this.verifyAndEmitToken(
            'raydium-ammv4',
            baseMint,
            updatedAccountInfo.accountId,
            config.quoteToken.mint,
            poolOpenTime,
            poolState,
            stats
          );
        } catch (error) {
          stats.errors++;
          logger.trace({ error }, 'Failed to decode AmmV4 pool data');
        }
      },
      this.connection.commitment,
      [
        { dataSize: LIQUIDITY_STATE_LAYOUT_V4.span },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('quoteMint'),
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('marketProgramId'),
            bytes: MAINNET_PROGRAM_ID.OPENBOOK_MARKET.toBase58(),
          },
        },
        {
          memcmp: {
            offset: LIQUIDITY_STATE_LAYOUT_V4.offsetOf('status'),
            bytes: bs58.encode([6, 0, 0, 0, 0, 0, 0, 0]),
          },
        },
      ],
    );
  }

  /**
   * Subscribe to Raydium CPMM pools
   */
  private async subscribeToCpmmPools(config: InternalListenerConfig): Promise<number> {
    const stats = this.stats.cpmm;

    // Log stats every 60 seconds for diagnostics
    const statsInterval = setInterval(() => {
      if (stats.detected > 0) {
        logger.info(
          { ...stats },
          `CPMM listener stats (60s)`
        );
      }
    }, 60000);

    // Store interval for cleanup
    (this as any)._cpmmStatsInterval = statsInterval;

    logger.info(
      {
        programId: CPMM_PROGRAM_ID.toBase58(),
        quoteToken: config.quoteToken.mint.toBase58(),
        dataSize: CpmmPoolInfoLayout.span,
      },
      'Setting up CPMM pool subscription'
    );

    return this.connection.onProgramAccountChange(
      CPMM_PROGRAM_ID,
      async (updatedAccountInfo: KeyedAccountInfo) => {
        stats.detected++;

        try {
          const poolState = CpmmPoolInfoLayout.decode(updatedAccountInfo.accountInfo.data);
          const mintA = poolState.mintA;
          const mintB = poolState.mintB;
          const quoteTokenMint = config.quoteToken.mint;

          // Check if either mint is our quote token
          const isQuoteMintA = mintA.equals(quoteTokenMint);
          const isQuoteMintB = mintB.equals(quoteTokenMint);
          const hasQuoteToken = isQuoteMintA || isQuoteMintB;

          if (!hasQuoteToken) {
            return;
          }

          // Check if swap is enabled (status bit 2)
          const status = poolState.status;
          const swapEnabled = (status & 4) !== 0;

          if (!swapEnabled) {
            return;
          }

          const poolId = updatedAccountInfo.accountId.toString();
          const poolOpenTime = parseInt(poolState.openTime.toString());
          const baseMint = isQuoteMintA ? mintB : mintA;

          // Deduplication check - only process each pool once
          if (this.processedPools.has(poolId)) {
            return;
          }

          // Check if pool is new enough
          // poolOpenTime === 0 means immediately active (no scheduled opening)
          if (poolOpenTime !== 0 && poolOpenTime <= config.verification.runTimestamp) {
            return;
          }

          // Mark pool as processed
          this.processedPools.add(poolId);
          stats.isNew++;

          // Verify and emit unified event
          await this.verifyAndEmitToken(
            'raydium-cpmm',
            baseMint,
            updatedAccountInfo.accountId,
            quoteTokenMint,
            poolOpenTime,
            poolState,
            stats
          );
        } catch (error) {
          stats.errors++;
          logger.trace({ error }, 'Failed to decode CPMM pool data');
        }
      },
      this.connection.commitment,
      [
        { dataSize: CpmmPoolInfoLayout.span },
      ],
    );
  }

  /**
   * Subscribe to Meteora DLMM pools
   */
  private async subscribeToDlmmPools(config: InternalListenerConfig): Promise<number> {
    const stats = this.stats.dlmm;

    // Log stats every 60 seconds for diagnostics
    const statsInterval = setInterval(() => {
      if (stats.detected > 0) {
        logger.info(
          { ...stats },
          `DLMM listener stats (60s)`
        );
      }
    }, 60000);

    // Store interval for cleanup
    (this as any)._dlmmStatsInterval = statsInterval;

    logger.info(
      {
        programId: DLMM_PROGRAM_ID.toBase58(),
        quoteToken: config.quoteToken.mint.toBase58(),
      },
      'Setting up Meteora DLMM pool subscription'
    );

    return this.connection.onProgramAccountChange(
      DLMM_PROGRAM_ID,
      async (updatedAccountInfo: KeyedAccountInfo) => {
        stats.detected++;

        // Only process accounts large enough to be LbPair accounts
        if (updatedAccountInfo.accountInfo.data.length < DLMM_MIN_ACCOUNT_SIZE) {
          return;
        }

        // Check discriminator to ensure this is an LbPair account
        if (!isLbPairAccount(updatedAccountInfo.accountInfo.data)) {
          return;
        }

        try {
          const poolState = decodeDlmmPoolState(updatedAccountInfo.accountInfo.data);
          const tokenXMint = poolState.tokenXMint;
          const tokenYMint = poolState.tokenYMint;
          const quoteTokenMint = config.quoteToken.mint;

          // Check if either token is our quote token
          const isQuoteX = tokenXMint.equals(quoteTokenMint);
          const isQuoteY = tokenYMint.equals(quoteTokenMint);
          const hasQuoteToken = isQuoteX || isQuoteY;

          if (!hasQuoteToken) {
            return;
          }

          // Check if pool is enabled for trading
          const isEnabled = isDlmmPoolEnabled(poolState.status);

          if (!isEnabled) {
            return;
          }

          const baseMint = isQuoteX ? tokenYMint : tokenXMint;
          const poolId = updatedAccountInfo.accountId.toString();
          const activationPoint = parseInt(poolState.activationPoint.toString());

          // CRITICAL: Deduplication check
          // onProgramAccountChange fires on ANY update to an account (trades, liquidity, etc.)
          // We only want to process each pool ONCE
          if (this.processedPools.has(poolId)) {
            return;
          }

          // For DLMM, use activationPoint as pool open time
          // activationPoint === 0 means immediately active
          const currentTimestamp = Math.floor(Date.now() / 1000);
          const poolOpenTime = activationPoint === 0 ? currentTimestamp : activationPoint;

          // Check if pool is new enough
          if (activationPoint !== 0 && activationPoint <= config.verification.runTimestamp) {
            return;
          }

          // Mark pool as processed BEFORE any async operations
          this.processedPools.add(poolId);
          stats.isNew++;

          // Verify and emit unified event
          await this.verifyAndEmitToken(
            'meteora-dlmm',
            baseMint,
            updatedAccountInfo.accountId,
            quoteTokenMint,
            poolOpenTime,
            poolState,
            stats
          );
        } catch (error) {
          stats.errors++;
          logger.trace({ error, dataLength: updatedAccountInfo.accountInfo.data.length }, 'Failed to decode DLMM pool data');
        }
      },
      this.connection.commitment,
    );
  }

  /**
   * Subscribe to wallet changes
   */
  private async subscribeToWalletChanges(config: { walletPublicKey: PublicKey }): Promise<number> {
    return this.connection.onProgramAccountChange(
      TOKEN_PROGRAM_ID,
      async (updatedAccountInfo) => {
        this.emit('wallet', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        {
          dataSize: 165,
        },
        {
          memcmp: {
            offset: 32,
            bytes: config.walletPublicKey.toBase58(),
          },
        },
      ],
    );
  }

  /**
   * Clear all subscriptions
   */
  private async clearSubscriptions(): Promise<void> {
    // Clear stats intervals
    if ((this as any)._cpmmStatsInterval) {
      clearInterval((this as any)._cpmmStatsInterval);
    }
    if ((this as any)._dlmmStatsInterval) {
      clearInterval((this as any)._dlmmStatsInterval);
    }

    for (const subscription of this.subscriptions) {
      try {
        await this.connection.removeAccountChangeListener(subscription);
      } catch (error) {
        // Ignore errors when removing subscriptions (may already be disconnected)
      }
    }
    this.subscriptions = [];
  }

  /**
   * Stop all subscriptions and cleanup
   */
  public async stop(): Promise<void> {
    this.isStopped = true;
    this.isConnected = false;

    // Clear reconnection timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Remove all subscriptions
    await this.clearSubscriptions();

    logger.info('Listeners stopped');
  }

  /**
   * Check if WebSocket is connected
   */
  public getConnectionStatus(): boolean {
    return this.isConnected;
  }

  /**
   * Get reconnection attempt count
   */
  public getReconnectAttempts(): number {
    return this.reconnectAttempts;
  }

  /**
   * Force a reconnection (useful for external triggers)
   */
  public async forceReconnect(): Promise<void> {
    logger.info('Force reconnection requested');
    this.reconnectAttempts = 0;
    this.isReconnecting = false;
    await this.setupSubscriptions();
  }
}
