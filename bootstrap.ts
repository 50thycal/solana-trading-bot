/**
 * Bootstrap script for Railway deployment
 *
 * This script starts a minimal health server FIRST before loading the main application.
 * This ensures that Railway's health checks can succeed even during initialization.
 *
 * The health server:
 * 1. Handles health checks directly (/health, /healthz, /live, /livez, /ready, /readyz)
 * 2. Proxies all other requests to the dashboard server running on DASHBOARD_PORT
 */

import http from 'http';

// Railway typically sets PORT env var - this is the public-facing port
const PUBLIC_PORT = parseInt(process.env.PORT || '8080', 10);

// Dashboard runs on an internal port (different from public port to avoid conflicts)
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3000', 10);

// Startup state
let startupState: 'initializing' | 'loading' | 'ready' | 'failed' = 'initializing';
let startupError: string | null = null;
let mainAppStartTime: Date | null = null;
let healthServer: http.Server | null = null;

/**
 * Simple logger that works without dependencies
 */
function log(level: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const logData = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] ${level.toUpperCase()}: ${message}${logData}`);
}

/**
 * Proxy a request to the dashboard server
 */
function proxyToDashboard(req: http.IncomingMessage, res: http.ServerResponse): void {
  const options = {
    hostname: '127.0.0.1',
    port: DASHBOARD_PORT,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log('error', 'Proxy error', { error: String(err), url: req.url });
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Dashboard unavailable',
      state: startupState,
      message: startupState === 'ready' ? 'Dashboard connection failed' : 'Service is still starting',
    }));
  });

  // Forward request body if present
  req.pipe(proxyReq);
}

/**
 * Create the main server that handles health checks and proxies to dashboard
 */
function createServer(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url || '/';

    // Health check endpoints - handle directly
    if (url === '/health' || url === '/healthz') {
      const uptime = mainAppStartTime
        ? Math.floor((Date.now() - mainAppStartTime.getTime()) / 1000)
        : 0;

      const response = {
        status: startupState === 'ready' ? 'healthy' : startupState === 'failed' ? 'unhealthy' : 'starting',
        state: startupState,
        error: startupError,
        timestamp: new Date().toISOString(),
        uptime,
      };

      // Always return 200 - the bootstrap server IS alive and responding.
      // Returning 503 on failure causes Railway to reject deployments entirely,
      // hiding the actual error. The response body contains the real state.
      // Use /ready for strict readiness checks instead.
      const httpStatus = 200;
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response, null, 2));
      return;
    }

    if (url === '/live' || url === '/livez') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive: true }));
      return;
    }

    if (url === '/ready' || url === '/readyz') {
      const isReady = startupState === 'ready';
      res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: isReady, state: startupState }));
      return;
    }

    // For all other requests, proxy to dashboard
    if (startupState !== 'ready') {
      // Serve an HTML page that auto-refreshes while the service starts up.
      // A raw 503 JSON response causes Railway to show "Application failed to respond".
      const statusLabel = startupState === 'failed'
        ? `Failed: ${startupError || 'unknown error'}`
        : 'Starting up...';
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Bot Dashboard</title>
<meta http-equiv="refresh" content="5"><style>
body{font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#e0e0e0}
.box{text-align:center;padding:2rem;border:1px solid #333;border-radius:8px;max-width:400px}
h2{margin-top:0}p{color:#999}
</style></head><body><div class="box"><h2>${statusLabel}</h2>
<p>State: ${startupState}</p><p>This page will auto-refresh every 5 seconds.</p></div></body></html>`);
      return;
    }

    // Proxy to dashboard
    proxyToDashboard(req, res);
  });
}

/**
 * Graceful shutdown handler
 */
function setupGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    log('info', `Received ${signal}, shutting down...`);
    if (healthServer) {
      healthServer.close(() => {
        log('info', 'Server closed');
        process.exit(0);
      });
    } else {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Start the dashboard server so the proxy has something to forward to.
 * Used in smoke/ab test modes where runListener() is not called.
 */
async function startDashboard(): Promise<void> {
  const dashboardEnabled = (process.env.DASHBOARD_ENABLED || 'true').toLowerCase() === 'true';
  if (!dashboardEnabled) {
    log('info', 'Dashboard disabled via DASHBOARD_ENABLED=false');
    return;
  }

  try {
    const { startDashboardServer } = await import('./dashboard/server');
    const pollInterval = parseInt(process.env.DASHBOARD_POLL_INTERVAL || '5000', 10);
    await startDashboardServer({ port: DASHBOARD_PORT, pollInterval });
    log('info', 'Dashboard server started', { port: DASHBOARD_PORT });
  } catch (error) {
    log('error', 'Failed to start dashboard server', { error: String(error) });
  }
}

/**
 * Main bootstrap function
 */
async function bootstrap(): Promise<void> {
  mainAppStartTime = new Date();
  log('info', 'Bootstrap starting...', { publicPort: PUBLIC_PORT, dashboardPort: DASHBOARD_PORT });

  // Set up graceful shutdown
  setupGracefulShutdown();

  // Step 1: Start the main server (handles health + proxy)
  healthServer = createServer();

  await new Promise<void>((resolve, reject) => {
    healthServer!.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        log('warn', `Port ${PUBLIC_PORT} already in use`, { port: PUBLIC_PORT });
        reject(error);
      } else {
        log('error', 'Server failed to start', { error: String(error) });
        reject(error);
      }
    });

    healthServer!.listen(PUBLIC_PORT, () => {
      log('info', 'Bootstrap server started (health checks + dashboard proxy)', { port: PUBLIC_PORT });
      resolve();
    });
  });

  // Step 2: Check bot mode and load appropriate application
  const botMode = (process.env.BOT_MODE || 'production').toLowerCase();

  if (botMode === 'smoke') {
    startupState = 'loading';
    log('info', 'Smoke test mode detected - running smoke test...');

    // Start dashboard so users can view results via the UI
    await startDashboard();

    try {
      const { runSmokeTest } = await import('./smoke-test');
      const report = await runSmokeTest();

      startupState = 'ready';
      log('info', `Smoke test complete: ${report.overallResult}`, {
        passed: report.passedCount,
        failed: report.failedCount,
        total: report.totalSteps,
        durationMs: report.totalDurationMs,
      });

      // Keep the server running so the dashboard stays accessible for viewing results
      log('info', 'Smoke test finished - dashboard remains available for viewing results');
    } catch (error) {
      startupState = 'failed';
      startupError = error instanceof Error ? error.message : String(error);
      log('error', 'Smoke test failed with error', { error: startupError });

      // Keep the server running so Railway can see the error via health checks
      log('info', 'Server still running - reporting failure state');
    }
  } else if (botMode === 'ab') {
    startupState = 'loading';
    log('info', 'A/B test mode detected - running A/B paper trade test...');

    // Start dashboard so users can view A/B test results via the UI
    await startDashboard();

    try {
      const { runABTest } = await import('./ab-test');
      const report = await runABTest();

      startupState = 'ready';
      log('info', `A/B test complete: Winner=${report.winner}`, {
        variantA_pnl: report.variantA.realizedPnlSol,
        variantB_pnl: report.variantB.realizedPnlSol,
        tokensDetected: report.totalTokensDetected,
        durationMs: report.durationMs,
      });

      // Keep the server running so the dashboard stays accessible for reviewing results
      log('info', 'A/B test finished - dashboard remains available for viewing results');
    } catch (error) {
      startupState = 'failed';
      startupError = error instanceof Error ? error.message : String(error);
      log('error', 'A/B test failed with error', { error: startupError });

      // Keep the server running so Railway can see the error via health checks
      log('info', 'Server still running - reporting failure state');
    }
  } else {
    // Normal startup
    startupState = 'loading';
    log('info', 'Loading main application...');

    try {
      // Signal that bootstrap is managing the lifecycle so index.ts
      // does NOT auto-invoke runListener() or call process.exit()
      process.env.__MANAGED_BY_BOOTSTRAP = '1';

      // Dynamic import to avoid triggering config validation until now
      const mainModule = await import('./index');

      // Call and await runListener - this starts the dashboard, bot, and
      // all subsystems. Only after this completes is the app truly ready
      // to proxy requests to the dashboard on DASHBOARD_PORT.
      await mainModule.runListener();

      startupState = 'ready';
      log('info', 'Main application loaded successfully', {
        publicPort: PUBLIC_PORT,
        dashboardPort: DASHBOARD_PORT,
      });
    } catch (error) {
      startupState = 'failed';
      startupError = error instanceof Error ? error.message : String(error);
      log('error', 'Failed to load main application', { error: startupError });

      // Keep the server running so Railway can see the error via health checks
      log('info', 'Server still running - reporting failure state');
    }
  }
}

// Run bootstrap
bootstrap().catch((error) => {
  log('error', 'Bootstrap fatal error', { error: String(error) });
  process.exit(1);
});
