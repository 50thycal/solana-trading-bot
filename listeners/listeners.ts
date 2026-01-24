import { LIQUIDITY_STATE_LAYOUT_V4, MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';
import bs58 from 'bs58';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { EventEmitter } from 'events';
import { logger, CPMM_PROGRAM_ID, CpmmPoolInfoLayout, CPMM_POOL_STATUS } from '../helpers';

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
}

/**
 * Listeners class - Manages WebSocket subscriptions with automatic reconnection
 *
 * Events emitted:
 * - 'market': New OpenBook market detected
 * - 'pool': New Raydium AmmV4 pool detected
 * - 'cpmm-pool': New Raydium CPMM pool detected
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
   */
  private async subscribeToCpmmPools(config: { quoteToken: Token }): Promise<number> {
    // CPMM uses mintA/mintB instead of baseMint/quoteMint
    // We need to listen for pools where either mintA or mintB is the quote token
    // For simplicity, we filter by mintB (which is typically the quote token like WSOL)
    //
    // CPMM pool layout offsets:
    // - mintA: offset from layout
    // - mintB: offset from layout
    // - status: u8 at a specific offset
    //
    // Status bits: bit 0=deposit, bit 1=withdraw, bit 2=swap
    // We want status where swap is enabled (bit 2 set), which means status & 4 != 0
    // Common values: 7 (all enabled), 4 (swap only)

    return this.connection.onProgramAccountChange(
      CPMM_PROGRAM_ID,
      async (updatedAccountInfo) => {
        this.emit('cpmm-pool', updatedAccountInfo);
      },
      this.connection.commitment,
      [
        { dataSize: CpmmPoolInfoLayout.span },
        {
          // Filter by mintB (quote token) - offset 72 based on layout structure
          // mintA is at offset 40, mintB is at offset 72 (each PublicKey is 32 bytes)
          memcmp: {
            offset: 72, // mintB offset in CpmmPoolInfoLayout
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
        {
          // Filter by status - must have swap enabled (bit 2)
          // Status is at offset 8 (after bump at 0 and padding)
          // We filter for status = 7 (all operations enabled)
          memcmp: {
            offset: 8, // status offset
            bytes: bs58.encode([CPMM_POOL_STATUS.ALL_ENABLED]),
          },
        },
      ],
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
