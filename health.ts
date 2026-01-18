import http from 'http';
import { logger } from './helpers';

/**
 * Health status interface
 */
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  websocket: {
    connected: boolean;
    lastActivity?: string;
  };
  rpc: {
    healthy: boolean;
    endpoint?: string;
  };
  checks: {
    name: string;
    status: 'pass' | 'fail';
    message?: string;
  }[];
}

/**
 * Health check callback type
 */
export type HealthCheck = () => Promise<{ status: 'pass' | 'fail'; message?: string }>;

/**
 * Health Server - Provides HTTP health check endpoint for monitoring
 *
 * Features:
 * - /health endpoint returns 200 if healthy, 503 if not
 * - Configurable health checks
 * - JSON response with detailed status
 */
export class HealthServer {
  private server: http.Server | null = null;
  private startTime: Date;
  private isWebSocketConnected: boolean = false;
  private lastWebSocketActivity: Date | null = null;
  private isRpcHealthy: boolean = true;
  private rpcEndpoint: string = '';
  private healthChecks: Map<string, HealthCheck> = new Map();

  constructor(private readonly port: number = 8080) {
    this.startTime = new Date();
  }

  /**
   * Start the health check server
   */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error) => {
        logger.error({ error }, 'Health server error');
        reject(error);
      });

      this.server.listen(this.port, () => {
        logger.info({ port: this.port }, 'Health server started');
        resolve();
      });
    });
  }

  /**
   * Stop the health check server
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Health server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming HTTP requests
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';

    if (url === '/health' || url === '/healthz') {
      await this.handleHealthCheck(res);
    } else if (url === '/ready' || url === '/readyz') {
      await this.handleReadyCheck(res);
    } else if (url === '/live' || url === '/livez') {
      this.handleLiveCheck(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  /**
   * Handle /health endpoint
   */
  private async handleHealthCheck(res: http.ServerResponse): Promise<void> {
    const status = await this.getHealthStatus();
    const httpStatus = status.status === 'healthy' ? 200 : status.status === 'degraded' ? 200 : 503;

    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  }

  /**
   * Handle /ready endpoint (readiness probe)
   */
  private async handleReadyCheck(res: http.ServerResponse): Promise<void> {
    const isReady = this.isWebSocketConnected && this.isRpcHealthy;
    const httpStatus = isReady ? 200 : 503;

    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ready: isReady,
      websocket: this.isWebSocketConnected,
      rpc: this.isRpcHealthy,
    }));
  }

  /**
   * Handle /live endpoint (liveness probe)
   */
  private handleLiveCheck(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alive: true }));
  }

  /**
   * Get the full health status
   */
  public async getHealthStatus(): Promise<HealthStatus> {
    const checks: HealthStatus['checks'] = [];

    // Run registered health checks
    for (const [name, check] of this.healthChecks) {
      try {
        const result = await check();
        checks.push({ name, ...result });
      } catch (error) {
        checks.push({ name, status: 'fail', message: (error as Error).message });
      }
    }

    // WebSocket check
    checks.push({
      name: 'websocket',
      status: this.isWebSocketConnected ? 'pass' : 'fail',
      message: this.isWebSocketConnected ? 'Connected' : 'Disconnected',
    });

    // RPC check
    checks.push({
      name: 'rpc',
      status: this.isRpcHealthy ? 'pass' : 'fail',
      message: this.isRpcHealthy ? 'Healthy' : 'Unhealthy',
    });

    // Determine overall status
    const failedChecks = checks.filter(c => c.status === 'fail');
    let status: HealthStatus['status'] = 'healthy';
    if (failedChecks.length > 0) {
      // WebSocket disconnection is critical
      if (failedChecks.some(c => c.name === 'websocket')) {
        status = 'unhealthy';
      } else {
        status = 'degraded';
      }
    }

    return {
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
      websocket: {
        connected: this.isWebSocketConnected,
        lastActivity: this.lastWebSocketActivity?.toISOString(),
      },
      rpc: {
        healthy: this.isRpcHealthy,
        endpoint: this.rpcEndpoint,
      },
      checks,
    };
  }

  /**
   * Update WebSocket connection status
   */
  public setWebSocketConnected(connected: boolean): void {
    const wasConnected = this.isWebSocketConnected;
    this.isWebSocketConnected = connected;

    if (connected) {
      this.lastWebSocketActivity = new Date();
    }

    if (wasConnected !== connected) {
      logger.info({ connected }, 'WebSocket connection status changed');
    }
  }

  /**
   * Record WebSocket activity
   */
  public recordWebSocketActivity(): void {
    this.lastWebSocketActivity = new Date();
  }

  /**
   * Update RPC health status
   */
  public setRpcHealthy(healthy: boolean, endpoint?: string): void {
    this.isRpcHealthy = healthy;
    if (endpoint) {
      this.rpcEndpoint = endpoint;
    }
  }

  /**
   * Register a custom health check
   */
  public registerHealthCheck(name: string, check: HealthCheck): void {
    this.healthChecks.set(name, check);
  }

  /**
   * Unregister a health check
   */
  public unregisterHealthCheck(name: string): void {
    this.healthChecks.delete(name);
  }

  /**
   * Check if the service is healthy
   */
  public isHealthy(): boolean {
    return this.isWebSocketConnected && this.isRpcHealthy;
  }
}

/**
 * Singleton health server instance
 */
let healthServerInstance: HealthServer | null = null;

/**
 * Initialize the global health server
 */
export function initHealthServer(port: number = 8080): HealthServer {
  healthServerInstance = new HealthServer(port);
  return healthServerInstance;
}

/**
 * Get the global health server instance
 */
export function getHealthServer(): HealthServer {
  if (!healthServerInstance) {
    throw new Error('Health server not initialized. Call initHealthServer() first.');
  }
  return healthServerInstance;
}

/**
 * Start the health server (convenience function)
 */
export async function startHealthServer(port: number = 8080): Promise<HealthServer> {
  const server = initHealthServer(port);
  await server.start();
  return server;
}
