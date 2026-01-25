import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import {
  logger,
  CPMM_PROGRAM_ID,
  CpmmPoolInfoLayout,
  CPMM_POOL_STATUS,
  DLMM_PROGRAM_ID,
  DlmmLbPairLayout,
  decodeDlmmPoolState,
  isDlmmPoolEnabled,
  isLbPairAccount,
} from '../helpers';

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
 * Listener configuration
 */
export interface ListenerConfig {
  walletPublicKey: PublicKey;
  quoteToken: Token;
  autoSell: boolean;
  cacheNewMarkets: boolean;
  enableCpmm: boolean;
  enableDlmm: boolean;
}

/**
 * Listeners class - Manages WebSocket subscriptions with automatic reconnection
 *
 * Events emitted:
 * - 'market': New OpenBook market detected
 * - 'pool': New Raydium AmmV4 pool detected
 * - 'cpmm-pool': New Raydium CPMM pool detected
 * - 'dlmm-pool': New Meteora DLMM pool detected
 * - 'wallet': Wallet account changed
 * - 'connected': WebSocket connected/reconnected
 * - 'disconnected': WebSocket disconnected
 * - 'reconnecting': Attempting reconnection
 * - 'error': Error occurred
 */
export class Listeners extends EventEmitter {
  private subscriptions: number[] = [];
  private config: ListenerConfig | null = null;
  private reconnectionConfig: ReconnectionConfig;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isReconnecting: boolean = false;
  private isStopped: boolean = false;

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
    this.config = config;
    this.isStopped = false;
    await this.setupSubscriptions();
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
   * Subscribe to Raydium pools
   */
  private async subscribeToRaydiumPools(config: { quoteToken: Token }): Promise<number> {
    return this.connection.onProgramAccountChange(
      MAINNET_PROGRAM_ID.AmmV4,
      async (updatedAccountInfo) => {
        this.emit('pool', updatedAccountInfo);
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
   * CPMM pools use a different program and layout than AmmV4
   *
   * Note: We only process pools that already have swap enabled (status bit 2).
   * The WebSocket subscription will notify us when a pool's status changes,
   * so there's no need for manual retries. If a pool is created with status 0
   * and later gets swap enabled, we'll receive a new event at that time.
   */
  private async subscribeToCpmmPools(config: { quoteToken: Token }): Promise<number> {
    // CPMM uses mintA/mintB instead of baseMint/quoteMint
    // The quote token (WSOL) can be in either mintA or mintB position
    // We filter only by dataSize and do quote token filtering in the event handler
    // This is more reliable than guessing memcmp offsets

    // Diagnostic counters for debugging
    let totalEvents = 0;
    let decodeErrors = 0;
    let noQuoteToken = 0;
    let swapNotEnabled = 0;
    let emitted = 0;

    // Log stats every 60 seconds for diagnostics
    setInterval(() => {
      if (totalEvents > 0 || emitted > 0) {
        logger.info(
          {
            totalEvents,
            decodeErrors,
            noQuoteToken,
            swapNotEnabled,
            emitted,
          },
          `CPMM listener stats (60s): raw=${totalEvents} | noQuote=${noQuoteToken} | swapDisabled=${swapNotEnabled} | decodeErr=${decodeErrors} | emitted=${emitted}`
        );
      }
      // Reset counters
      totalEvents = 0;
      decodeErrors = 0;
      noQuoteToken = 0;
      swapNotEnabled = 0;
      emitted = 0;
    }, 60000);

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
      async (updatedAccountInfo) => {
        totalEvents++;

        // Decode and filter in handler - quote token can be mintA OR mintB
        try {
          const poolState = CpmmPoolInfoLayout.decode(updatedAccountInfo.accountInfo.data);
          const mintA = poolState.mintA;
          const mintB = poolState.mintB;
          const quoteTokenMint = config.quoteToken.mint;

          // Check if either mint is our quote token
          const hasQuoteToken = mintA.equals(quoteTokenMint) || mintB.equals(quoteTokenMint);

          if (hasQuoteToken) {
            // Check if swap is enabled (status bit 2)
            const status = poolState.status;
            const swapEnabled = (status & 4) !== 0;

            if (swapEnabled) {
              emitted++;
              // Swap is enabled - emit the pool for processing
              this.emit('cpmm-pool', updatedAccountInfo);
            } else {
              swapNotEnabled++;
            }
            // Note: If swap is not enabled, we simply skip this event.
            // The WebSocket will notify us again if/when the status changes.
          } else {
            noQuoteToken++;
          }
        } catch (error) {
          decodeErrors++;
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
   * DLMM (Dynamic Liquidity Market Maker) is Meteora's bin-based AMM
   *
   * Note: We only process pools that are enabled (status = 1).
   * The WebSocket subscription will notify us when a pool's status changes.
   *
   * IMPORTANT: DLMM LbPair accounts are much larger than our partial layout
   * (~10KB+) due to bin arrays. We don't filter by dataSize and instead
   * rely on the discriminator check in the decoder.
   */
  private async subscribeToDlmmPools(config: { quoteToken: Token }): Promise<number> {
    // DLMM uses tokenXMint/tokenYMint - the quote token can be in either position
    // We don't filter by dataSize because LbPair accounts are much larger than our layout
    // (they contain bin arrays). We filter by quote token + status in the handler.

    // Diagnostic counters for debugging
    let totalEvents = 0;
    let tooSmall = 0;
    let notLbPair = 0;
    let decodeErrors = 0;
    let noQuoteToken = 0;
    let notEnabled = 0;
    let emitted = 0;

    // Log stats every 60 seconds for diagnostics
    setInterval(() => {
      if (totalEvents > 0 || emitted > 0) {
        logger.info(
          {
            totalEvents,
            tooSmall,
            notLbPair,
            decodeErrors,
            noQuoteToken,
            notEnabled,
            emitted,
          },
          `DLMM listener stats (60s): raw=${totalEvents} | tooSmall=${tooSmall} | notLbPair=${notLbPair} | noQuote=${noQuoteToken} | notEnabled=${notEnabled} | decodeErr=${decodeErrors} | emitted=${emitted}`
        );
      }
      // Reset counters
      totalEvents = 0;
      tooSmall = 0;
      notLbPair = 0;
      decodeErrors = 0;
      noQuoteToken = 0;
      notEnabled = 0;
      emitted = 0;
    }, 60000);

    logger.info(
      {
        programId: DLMM_PROGRAM_ID.toBase58(),
        quoteToken: config.quoteToken.mint.toBase58(),
      },
      'Setting up Meteora DLMM pool subscription (no dataSize filter - LbPair accounts vary in size)'
    );

    return this.connection.onProgramAccountChange(
      DLMM_PROGRAM_ID,
      async (updatedAccountInfo) => {
        totalEvents++;

        // Only process accounts large enough to be LbPair accounts (>= 300 bytes)
        if (updatedAccountInfo.accountInfo.data.length < 300) {
          tooSmall++;
          return; // Skip small accounts (not LbPair)
        }

        // Check discriminator to ensure this is an LbPair account (not BinArray, Position, etc.)
        if (!isLbPairAccount(updatedAccountInfo.accountInfo.data)) {
          notLbPair++;
          return; // Skip non-LbPair accounts
        }

        try {
          const poolState = decodeDlmmPoolState(updatedAccountInfo.accountInfo.data);
          const tokenXMint = poolState.tokenXMint;
          const tokenYMint = poolState.tokenYMint;
          const quoteTokenMint = config.quoteToken.mint;

          // Debug: Log first few LbPair accounts with raw byte info to verify layout
          if (emitted === 0 && noQuoteToken <= 2) {
            const data = updatedAccountInfo.accountInfo.data;
            // Log discriminator and check various offsets for WSOL
            const disc = data.subarray(0, 8);
            // Check if WSOL appears anywhere in first 200 bytes
            const wsol = 'So11111111111111111111111111111111111111112';
            const wsolBytes = Buffer.from([6,155,136,87,254,171,129,132,251,104,127,99,70,24,192,53,218,196,57,220,26,235,59,85,152,160,240,0,0,0,0,1]);

            // Try reading pubkey at different offsets to find where mints really are
            const at8 = new PublicKey(data.subarray(8, 40)).toBase58();
            const at40 = new PublicKey(data.subarray(40, 72)).toBase58();
            const at72 = new PublicKey(data.subarray(72, 104)).toBase58();
            const at104 = new PublicKey(data.subarray(104, 136)).toBase58();
            const at136 = new PublicKey(data.subarray(136, 168)).toBase58();

            logger.info(
              `DLMM BYTE DEBUG: disc=[${Array.from(disc).join(',')}] | at8=${at8} | at40=${at40} | at72=${at72} | at104=${at104} | at136=${at136} | quote=${quoteTokenMint.toBase58()}`
            );
          }

          // Check if either token is our quote token
          const hasQuoteToken = tokenXMint.equals(quoteTokenMint) || tokenYMint.equals(quoteTokenMint);

          if (hasQuoteToken) {
            // Check if pool is enabled for trading
            const isEnabled = isDlmmPoolEnabled(poolState.status);

            if (isEnabled) {
              emitted++;
              // Pool is enabled - emit for processing
              this.emit('dlmm-pool', updatedAccountInfo);
            } else {
              notEnabled++;
            }
            // Note: If pool is not enabled, we skip this event.
            // The WebSocket will notify us again if/when the status changes.
          } else {
            noQuoteToken++;
          }
        } catch (error) {
          decodeErrors++;
          logger.trace({ error, dataLength: updatedAccountInfo.accountInfo.data.length }, 'Failed to decode DLMM pool data');
        }
      },
      this.connection.commitment,
      // No dataSize filter - LbPair accounts are much larger than our partial layout
      // All filtering happens in the handler above
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
