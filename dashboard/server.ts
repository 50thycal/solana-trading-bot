/**
 * Phase 5: Dashboard Server
 *
 * Provides web dashboard for monitoring the trading bot.
 * Serves both API endpoints and static UI files.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { logger } from '../helpers';
import { getStateStore } from '../persistence';
import { getPnlTracker, getExposureManager, getPumpFunPositionMonitor } from '../risk';
import { PoolAction, PoolType } from '../persistence/models';
import { getPipelineStats, resetPipelineStats } from '../pipeline';
import { getPaperTradeTracker } from '../risk';

// Test trade module removed (was Raydium-specific)
const executeTestTrade: ((options: { poolId: string; dryRun: boolean; amount?: number }) => Promise<any>) | null = null;

/**
 * Dashboard server configuration
 */
export interface DashboardConfig {
  port: number;
  pollInterval: number; // Client-side poll interval in ms
}

/**
 * MIME types for static file serving
 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * Dashboard Server - Combined health check and monitoring dashboard
 */
export class DashboardServer {
  private server: http.Server | null = null;
  private startTime: Date;
  private isWebSocketConnected: boolean = false;
  private lastWebSocketActivity: Date | null = null;
  private isRpcHealthy: boolean = true;
  private rpcEndpoint: string = '';
  private publicDir: string;

  constructor(private readonly config: DashboardConfig) {
    this.startTime = new Date();
    this.publicDir = path.join(__dirname, 'public');
  }

  /**
   * Start the dashboard server
   */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          logger.error({ error }, 'Dashboard request error');
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      });

      this.server.on('error', (error) => {
        logger.error({ error }, 'Dashboard server error');
        reject(error);
      });

      this.server.listen(this.config.port, () => {
        logger.info({ port: this.config.port }, 'Dashboard server started');
        resolve();
      });
    });
  }

  /**
   * Stop the dashboard server
   */
  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Dashboard server stopped');
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
    const url = new URL(req.url || '/', `http://localhost:${this.config.port}`);
    const pathname = url.pathname;

    // Add CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Handle POST requests to API
    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      await this.handlePostRequest(pathname, req, res);
      return;
    }

    // Health endpoints
    if (pathname === '/health' || pathname === '/healthz') {
      await this.handleHealthCheck(res);
      return;
    }

    if (pathname === '/ready' || pathname === '/readyz') {
      this.handleReadyCheck(res);
      return;
    }

    if (pathname === '/live' || pathname === '/livez') {
      this.handleLiveCheck(res);
      return;
    }

    // API endpoints
    if (pathname.startsWith('/api/')) {
      await this.handleApiRequest(pathname, url, res);
      return;
    }

    // Static file serving (dashboard UI)
    await this.handleStaticFile(pathname, res);
  }

  // ============================================================
  // HEALTH ENDPOINTS
  // ============================================================

  private async handleHealthCheck(res: http.ServerResponse): Promise<void> {
    const status = this.getHealthStatus();
    const httpStatus = status.status === 'healthy' ? 200 : status.status === 'degraded' ? 200 : 503;

    res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
  }

  private handleReadyCheck(res: http.ServerResponse): void {
    const isReady = this.isWebSocketConnected && this.isRpcHealthy;
    res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ready: isReady }));
  }

  private handleLiveCheck(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ alive: true }));
  }

  private getHealthStatus() {
    const checks = [
      {
        name: 'websocket',
        status: this.isWebSocketConnected ? 'pass' : 'fail',
        message: this.isWebSocketConnected ? 'Connected' : 'Disconnected',
      },
      {
        name: 'rpc',
        status: this.isRpcHealthy ? 'pass' : 'fail',
        message: this.isRpcHealthy ? 'Healthy' : 'Unhealthy',
      },
    ];

    const failedChecks = checks.filter((c) => c.status === 'fail');
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (failedChecks.length > 0) {
      status = failedChecks.some((c) => c.name === 'websocket') ? 'unhealthy' : 'degraded';
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

  // ============================================================
  // API ENDPOINTS
  // ============================================================

  private async handleApiRequest(pathname: string, url: URL, res: http.ServerResponse): Promise<void> {
    try {
      let data: any;

      switch (pathname) {
        case '/api/status':
          data = await this.getApiStatus();
          break;

        case '/api/pools':
          data = this.getApiPools(url);
          break;

        case '/api/positions':
          data = this.getApiPositions();
          break;

        case '/api/trades':
          data = this.getApiTrades(url);
          break;

        case '/api/pnl':
          data = this.getApiPnl();
          break;

        case '/api/config':
          data = this.getApiConfig();
          break;

        case '/api/stats':
          data = this.getApiStats();
          break;

        case '/api/pipeline-stats':
          data = this.getApiPipelineStats();
          break;

        case '/api/paper-trades':
          data = this.getApiPaperTrades();
          break;

        default:
          // Check for /api/pools/:id pattern
          if (pathname.startsWith('/api/pools/')) {
            const id = pathname.substring('/api/pools/'.length);
            data = this.getApiPoolById(id);
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'API endpoint not found' }));
            return;
          }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error({ error, pathname }, 'API request error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Handle POST requests to API endpoints
   */
  private async handlePostRequest(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      // Parse request body
      const body = await this.parseRequestBody(req);

      switch (pathname) {
        case '/api/test-trade':
          await this.handleTestTrade(body, res);
          break;

        case '/api/pipeline-stats/reset':
          await this.handleResetPipelineStats(res);
          break;

        case '/api/paper-trades/check-pnl':
          await this.handleCheckPaperPnL(res);
          break;

        case '/api/paper-trades/clear':
          await this.handleClearPaperTrades(res);
          break;

        default:
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'API endpoint not found' }));
      }
    } catch (error) {
      logger.error({ error, pathname }, 'POST request error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  /**
   * Parse JSON request body
   */
  private parseRequestBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch (error) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /**
   * POST /api/test-trade - Execute a test trade
   */
  private async handleTestTrade(
    body: { poolId?: string; dryRun?: boolean; amount?: number },
    res: http.ServerResponse,
  ): Promise<void> {
    // Check if test trade module is available
    if (!executeTestTrade) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        message: 'Test trade feature is not available',
        error: 'Test trade module not loaded',
      }));
      return;
    }

    const { poolId, dryRun = false, amount } = body;

    if (!poolId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: poolId' }));
      return;
    }

    // Validate poolId format (basic check for base58)
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(poolId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid poolId format' }));
      return;
    }

    // Validate amount if provided
    if (amount !== undefined && (typeof amount !== 'number' || amount <= 0)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid amount: must be a positive number' }));
      return;
    }

    logger.info({ poolId, dryRun, amount }, 'Test trade request received');

    try {
      const result = await executeTestTrade({
        poolId,
        dryRun,
        amount,
      });

      res.writeHead(result.success ? 200 : 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result, null, 2));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage, poolId }, 'Test trade execution failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        message: 'Test trade execution failed',
        error: errorMessage,
      }));
    }
  }

  /**
   * GET /api/status - Bot status overview
   */
  private async getApiStatus() {
    const stateStore = getStateStore();
    const pnlTracker = getPnlTracker();
    const exposureManager = getExposureManager();
    const pumpFunMonitor = getPumpFunPositionMonitor();

    const uptimeSeconds = Math.floor((Date.now() - this.startTime.getTime()) / 1000);
    const pnlSummary = pnlTracker?.getSessionSummary();
    const exposureStats = exposureManager?.getStats();
    const pumpFunMonitorStats = pumpFunMonitor?.getStats();

    // Fetch actual wallet balance from chain
    const walletBalance = exposureManager ? await exposureManager.getWalletBalance() : null;

    // Calculate unrealized PnL from pump.fun positions
    const totalUnrealizedPnl = pumpFunMonitorStats?.unrealizedPnl || 0;

    return {
      status: this.isWebSocketConnected ? 'running' : 'disconnected',
      uptime: uptimeSeconds,
      uptimeFormatted: this.formatUptime(uptimeSeconds),
      websocket: {
        connected: this.isWebSocketConnected,
        lastActivity: this.lastWebSocketActivity?.toISOString(),
      },
      rpc: {
        healthy: this.isRpcHealthy,
        endpoint: this.rpcEndpoint,
      },
      walletBalance, // Actual SOL balance from wallet
      exposure: exposureStats
        ? {
            currentExposure: exposureStats.totalExposure,
            maxExposure: exposureStats.maxExposure,
            tradesThisHour: exposureStats.tradesThisHour,
            maxTradesPerHour: exposureStats.maxTradesPerHour,
          }
        : null,
      positions: {
        open: stateStore?.getOpenPositions().length || 0,
        monitored: pumpFunMonitorStats?.positionCount || 0,
      },
      pnl: pnlSummary
        ? {
            realized: pnlSummary.realizedPnlSol,
            unrealized: totalUnrealizedPnl,
            total: pnlSummary.realizedPnlSol + totalUnrealizedPnl,
          }
        : null,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /api/pools - Pool detections list
   */
  private getApiPools(url: URL) {
    const stateStore = getStateStore();
    if (!stateStore) {
      return { pools: [], total: 0, error: 'State store not initialized' };
    }

    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);
    const action = url.searchParams.get('action') as PoolAction | null;
    const poolType = url.searchParams.get('poolType') as PoolType | null;

    const pools = stateStore.getPoolDetections({
      limit,
      offset,
      action: action || undefined,
      poolType: poolType || undefined,
    });

    const total = stateStore.getPoolDetectionCount(action || undefined, poolType || undefined);

    return {
      pools,
      total,
      limit,
      offset,
    };
  }

  /**
   * GET /api/pools/:id - Single pool detection
   */
  private getApiPoolById(id: string) {
    const stateStore = getStateStore();
    if (!stateStore) {
      return { error: 'State store not initialized' };
    }

    const pool = stateStore.getPoolDetectionById(id);
    if (!pool) {
      return { error: 'Pool detection not found' };
    }

    return pool;
  }

  /**
   * GET /api/positions - Open positions
   */
  private getApiPositions() {
    const stateStore = getStateStore();
    const pumpFunMonitor = getPumpFunPositionMonitor();

    if (!stateStore) {
      return { positions: [], error: 'State store not initialized' };
    }

    // Get pump.fun monitored positions for enrichment
    const pumpFunPositions = pumpFunMonitor?.getPositions() || [];
    const pumpFunPosMap = new Map(pumpFunPositions.map(p => [p.tokenMint, p]));

    const positions = stateStore.getOpenPositions().map((pos) => {
      const monitoredPos = pumpFunPosMap.get(pos.tokenMint);
      let currentPnlPercent: number | undefined;
      if (monitoredPos && monitoredPos.lastCurrentValueSol !== undefined) {
        const pnlSol = monitoredPos.lastCurrentValueSol - monitoredPos.entryAmountSol;
        currentPnlPercent = monitoredPos.entryAmountSol > 0
          ? (pnlSol / monitoredPos.entryAmountSol) * 100
          : 0;
      }
      return {
        ...pos,
        currentPriceSol: monitoredPos?.lastCurrentValueSol,
        currentPnlPercent,
        isMonitored: !!monitoredPos,
      };
    });

    return { positions };
  }

  /**
   * GET /api/trades - Trade history
   */
  private getApiTrades(url: URL) {
    const stateStore = getStateStore();
    if (!stateStore) {
      return { trades: [], error: 'State store not initialized' };
    }

    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const trades = stateStore.getRecentTrades(limit);

    return { trades, limit };
  }

  /**
   * GET /api/pnl - P&L summary
   */
  private getApiPnl() {
    const pnlTracker = getPnlTracker();
    const stateStore = getStateStore();
    const pumpFunMonitor = getPumpFunPositionMonitor();

    if (!pnlTracker) {
      return { error: 'P&L tracker not initialized' };
    }

    const summary = pnlTracker.getSessionSummary();
    const tradeStats = stateStore?.getTradeStats();
    const pumpFunMonitorStats = pumpFunMonitor?.getStats();

    const unrealizedPnl = pumpFunMonitorStats?.unrealizedPnl || 0;

    return {
      realized: summary.realizedPnlSol,
      unrealized: unrealizedPnl,
      total: summary.realizedPnlSol + unrealizedPnl,
      winRate: summary.winRate,
      totalTrades: summary.totalTrades,
      winningTrades: summary.totalSells,
      losingTrades: 0,
      dbStats: tradeStats,
      breakdown: {
        pumpfun: {
          unrealized: unrealizedPnl,
          positions: pumpFunMonitorStats?.positionCount || 0,
        },
      },
    };
  }

  /**
   * GET /api/config - Current configuration (safe values only)
   */
  private getApiConfig() {
    // Import dynamically to avoid circular dependencies
    const { getConfig } = require('../helpers/config-validator');
    const config = getConfig();

    // Return only safe, non-sensitive values
    return {
      mode: {
        dryRun: config.dryRun,
        logLevel: config.logLevel,
      },
      trading: {
        quoteAmount: config.quoteAmount,
        buySlippage: config.buySlippage,
        sellSlippage: config.sellSlippage,
        takeProfit: config.takeProfit,
        stopLoss: config.stopLoss,
        autoBuyDelay: config.autoBuyDelay,
        autoSell: config.autoSell,
        oneTokenAtATime: config.oneTokenAtATime,
      },
      filters: {
        preset: config.filterPreset,
        checkIfBurned: config.checkIfBurned,
        checkIfMintIsRenounced: config.checkIfMintIsRenounced,
        checkIfFreezable: config.checkIfFreezable,
        checkIfMutable: config.checkIfMutable,
        checkIfSocials: config.checkIfSocials,
        minPoolSize: config.minPoolSize,
        maxPoolSize: config.maxPoolSize,
        filterCheckInterval: config.filterCheckInterval,
        filterCheckDuration: config.filterCheckDuration,
        consecutiveFilterMatches: config.consecutiveFilterMatches,
      },
      risk: {
        maxTotalExposureSol: config.maxTotalExposureSol,
        maxTradesPerHour: config.maxTradesPerHour,
        minWalletBufferSol: config.minWalletBufferSol,
        maxHoldDurationMs: config.maxHoldDurationMs,
      },
      execution: {
        executor: config.transactionExecutor,
        simulateTransaction: config.simulateTransaction,
        useDynamicFee: config.useDynamicFee,
        useFallbackExecutor: config.useFallbackExecutor,
        precomputeTransaction: config.precomputeTransaction,
      },
    };
  }

  /**
   * GET /api/stats - Aggregated statistics
   */
  private getApiStats() {
    const stateStore = getStateStore();
    if (!stateStore) {
      return { error: 'State store not initialized' };
    }

    const dbStats = stateStore.getStats();
    const poolStats = stateStore.getPoolDetectionStats();

    // Sort filter rejection counts by frequency
    const sortedRejections = Object.entries(poolStats.filterRejectionCounts)
      .sort(([, a], [, b]) => b - a)
      .map(([name, count]) => ({ name, count }));

    return {
      pools: {
        totalDetected: poolStats.totalDetected,
        bought: poolStats.totalBought,
        filtered: poolStats.totalFiltered,
        skipped: poolStats.totalSkipped,
        blacklisted: poolStats.totalBlacklisted,
        buyRate:
          poolStats.totalDetected > 0
            ? ((poolStats.totalBought / poolStats.totalDetected) * 100).toFixed(1)
            : '0',
      },
      trades: dbStats.trades,
      positions: dbStats.positions,
      topRejectionReasons: sortedRejections.slice(0, 10),
      blacklist: dbStats.blacklist,
    };
  }

  /**
   * GET /api/pipeline-stats - Pipeline statistics for pump.fun dashboard
   */
  private getApiPipelineStats() {
    const pipelineStats = getPipelineStats();
    if (!pipelineStats) {
      return {
        error: 'Pipeline stats not initialized',
        startedAt: Date.now(),
        tokensDetected: 0,
        tokensBought: 0,
        tokensRejected: 0,
        buyRate: 0,
        gateStats: { cheapGates: [], deepFilters: [] },
        topRejectionReasons: [],
        avgPipelineDurationMs: 0,
        recentTokens: [],
      };
    }

    return pipelineStats.getSnapshot();
  }

  /**
   * POST /api/pipeline-stats/reset - Reset pipeline statistics
   */
  private async handleResetPipelineStats(res: http.ServerResponse): Promise<void> {
    try {
      resetPipelineStats();
      logger.info('Pipeline stats reset via dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Pipeline stats reset successfully' }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, 'Failed to reset pipeline stats');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: errorMessage }));
    }
  }

  /**
   * GET /api/paper-trades - List paper trades without P&L calculation
   * Now includes both active and closed trades
   */
  private getApiPaperTrades() {
    const tracker = getPaperTradeTracker();
    if (!tracker) {
      return {
        error: 'Paper trade tracker not initialized (not in dry run mode)',
        activeTrades: [],
        closedTrades: [],
        activeCount: 0,
        closedCount: 0,
        monitoringEnabled: false,
      };
    }

    const activeTrades = tracker.getActivePaperTrades();
    const closedTrades = tracker.getClosedPaperTrades();
    const summaryStats = tracker.getSummaryStats();

    return {
      activeCount: activeTrades.length,
      closedCount: closedTrades.length,
      maxTrades: 100,
      monitoringEnabled: summaryStats.monitoringEnabled,
      realizedPnlSol: summaryStats.realizedPnlSol,
      activeTrades: activeTrades.map((t) => ({
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        entrySol: t.hypotheticalSolSpent,
        tokensReceived: t.hypotheticalTokensReceived,
        entryPrice: t.entryPricePerToken,
        entryTimestamp: t.entryTimestamp,
        bondingCurve: t.bondingCurve,
        status: t.status,
      })),
      closedTrades: closedTrades.map((t) => ({
        mint: t.mint,
        name: t.name,
        symbol: t.symbol,
        entrySol: t.hypotheticalSolSpent,
        tokensReceived: t.hypotheticalTokensReceived,
        entryPrice: t.entryPricePerToken,
        entryTimestamp: t.entryTimestamp,
        bondingCurve: t.bondingCurve,
        status: t.status,
        closedTimestamp: t.closedTimestamp,
        closedReason: t.closedReason,
        exitSolReceived: t.exitSolReceived,
        realizedPnlSol: t.realizedPnlSol,
        realizedPnlPercent: t.realizedPnlPercent,
      })),
    };
  }

  /**
   * POST /api/paper-trades/check-pnl - Calculate P&L for all paper trades
   */
  private async handleCheckPaperPnL(res: http.ServerResponse): Promise<void> {
    const tracker = getPaperTradeTracker();
    if (!tracker) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Paper trade tracker not initialized (not in dry run mode)' }));
      return;
    }

    try {
      logger.info('[dashboard] Checking paper P&L...');
      const summary = await tracker.checkPnL();
      logger.info(
        {
          totalTrades: summary.totalTrades,
          activeTrades: summary.activeTrades,
          totalPnlSol: summary.totalPnlSol,
          totalPnlPercent: summary.totalPnlPercent,
        },
        '[dashboard] Paper P&L check complete'
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary, null, 2));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ error: errorMessage }, '[dashboard] Paper P&L check failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: errorMessage }));
    }
  }

  /**
   * POST /api/paper-trades/clear - Clear all paper trades
   */
  private async handleClearPaperTrades(res: http.ServerResponse): Promise<void> {
    const tracker = getPaperTradeTracker();
    if (!tracker) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Paper trade tracker not initialized (not in dry run mode)' }));
      return;
    }

    tracker.clearPaperTrades();
    logger.info('[dashboard] Paper trades cleared via dashboard');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: 'Paper trades cleared' }));
  }

  // ============================================================
  // STATIC FILE SERVING
  // ============================================================

  private async handleStaticFile(pathname: string, res: http.ServerResponse): Promise<void> {
    // Default to index.html for root
    let filePath = pathname === '/' ? '/index.html' : pathname;

    // Security: prevent directory traversal
    filePath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');

    const fullPath = path.join(this.publicDir, filePath);

    // Check if file exists
    if (!fs.existsSync(fullPath)) {
      // For SPA, return index.html for unknown routes
      const indexPath = path.join(this.publicDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        this.serveFile(indexPath, '.html', res);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
      return;
    }

    const ext = path.extname(fullPath);
    this.serveFile(fullPath, ext, res);
  }

  private serveFile(filePath: string, ext: string, res: http.ServerResponse): void {
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read file' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': mimeType });
      res.end(data);
    });
  }

  // ============================================================
  // STATUS UPDATES
  // ============================================================

  public setWebSocketConnected(connected: boolean): void {
    this.isWebSocketConnected = connected;
    if (connected) {
      this.lastWebSocketActivity = new Date();
    }
  }

  public recordWebSocketActivity(): void {
    this.lastWebSocketActivity = new Date();
  }

  public setRpcHealthy(healthy: boolean, endpoint?: string): void {
    this.isRpcHealthy = healthy;
    if (endpoint) {
      this.rpcEndpoint = endpoint;
    }
  }

  public isHealthy(): boolean {
    return this.isWebSocketConnected && this.isRpcHealthy;
  }

  // ============================================================
  // UTILITIES
  // ============================================================

  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
  }
}

// ============================================================
// SINGLETON MANAGEMENT
// ============================================================

let dashboardServerInstance: DashboardServer | null = null;

export function initDashboardServer(config: DashboardConfig): DashboardServer {
  dashboardServerInstance = new DashboardServer(config);
  return dashboardServerInstance;
}

export function getDashboardServer(): DashboardServer | null {
  return dashboardServerInstance;
}

export async function startDashboardServer(config: DashboardConfig): Promise<DashboardServer> {
  const server = initDashboardServer(config);
  await server.start();
  return server;
}
