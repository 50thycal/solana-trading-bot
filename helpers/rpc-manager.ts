import { Connection, Commitment } from '@solana/web3.js';
import { logger } from './logger';

/**
 * RPC endpoint health tracking
 */
interface EndpointHealth {
  url: string;
  wsUrl?: string;
  successCount: number;
  failureCount: number;
  lastFailure?: Date;
  isHealthy: boolean;
}

/**
 * RPC Manager Configuration
 */
export interface RpcManagerConfig {
  primaryEndpoint: string;
  primaryWsEndpoint: string;
  backupEndpoints: string[];
  commitment: Commitment;
  maxFailures: number;
  healthCheckInterval: number;
  recoveryTime: number;
}

const DEFAULT_CONFIG: Partial<RpcManagerConfig> = {
  maxFailures: 3,
  healthCheckInterval: 30000,
  recoveryTime: 60000,
};

/**
 * RPC Manager - Handles multi-endpoint failover for Solana connections
 *
 * Features:
 * - Primary endpoint with backup endpoints for failover
 * - Health tracking for each endpoint
 * - Automatic rotation on failure
 * - Recovery mechanism for previously failed endpoints
 */
export class RpcManager {
  private endpoints: EndpointHealth[] = [];
  private currentIndex: number = 0;
  private currentConnection: Connection | null = null;
  private config: RpcManagerConfig;

  constructor(config: Partial<RpcManagerConfig> & Pick<RpcManagerConfig, 'primaryEndpoint' | 'primaryWsEndpoint' | 'commitment'>) {
    this.config = { ...DEFAULT_CONFIG, ...config } as RpcManagerConfig;

    // Initialize primary endpoint
    this.endpoints.push({
      url: this.config.primaryEndpoint,
      wsUrl: this.config.primaryWsEndpoint,
      successCount: 0,
      failureCount: 0,
      isHealthy: true,
    });

    // Initialize backup endpoints
    const backups = this.config.backupEndpoints || [];
    for (const url of backups) {
      if (url && url.trim()) {
        this.endpoints.push({
          url: url.trim(),
          successCount: 0,
          failureCount: 0,
          isHealthy: true,
        });
      }
    }

    logger.info(`RPC Manager initialized with ${this.endpoints.length} endpoint(s)`);
    if (this.endpoints.length > 1) {
      logger.info(`  Primary: ${this.maskUrl(this.endpoints[0].url)}`);
      for (let i = 1; i < this.endpoints.length; i++) {
        logger.info(`  Backup ${i}: ${this.maskUrl(this.endpoints[i].url)}`);
      }
    }
  }

  /**
   * Mask sensitive parts of URL (API keys) for logging
   */
  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Mask API key if present in query string
      if (parsed.searchParams.has('api-key')) {
        parsed.searchParams.set('api-key', '***');
      }
      if (parsed.searchParams.has('api_key')) {
        parsed.searchParams.set('api_key', '***');
      }
      return parsed.toString();
    } catch {
      return url.substring(0, 30) + '...';
    }
  }

  /**
   * Get the current active connection
   */
  public getConnection(): Connection {
    if (!this.currentConnection) {
      this.currentConnection = this.createConnection(this.getCurrentEndpoint());
    }
    return this.currentConnection;
  }

  /**
   * Get the current endpoint info
   */
  public getCurrentEndpoint(): EndpointHealth {
    return this.endpoints[this.currentIndex];
  }

  /**
   * Create a new connection for an endpoint
   */
  private createConnection(endpoint: EndpointHealth): Connection {
    return new Connection(endpoint.url, {
      wsEndpoint: endpoint.wsUrl,
      commitment: this.config.commitment,
    });
  }

  /**
   * Report a successful operation
   */
  public reportSuccess(): void {
    const endpoint = this.endpoints[this.currentIndex];
    endpoint.successCount++;
    endpoint.isHealthy = true;
  }

  /**
   * Report a failed operation
   * Returns true if we successfully rotated to a new endpoint
   */
  public reportFailure(): boolean {
    const endpoint = this.endpoints[this.currentIndex];
    endpoint.failureCount++;
    endpoint.lastFailure = new Date();

    logger.warn({ endpoint: this.maskUrl(endpoint.url), failures: endpoint.failureCount }, 'RPC endpoint failure');

    // Check if we should mark as unhealthy
    if (endpoint.failureCount >= this.config.maxFailures) {
      endpoint.isHealthy = false;
      logger.error({ endpoint: this.maskUrl(endpoint.url) }, 'Endpoint marked as unhealthy');

      // Try to rotate to a healthy endpoint
      return this.rotateToHealthy();
    }

    return true;
  }

  /**
   * Rotate to the next healthy endpoint
   */
  private rotateToHealthy(): boolean {
    const startIndex = this.currentIndex;
    let attempts = 0;

    while (attempts < this.endpoints.length) {
      this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
      const endpoint = this.endpoints[this.currentIndex];

      // Check if endpoint has recovered (enough time passed since last failure)
      if (!endpoint.isHealthy && endpoint.lastFailure) {
        const timeSinceFailure = Date.now() - endpoint.lastFailure.getTime();
        if (timeSinceFailure > this.config.recoveryTime) {
          endpoint.isHealthy = true;
          endpoint.failureCount = 0;
          logger.info({ endpoint: this.maskUrl(endpoint.url) }, 'Endpoint recovered, retrying');
        }
      }

      if (endpoint.isHealthy) {
        // Found a healthy endpoint
        if (this.currentIndex !== startIndex) {
          this.currentConnection = this.createConnection(endpoint);
          logger.info({ endpoint: this.maskUrl(endpoint.url) }, 'Rotated to new RPC endpoint');
        }
        return true;
      }

      attempts++;
    }

    // No healthy endpoints found
    logger.error('No healthy RPC endpoints available');
    return false;
  }

  /**
   * Force rotation to the next endpoint (regardless of health)
   */
  public forceRotate(): void {
    this.currentIndex = (this.currentIndex + 1) % this.endpoints.length;
    const endpoint = this.endpoints[this.currentIndex];
    this.currentConnection = this.createConnection(endpoint);
    logger.info({ endpoint: this.maskUrl(endpoint.url) }, 'Force rotated to next endpoint');
  }

  /**
   * Get the count of healthy endpoints
   */
  public getHealthyCount(): number {
    return this.endpoints.filter(e => e.isHealthy).length;
  }

  /**
   * Get all endpoint health status
   */
  public getHealthStatus(): { total: number; healthy: number; endpoints: EndpointHealth[] } {
    return {
      total: this.endpoints.length,
      healthy: this.getHealthyCount(),
      endpoints: this.endpoints.map(e => ({
        ...e,
        url: this.maskUrl(e.url),
        wsUrl: e.wsUrl ? this.maskUrl(e.wsUrl) : undefined,
      })),
    };
  }

  /**
   * Check if we have any healthy endpoints
   */
  public hasHealthyEndpoint(): boolean {
    return this.getHealthyCount() > 0;
  }

  /**
   * Reset all endpoint health statistics
   */
  public resetHealth(): void {
    for (const endpoint of this.endpoints) {
      endpoint.successCount = 0;
      endpoint.failureCount = 0;
      endpoint.lastFailure = undefined;
      endpoint.isHealthy = true;
    }
    logger.info('Reset all endpoint health statistics');
  }
}

/**
 * Singleton RPC Manager instance
 */
let rpcManagerInstance: RpcManager | null = null;

/**
 * Initialize the global RPC Manager
 */
export function initRpcManager(config: Partial<RpcManagerConfig> & Pick<RpcManagerConfig, 'primaryEndpoint' | 'primaryWsEndpoint' | 'commitment'>): RpcManager {
  rpcManagerInstance = new RpcManager(config);
  return rpcManagerInstance;
}

/**
 * Get the global RPC Manager instance
 */
export function getRpcManager(): RpcManager {
  if (!rpcManagerInstance) {
    throw new Error('RPC Manager not initialized. Call initRpcManager() first.');
  }
  return rpcManagerInstance;
}

/**
 * Check if an error is a 429 rate limit error
 */
function isRateLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
  }
  return false;
}

/**
 * Execute an operation with automatic retry, 429 backoff, and failover
 */
export async function withRpcRetry<T>(
  operation: (connection: Connection) => Promise<T>,
  maxRetries: number = 3,
): Promise<T> {
  const manager = getRpcManager();
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const connection = manager.getConnection();
      const result = await operation(connection);
      manager.reportSuccess();
      return result;
    } catch (error) {
      lastError = error as Error;

      // 429 rate limit: exponential backoff (1s, 2s, 4s) without endpoint rotation
      if (isRateLimitError(error)) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
        logger.warn(
          { attempt: attempt + 1, backoffMs },
          'RPC rate limited (429) - backing off',
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      logger.warn({ attempt: attempt + 1, error: lastError.message }, 'RPC operation failed');

      const rotated = manager.reportFailure();
      if (!rotated) {
        break;
      }
    }
  }

  throw lastError || new Error('RPC operation failed after all retries');
}
