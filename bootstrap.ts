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

      // Return 200 for all states except failed - Railway needs 200 during startup
      const httpStatus = startupState === 'failed' ? 503 : 200;
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
      // Service not ready yet
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Service starting',
        state: startupState,
        message: 'Please wait while the service initializes',
      }));
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

  // Step 2: Load the main application
  startupState = 'loading';
  log('info', 'Loading main application...');

  try {
    // Dynamic import to avoid triggering config validation until now
    await import('./index');

    // If we get here, the main app loaded successfully
    startupState = 'ready';
    log('info', 'Main application loaded successfully', {
      publicPort: PUBLIC_PORT,
      dashboardPort: DASHBOARD_PORT,
    });
  } catch (error) {
    startupState = 'failed';
    startupError = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to load main application', { error: startupError });

    // Keep the server running so Railway can see the error
    log('info', 'Server still running - reporting failure state');
  }
}

// Run bootstrap
bootstrap().catch((error) => {
  log('error', 'Bootstrap fatal error', { error: String(error) });
  process.exit(1);
});
