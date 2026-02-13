/**
 * Phase 5: Dashboard Server
 *
 * Provides web dashboard for monitoring the trading bot.
 * Serves both API endpoints and static UI files.
 */

import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { logger } from '../helpers';
import { getStateStore } from '../persistence';
import { getPnlTracker, getExposureManager, getPumpFunPositionMonitor } from '../risk';
import { PoolAction, PoolType } from '../persistence/models';
import { getPipelineStats, resetPipelineStats } from '../pipeline';
import { getPaperTradeTracker } from '../risk';
import { getTradeAuditManager } from '../helpers/trade-audit';
import { getSmokeTestReport } from '../smoke-test';
import { getLogSummarizer } from '../helpers/log-summarizer';
import { ABTestStore } from '../ab-test/ab-store';
import { ABReportGenerator } from '../ab-test/ab-report';
import { ABAnalyzer } from '../ab-test/ab-analyzer';
import { version } from '../package.json';

/**
 * Infrastructure cost configuration
 * Tracks monthly costs for bot infrastructure
 */
const INFRA_COSTS = {
  startDate: '2026-01-01',
  items: [
    { name: 'Claude Code', monthlyCost: 130 },
    { name: 'Helius', monthlyCost: 50 },
    { name: 'Railway', monthlyCost: 5 },
  ],
};

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
  /** Cached RPC connection for wallet balance fallback when exposureManager is unavailable */
  private cachedConnection: Connection | null = null;
  private cachedWalletPublicKey: PublicKey | null = null;
  /** Cached AB store to avoid re-opening the database on every poll */
  private cachedAbStore: ABTestStore | null = null;
  /** Auth secret for signing session cookies - regenerated each startup */
  private readonly authSecret = crypto.randomBytes(32).toString('hex');
  /** Rate limiting: track failed login attempts by IP */
  private readonly loginAttempts = new Map<string, { count: number; lockedUntil: number | null }>();

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
        logger.info(
          { port: this.config.port, authEnabled: this.requiresAuth() },
          `Dashboard server started${this.requiresAuth() ? ' (password auth enabled)' : ' (no auth - set DASHBOARD_PASSWORD to enable)'}`,
        );
        resolve();
      });
    });
  }

  /**
   * Stop the dashboard server
   */
  public stop(): Promise<void> {
    // Close cached AB store
    if (this.cachedAbStore) {
      try { this.cachedAbStore.close(); } catch { /* ignore */ }
      this.cachedAbStore = null;
    }

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

    // Authentication check
    if (this.requiresAuth()) {
      const isHealthEndpoint = pathname === '/health' || pathname === '/healthz'
        || pathname === '/ready' || pathname === '/readyz'
        || pathname === '/live' || pathname === '/livez';
      const isLoginRoute = pathname === '/login' || pathname === '/api/auth/login';

      if (!isHealthEndpoint && !isLoginRoute && !this.isAuthenticated(req)) {
        if (pathname.startsWith('/api/')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
        } else {
          res.writeHead(302, { 'Location': '/login' });
          res.end();
        }
        return;
      }
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
        case '/api/bot-info':
          data = this.getApiBotInfo();
          break;

        case '/api/overview':
          data = await this.getApiOverview();
          break;

        case '/api/run-history':
          data = this.getApiRunHistory();
          break;

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

        case '/api/trade-audit':
          data = this.getApiTradeAudit();
          break;

        case '/api/trade-audit/alerts':
          data = this.getApiTradeAuditAlerts();
          break;

        case '/api/trade-audit/compact':
          // Return plain text report for copying into Claude
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(this.getTradeAuditCompactReport());
          return;

        case '/api/smoke-test-report':
          data = getSmokeTestReport() || { status: 'no_report', message: 'No smoke test has been run' };
          break;

        case '/api/diagnostic':
          data = this.getApiDiagnostic();
          break;

        case '/api/diagnostic/compact':
          // Return plain text diagnostic report for copying into Claude
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(this.getDiagnosticCompactReport());
          return;

        case '/api/log-summaries':
          data = this.getApiLogSummaries();
          break;

        case '/api/ab-results/analysis':
          data = this.getAbResultsAnalysis();
          break;

        case '/api/ab-results/sessions':
          data = this.getAbResultsSessions();
          break;

        default:
          // Check for /api/ab-results/session/:id pattern
          if (pathname.startsWith('/api/ab-results/session/')) {
            const sessionId = pathname.substring('/api/ab-results/session/'.length);
            data = this.getAbResultsSessionDetail(sessionId);
          }
          // Check for /api/pools/:id pattern
          else if (pathname.startsWith('/api/pools/')) {
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
   * Handle POST requests to API endpoints.
   * POST endpoints are state-mutating so we restrict to same-origin requests
   * by checking the Origin header against the Host header.
   */
  private async handlePostRequest(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Restrict POST to same-origin: reject cross-origin requests
    const origin = req.headers['origin'];
    const host = req.headers['host'];
    if (origin && host) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Cross-origin POST not allowed' }));
          return;
        }
      } catch {
        // Malformed origin header — reject
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid origin' }));
        return;
      }
    }

    try {
      // Login endpoint needs the request body; other handlers don't
      if (pathname === '/api/auth/login') {
        const body = await this.parseRequestBody(req);
        await this.handleLogin(body, req, res);
        return;
      }

      // Drain request body (other handlers don't use it)
      await this.drainRequestBody(req);

      switch (pathname) {
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
   * Drain a request body without parsing it
   */
  private drainRequestBody(req: http.IncomingMessage): Promise<void> {
    return new Promise((resolve) => {
      req.on('data', () => { /* discard */ });
      req.on('end', resolve);
      req.on('error', resolve);
    });
  }

  /**
   * Parse JSON request body (with 1 MB size limit)
   */
  private parseRequestBody(req: http.IncomingMessage): Promise<any> {
    const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > MAX_BODY_SIZE) {
          req.destroy();
          reject(new Error('Request body too large'));
        }
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

    // Fetch actual wallet balance from chain (with fallback for AB/smoke modes)
    const walletBalance = exposureManager
      ? await exposureManager.getWalletBalance()
      : await this.getWalletBalanceFallback();

    // Calculate unrealized PnL from pump.fun positions
    const totalUnrealizedPnl = pumpFunMonitorStats?.unrealizedPnl || 0;

    // Determine bot mode for status logic
    let currentBotMode = 'unknown';
    try {
      const { getConfig } = require('../helpers/config-validator');
      currentBotMode = getConfig().botMode;
    } catch { /* ignore */ }

    // In AB/smoke modes, the test runner manages its own connection
    const isConnected = this.isWebSocketConnected
      || currentBotMode === 'ab'
      || currentBotMode === 'smoke';

    return {
      status: isConnected ? 'running' : 'disconnected',
      uptime: uptimeSeconds,
      uptimeFormatted: this.formatUptime(uptimeSeconds),
      websocket: {
        connected: isConnected,
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
   * GET /api/bot-info - Basic bot info that always works regardless of state
   */
  private getApiBotInfo() {
    let botMode = 'unknown';
    let dryRun = false;
    try {
      const { getConfig } = require('../helpers/config-validator');
      const config = getConfig();
      botMode = config.botMode;
      dryRun = config.dryRun;
    } catch {
      // Config may not be loaded yet
    }

    // In AB/smoke modes, the test runner manages its own websocket connection
    // so report connected=true when those modes are active
    const wsConnected = this.isWebSocketConnected
      || botMode === 'ab'
      || botMode === 'smoke';

    return {
      version,
      botMode,
      dryRun,
      uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
      uptimeFormatted: this.formatUptime(Math.floor((Date.now() - this.startTime.getTime()) / 1000)),
      startTime: this.startTime.toISOString(),
      websocket: {
        connected: wsConnected,
        lastActivity: this.lastWebSocketActivity?.toISOString(),
      },
      rpc: {
        healthy: this.isRpcHealthy,
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /api/overview - Homepage overview data
   */
  private async getApiOverview() {
    const stateStore = getStateStore();
    const pnlTracker = getPnlTracker();
    const exposureManager = getExposureManager();
    const pumpFunMonitor = getPumpFunPositionMonitor();
    const paperTracker = getPaperTradeTracker();

    let botMode = 'unknown';
    let dryRun = false;
    try {
      const { getConfig } = require('../helpers/config-validator');
      const config = getConfig();
      botMode = config.botMode;
      dryRun = config.dryRun;
    } catch {
      // Config may not be loaded yet
    }

    // Wallet balance (with fallback for AB/smoke modes)
    const walletBalance = exposureManager
      ? await exposureManager.getWalletBalance()
      : await this.getWalletBalanceFallback();

    // Real P&L
    const pnlSummary = pnlTracker?.getSessionSummary();
    const pumpFunMonitorStats = pumpFunMonitor?.getStats();
    const unrealizedPnl = pumpFunMonitorStats?.unrealizedPnl || 0;

    // Paper P&L
    const paperSummaryStats = paperTracker?.getSummaryStats();

    // Trade stats from DB
    const dbStats = stateStore?.getStats();
    const poolStats = stateStore?.getPoolDetectionStats();

    // A/B test session count
    let abSessionCount = 0;
    const abStore = this.openAbStore();
    if (abStore) {
      try {
        abSessionCount = abStore.getAllSessions().length;
      } catch { /* no sessions */ }
    }

    // Smoke test report
    const smokeReport = getSmokeTestReport();

    // Infrastructure costs
    const infraCosts = this.calculateInfraCosts();

    // Exposure stats
    const exposureStats = exposureManager?.getStats();

    return {
      botMode,
      dryRun,
      version,
      uptime: Math.floor((Date.now() - this.startTime.getTime()) / 1000),
      uptimeFormatted: this.formatUptime(Math.floor((Date.now() - this.startTime.getTime()) / 1000)),
      status: this.isWebSocketConnected ? 'running'
        : (botMode === 'standby' ? 'standby'
          : (botMode === 'ab' || botMode === 'smoke') ? 'running'
            : 'disconnected'),
      walletBalance,
      realPnl: pnlSummary ? {
        realized: pnlSummary.realizedPnlSol,
        unrealized: unrealizedPnl,
        total: pnlSummary.realizedPnlSol + unrealizedPnl,
        totalBuys: pnlSummary.totalBuys,
        totalSells: pnlSummary.totalSells,
        winRate: pnlSummary.winRate,
      } : null,
      paperPnl: paperSummaryStats ? {
        realizedPnlSol: paperSummaryStats.realizedPnlSol,
        totalTrades: paperSummaryStats.activeTrades + paperSummaryStats.closedTrades,
        activeTrades: paperSummaryStats.activeTrades,
        closedTrades: paperSummaryStats.closedTrades,
        monitoringEnabled: paperSummaryStats.monitoringEnabled,
      } : null,
      exposure: exposureStats ? {
        currentExposure: exposureStats.totalExposure,
        maxExposure: exposureStats.maxExposure,
        tradesThisHour: exposureStats.tradesThisHour,
        maxTradesPerHour: exposureStats.maxTradesPerHour,
      } : null,
      positions: {
        open: stateStore?.getOpenPositions().length || 0,
        monitored: pumpFunMonitorStats?.positionCount || 0,
      },
      pipeline: poolStats ? {
        totalDetected: poolStats.totalDetected,
        totalBought: poolStats.totalBought,
        totalFiltered: poolStats.totalFiltered,
        buyRate: poolStats.totalDetected > 0
          ? ((poolStats.totalBought / poolStats.totalDetected) * 100)
          : 0,
      } : null,
      trainingRuns: {
        abSessions: abSessionCount,
        smokeTestCompleted: smokeReport ? true : false,
        smokeTestResult: smokeReport?.overallResult || null,
      },
      infraCosts,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /api/run-history - History of runs across modes
   */
  private getApiRunHistory() {
    const history: any[] = [];

    // A/B test sessions
    const abStore = this.openAbStore();
    if (abStore) {
      try {
        const sessions = abStore.getAllSessions();
        for (const session of sessions) {
          history.push({
            mode: 'ab',
            id: session.sessionId,
            startedAt: session.startedAt,
            status: session.status,
            tokensDetected: session.totalTokensDetected,
            summary: session.status === 'completed' ? 'Completed' : 'In progress',
          });
        }
      } catch { /* no sessions */ }
    }

    // Smoke test report (current/last)
    const smokeReport = getSmokeTestReport();
    if (smokeReport) {
      history.push({
        mode: 'smoke',
        id: `smoke-${smokeReport.startedAt}`,
        startedAt: smokeReport.startedAt,
        completedAt: smokeReport.completedAt,
        status: smokeReport.overallResult === 'PASS' ? 'completed' : 'failed',
        summary: `${smokeReport.overallResult} (${smokeReport.passedCount}/${smokeReport.totalSteps} steps)`,
      });
    }

    // Sort by start time descending
    history.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    return { runs: history };
  }

  /**
   * Calculate infrastructure costs from start date to now
   */
  private calculateInfraCosts() {
    const startDate = new Date(INFRA_COSTS.startDate);
    const now = new Date();
    const msPerDay = 86400000;
    const totalDays = Math.max(0, (now.getTime() - startDate.getTime()) / msPerDay);
    const totalMonths = totalDays / 30.44; // Average days per month

    const monthlyTotal = INFRA_COSTS.items.reduce((sum, item) => sum + item.monthlyCost, 0);
    const totalSpent = monthlyTotal * totalMonths;

    return {
      monthlyTotal,
      totalSpent: Math.round(totalSpent * 100) / 100,
      startDate: INFRA_COSTS.startDate,
      daysSinceStart: Math.floor(totalDays),
      breakdown: INFRA_COSTS.items.map(item => ({
        name: item.name,
        monthlyCost: item.monthlyCost,
        totalSpent: Math.round((item.monthlyCost * totalMonths) * 100) / 100,
      })),
    };
  }

  /**
   * Fallback wallet balance fetcher for modes where exposureManager is not initialized
   * (e.g., AB test, smoke test). Creates a cached RPC connection using config values.
   */
  private async getWalletBalanceFallback(): Promise<number | null> {
    try {
      if (!this.cachedConnection || !this.cachedWalletPublicKey) {
        const { getConfig } = require('../helpers/config-validator');
        const config = getConfig();
        const { getWallet } = require('../helpers/wallet');

        this.cachedConnection = new Connection(config.rpcEndpoint, {
          wsEndpoint: config.rpcWebsocketEndpoint,
          commitment: config.commitmentLevel,
        });
        const wallet = getWallet(config.privateKey.trim());
        this.cachedWalletPublicKey = wallet.publicKey;
      }

      const conn = this.cachedConnection;
      const pubkey = this.cachedWalletPublicKey;
      if (!conn || !pubkey) return null;
      const balance = await conn.getBalance(pubkey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error({ error }, 'Failed to get wallet balance via fallback');
      return null;
    }
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
        botMode: config.botMode,
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
      risk: {
        maxTotalExposureSol: config.maxTotalExposureSol,
        maxTradesPerHour: config.maxTradesPerHour,
        minWalletBufferSol: config.minWalletBufferSol,
        maxHoldDurationSeconds: config.maxHoldDurationMs / 1000,
      },
      execution: {
        executor: config.transactionExecutor,
        simulateTransaction: config.simulateTransaction,
        useDynamicFee: config.useDynamicFee,
        useFallbackExecutor: config.useFallbackExecutor,
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
  // TRADE AUDIT ENDPOINTS
  // ============================================================

  /**
   * GET /api/trade-audit - Full trade audit data
   */
  private getApiTradeAudit() {
    const auditManager = getTradeAuditManager();
    if (!auditManager) {
      return {
        error: 'Trade audit manager not initialized',
        summary: { totalAudited: 0, mismatches: 0 },
        recentAudits: [],
        alerts: [],
      };
    }

    return {
      summary: auditManager.getSummary(),
      recentAudits: auditManager.getRecent(50),
      alerts: auditManager.getAlerts(),
    };
  }

  /**
   * GET /api/trade-audit/alerts - Only mismatch records
   */
  private getApiTradeAuditAlerts() {
    const auditManager = getTradeAuditManager();
    if (!auditManager) {
      return { alerts: [], count: 0 };
    }

    const alerts = auditManager.getAlerts();
    return { alerts, count: alerts.length };
  }

  /**
   * GET /api/trade-audit/compact - Plain text report for Claude
   */
  private getTradeAuditCompactReport(): string {
    const auditManager = getTradeAuditManager();
    if (!auditManager) {
      return 'Trade audit manager not initialized. No audit data available.';
    }

    return auditManager.getCompactReport();
  }

  // ============================================================
  // DIAGNOSTIC ENDPOINTS
  // ============================================================

  /**
   * GET /api/diagnostic - Full diagnostic data (pipeline + audit + summaries)
   */
  private getApiDiagnostic() {
    const auditManager = getTradeAuditManager();
    const pipelineStats = getPipelineStats();
    const summarizer = getLogSummarizer();

    const pipelineSnap = pipelineStats ? pipelineStats.getSnapshot() : null;

    return {
      pipeline: pipelineSnap ? {
        detected: pipelineSnap.tokensDetected,
        bought: pipelineSnap.tokensBought,
        rejected: pipelineSnap.tokensRejected,
        buyRate: pipelineSnap.buyRate.toFixed(1) + '%',
        avgDurationMs: pipelineSnap.avgPipelineDurationMs.toFixed(0),
        topRejections: pipelineSnap.topRejectionReasons.slice(0, 5),
      } : null,
      tradeAudit: auditManager ? {
        summary: auditManager.getSummary(),
        recentAudits: auditManager.getRecent(20),
        alerts: auditManager.getAlerts(),
      } : null,
      logSummaries: summarizer ? {
        current: this.serializeBucket(summarizer.getCurrentBucket()),
        recent: summarizer.getSummaries(6).map(b => this.serializeBucket(b)),
      } : null,
    };
  }

  /**
   * GET /api/diagnostic/compact - Plain text report combining all diagnostics
   */
  private getDiagnosticCompactReport(): string {
    const lines: string[] = [];

    // Log summaries section
    const summarizer = getLogSummarizer();
    if (summarizer) {
      lines.push(summarizer.getCompactReport());
      lines.push('');
    }

    // Trade audit section
    const auditManager = getTradeAuditManager();
    if (auditManager && auditManager.getCount() > 0) {
      lines.push(auditManager.getCompactReport());
      lines.push('');
    }

    // Pipeline section
    const pipelineStats = getPipelineStats();
    if (pipelineStats) {
      const snap = pipelineStats.getSnapshot();
      lines.push('=== Pipeline ===');
      lines.push(`Detected: ${snap.tokensDetected} | Bought: ${snap.tokensBought} | Rate: ${snap.buyRate.toFixed(1)}% | Avg: ${snap.avgPipelineDurationMs.toFixed(0)}ms`);
      if (snap.topRejectionReasons.length > 0) {
        const total = snap.tokensRejected;
        const reasons = snap.topRejectionReasons.slice(0, 5).map(r => {
          const pct = total > 0 ? ((r.count / total) * 100).toFixed(0) : '0';
          return `${r.reason}(${pct}%)`;
        });
        lines.push(`Rejections: ${reasons.join(', ')}`);
      }
    }

    if (lines.length === 0) {
      return 'No diagnostic data available yet. The bot needs to be running for data to accumulate.';
    }

    return lines.join('\n');
  }

  /**
   * GET /api/log-summaries - Log summary data
   */
  private getApiLogSummaries() {
    const summarizer = getLogSummarizer();
    if (!summarizer) {
      return { compact: 'Log summarizer not initialized', buckets: [] };
    }

    return {
      compact: summarizer.getCompactReport(),
      current: this.serializeBucket(summarizer.getCurrentBucket()),
      recent: summarizer.getSummaries(12).map(b => this.serializeBucket(b)),
    };
  }

  /**
   * Serialize a log summary bucket (Maps aren't JSON-serializable)
   */
  private serializeBucket(bucket: any) {
    return {
      ...bucket,
      rejectionCounts: bucket.rejectionCounts instanceof Map
        ? Object.fromEntries(bucket.rejectionCounts)
        : bucket.rejectionCounts,
    };
  }

  // ============================================================
  // A/B TEST RESULTS ENDPOINTS
  // ============================================================

  /**
   * Get a cached ABTestStore connection.
   * Reuses the same instance to avoid re-opening the database on every poll.
   * Returns null if no AB test database exists yet.
   */
  private openAbStore(): ABTestStore | null {
    if (this.cachedAbStore) return this.cachedAbStore;

    try {
      const { getConfig } = require('../helpers/config-validator');
      const config = getConfig();
      const dbPath = path.join(config.dataDir, 'ab-test.db');
      if (!fs.existsSync(dbPath)) return null;
      this.cachedAbStore = new ABTestStore(config.dataDir);
      return this.cachedAbStore;
    } catch {
      return null;
    }
  }

  /**
   * GET /api/ab-results/analysis - Cross-session analysis
   */
  private getAbResultsAnalysis() {
    const store = this.openAbStore();
    if (!store) {
      return { error: 'No A/B test data found', totalSessions: 0 };
    }

    const analyzer = new ABAnalyzer(store);
    return analyzer.analyze();
  }

  /**
   * GET /api/ab-results/sessions - List all sessions
   */
  private getAbResultsSessions() {
    const store = this.openAbStore();
    if (!store) {
      return { sessions: [] };
    }

    return { sessions: store.getAllSessions() };
  }

  /**
   * GET /api/ab-results/session/:id - Full session report
   */
  private getAbResultsSessionDetail(sessionId: string) {
    const store = this.openAbStore();
    if (!store) {
      return { error: 'No A/B test data found' };
    }

    try {
      const reportGen = new ABReportGenerator(store);
      return reportGen.generate(sessionId);
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Session not found' };
    }
  }

  // ============================================================
  // STATIC FILE SERVING
  // ============================================================

  private async handleStaticFile(pathname: string, res: http.ServerResponse): Promise<void> {
    // Default to index.html for root, and handle known page routes
    const pageRoutes: Record<string, string> = {
      '/': '/index.html',
      '/login': '/login.html',
      '/dry-run': '/dry-run.html',
      '/production': '/production.html',
      '/smoke-test': '/smoke-test.html',
      '/ab-test': '/ab-results.html',
      '/ab-results': '/ab-results.html',
    };
    let filePath = pageRoutes[pathname] || pathname;

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
  // AUTHENTICATION
  // ============================================================

  private requiresAuth(): boolean {
    return !!process.env.DASHBOARD_PASSWORD;
  }

  private isAuthenticated(req: http.IncomingMessage): boolean {
    const cookies = this.parseCookies(req);
    const token = cookies['dashboard_session'];
    if (!token) return false;
    return this.validateSessionToken(token);
  }

  private createSessionToken(): string {
    const timestamp = Date.now().toString();
    const hmac = crypto.createHmac('sha256', this.authSecret).update(timestamp).digest('hex');
    return `${timestamp}.${hmac}`;
  }

  private validateSessionToken(token: string): boolean {
    const dotIndex = token.indexOf('.');
    if (dotIndex === -1) return false;

    const timestamp = token.substring(0, dotIndex);
    const hmac = token.substring(dotIndex + 1);

    // Check expiry (7 days)
    const age = Date.now() - parseInt(timestamp, 10);
    if (isNaN(age) || age < 0 || age > 7 * 24 * 60 * 60 * 1000) return false;

    // Verify HMAC with timing-safe comparison
    const expectedHmac = crypto.createHmac('sha256', this.authSecret).update(timestamp).digest('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac));
    } catch {
      return false;
    }
  }

  private async handleLogin(
    body: any,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const dashboardPassword = process.env.DASHBOARD_PASSWORD;
    if (!dashboardPassword) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Authentication not configured' }));
      return;
    }

    const clientIp = this.getClientIp(req);

    // Check rate limit
    const attempt = this.loginAttempts.get(clientIp);
    if (attempt?.lockedUntil && Date.now() < attempt.lockedUntil) {
      const remainingHours = Math.ceil((attempt.lockedUntil - Date.now()) / (1000 * 60 * 60));
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: `Too many failed attempts. Locked out for ${remainingHours} hour(s).`,
        attemptsLeft: 0,
      }));
      return;
    }

    // Reset expired lockouts
    if (attempt?.lockedUntil && Date.now() >= attempt.lockedUntil) {
      this.loginAttempts.delete(clientIp);
    }

    const { password } = body;

    // Constant-time password comparison via hashing (fixed-length buffers)
    const hashStr = (s: string) => crypto.createHash('sha256').update(s).digest();
    const isCorrect = typeof password === 'string'
      && crypto.timingSafeEqual(hashStr(password), hashStr(dashboardPassword));

    if (!isCorrect) {
      const record = this.loginAttempts.get(clientIp) || { count: 0, lockedUntil: null };
      record.count++;
      if (record.count >= 10) {
        record.lockedUntil = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
      }
      this.loginAttempts.set(clientIp, record);

      const attemptsLeft = record.lockedUntil ? 0 : 10 - record.count;
      logger.warn({ ip: clientIp, attemptsLeft }, 'Failed dashboard login attempt');

      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: record.lockedUntil ? 'Too many failed attempts. Locked out for 24 hours.' : 'Invalid password',
        attemptsLeft,
      }));
      return;
    }

    // Success - reset attempts and set session cookie
    this.loginAttempts.delete(clientIp);
    logger.info({ ip: clientIp }, 'Successful dashboard login');

    const token = this.createSessionToken();
    const isSecure = req.headers['x-forwarded-proto'] === 'https';
    const cookie = `dashboard_session=${token}; HttpOnly; ${isSecure ? 'Secure; ' : ''}SameSite=Strict; Path=/; Max-Age=604800`;

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': cookie,
    });
    res.end(JSON.stringify({ success: true }));
  }

  private parseCookies(req: http.IncomingMessage): Record<string, string> {
    const cookies: Record<string, string> = {};
    const header = req.headers.cookie;
    if (!header) return cookies;

    header.split(';').forEach(cookie => {
      const eqIndex = cookie.indexOf('=');
      if (eqIndex > 0) {
        const name = cookie.substring(0, eqIndex).trim();
        const value = cookie.substring(eqIndex + 1).trim();
        cookies[name] = value;
      }
    });

    return cookies;
  }

  private getClientIp(req: http.IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      return ip.trim();
    }
    return req.socket.remoteAddress || 'unknown';
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
