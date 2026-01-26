/**
 * Bootstrap script for Railway deployment
 *
 * This script starts a minimal health server FIRST before loading the main application.
 * This ensures that Railway's health checks can succeed even during initialization.
 *
 * The health server stays running throughout the app lifecycle to handle health checks
 * on the PORT that Railway expects, while the main app's dashboard runs on DASHBOARD_PORT.
 */

import http from 'http';

// Railway typically sets PORT env var - use that for health checks
// Fall back to DASHBOARD_PORT or HEALTH_PORT for compatibility
const HEALTH_PORT = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || process.env.HEALTH_PORT || '8080', 10);

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
 * Create a minimal health server that responds to health checks
 */
function createHealthServer(): http.Server {
  return http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/health' || url === '/healthz') {
      // Health check endpoint
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
    } else if (url === '/live' || url === '/livez') {
      // Liveness probe - always return 200 if the process is running
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ alive: true }));
    } else if (url === '/ready' || url === '/readyz') {
      // Readiness probe - only ready when main app is fully loaded
      const isReady = startupState === 'ready';
      res.writeHead(isReady ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: isReady, state: startupState }));
    } else {
      // For any other path, return service status
      if (startupState !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service starting', state: startupState }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found - use dashboard port for full API' }));
      }
    }
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
        log('info', 'Health server closed');
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
  log('info', 'Bootstrap starting...', { port: HEALTH_PORT });

  // Set up graceful shutdown
  setupGracefulShutdown();

  // Step 1: Start minimal health server FIRST and keep it running
  healthServer = createHealthServer();

  await new Promise<void>((resolve, reject) => {
    healthServer!.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        log('warn', `Port ${HEALTH_PORT} already in use, health server skipped`, { port: HEALTH_PORT });
        resolve(); // Continue anyway - maybe main app already has health server
      } else {
        log('error', 'Health server failed to start', { error: String(error) });
        reject(error);
      }
    });

    healthServer!.listen(HEALTH_PORT, () => {
      log('info', 'Health server started and will stay running', { port: HEALTH_PORT });
      resolve();
    });
  });

  // Step 2: Load the main application (this may fail if config is invalid)
  startupState = 'loading';
  log('info', 'Loading main application...');

  try {
    // Dynamic import to avoid triggering config validation until now
    // The health server stays running during this entire process
    await import('./index');

    // If we get here, the main app loaded successfully
    startupState = 'ready';
    log('info', 'Main application loaded successfully - health server continuing on port ' + HEALTH_PORT);
  } catch (error) {
    startupState = 'failed';
    startupError = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to load main application', { error: startupError });

    // Health server is still running and will report the error
    log('info', 'Health server still running - reporting failure state');

    // Don't exit - keep the health server running so Railway can see the error
    // The health check will return 503 and Railway will eventually give up
  }
}

// Run bootstrap
bootstrap().catch((error) => {
  log('error', 'Bootstrap fatal error', { error: String(error) });
  process.exit(1);
});
