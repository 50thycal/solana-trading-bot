/**
 * Bootstrap script for Railway deployment
 *
 * This script starts a minimal health server FIRST before loading the main application.
 * This ensures that Railway's health checks can succeed even during initialization.
 *
 * Without this, config validation failures cause the process to exit before
 * the health server can start, causing Railway deployments to fail with no error visible.
 */

import http from 'http';

// Configuration (read directly from env to avoid triggering config validation)
const HEALTH_PORT = parseInt(process.env.DASHBOARD_PORT || process.env.HEALTH_PORT || '8080', 10);

// Startup state
let startupState: 'initializing' | 'loading' | 'ready' | 'failed' = 'initializing';
let startupError: string | null = null;
let mainAppStartTime: Date | null = null;

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

      // Return 200 for ready state, 503 for failed, 200 for initializing (Railway needs this)
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
      // For any other path, proxy to main app or return 404 if not ready
      if (startupState !== 'ready') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service starting', state: startupState }));
      } else {
        // The main app will handle other routes
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    }
  });
}

/**
 * Main bootstrap function
 */
async function bootstrap(): Promise<void> {
  mainAppStartTime = new Date();
  log('info', 'Bootstrap starting...', { port: HEALTH_PORT });

  // Step 1: Start minimal health server FIRST
  const healthServer = createHealthServer();

  await new Promise<void>((resolve, reject) => {
    healthServer.on('error', (error) => {
      log('error', 'Health server failed to start', { error: String(error) });
      reject(error);
    });

    healthServer.listen(HEALTH_PORT, () => {
      log('info', 'Minimal health server started', { port: HEALTH_PORT });
      resolve();
    });
  });

  // Step 2: Load the main application (this may fail if config is invalid)
  startupState = 'loading';
  log('info', 'Loading main application...');

  try {
    // Close the minimal health server - the main app will take over
    await new Promise<void>((resolve) => {
      healthServer.close(() => {
        log('info', 'Minimal health server closed, handing off to main app');
        resolve();
      });
    });

    // Dynamic import to avoid triggering config validation until now
    const mainModule = await import('./index');

    // If we get here, the main app loaded successfully
    // The main app handles its own health server via the dashboard
    startupState = 'ready';
    log('info', 'Main application loaded successfully');
  } catch (error) {
    startupState = 'failed';
    startupError = error instanceof Error ? error.message : String(error);
    log('error', 'Failed to load main application', { error: startupError });

    // Re-start the minimal health server to report the error
    const errorHealthServer = createHealthServer();
    errorHealthServer.listen(HEALTH_PORT, () => {
      log('info', 'Error health server started - reporting failure state', { port: HEALTH_PORT });
    });

    // Don't exit - keep the health server running so Railway can see the error
    // The health check will return 503 and Railway will eventually give up
  }
}

// Run bootstrap
bootstrap().catch((error) => {
  log('error', 'Bootstrap fatal error', { error: String(error) });
  process.exit(1);
});
