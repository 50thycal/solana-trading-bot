import { Commitment, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { logger } from './logger';

dotenv.config();

/**
 * Validated and typed configuration object
 */
export interface ValidatedConfig {
  // Core
  privateKey: string;
  rpcEndpoint: string;
  rpcWebsocketEndpoint: string;
  rpcBackupEndpoints: string[];
  commitmentLevel: Commitment;

  // Mode
  dryRun: boolean;
  logLevel: string;
  logFormat: 'pretty' | 'compact';

  // Trading
  quoteMint: string;
  quoteAmount: string;
  buySlippage: number;
  sellSlippage: number;
  autoBuyDelay: number;
  autoSell: boolean;
  autoSellDelay: number;
  oneTokenAtATime: boolean;
  takeProfit: number;
  stopLoss: number;
  priceCheckInterval: number;
  priceCheckDuration: number;

  // Transaction
  transactionExecutor: 'default' | 'warp' | 'jito';
  computeUnitLimit: number;
  computeUnitPrice: number;
  customFee: string;
  maxBuyRetries: number;
  maxSellRetries: number;

  // Risk Controls
  maxTotalExposureSol: number;
  maxTradesPerHour: number;
  minWalletBufferSol: number;
  maxHoldDurationMs: number;

  // Execution Quality
  simulateTransaction: boolean;
  useDynamicFee: boolean;
  priorityFeePercentile: number;
  minPriorityFee: number;
  maxPriorityFee: number;
  useFallbackExecutor: boolean;
  jitoBundleTimeout: number;
  jitoBundlePollInterval: number;

  // Operational
  healthPort: number;
  dataDir: string;

  // Dashboard
  dashboardEnabled: boolean;
  dashboardPort: number;
  dashboardPollInterval: number;

  // Token Age
  maxTokenAgeSeconds: number;

  // pump.fun Filters
  pumpfunMinSolInCurve: number;
  pumpfunMaxSolInCurve: number;
  pumpfunEnableMinSolFilter: boolean;
  pumpfunEnableMaxSolFilter: boolean;
  pumpfunMinScoreRequired: number;

  // Momentum Gate
  momentumGateEnabled: boolean;
  momentumInitialDelayMs: number;
  momentumMinTotalBuys: number;
  momentumRecheckIntervalMs: number;
  momentumMaxChecks: number;

  // Test Mode
  testMode: '' | 'smoke' | 'ab';
  smokeTestTimeoutMs: number;

  // A/B Test
  abTestDurationMs: number;
  abConfigA: string;
  abConfigB: string;

  // Bot Control
  runBot: boolean;

  // Production Time Limit
  productionTimeLimitMs: number;
}

interface ValidationError {
  variable: string;
  message: string;
}

const VALID_COMMITMENTS: Commitment[] = ['processed', 'confirmed', 'finalized'];
const VALID_EXECUTORS = ['default', 'warp', 'jito'] as const;
const KNOWN_QUOTE_MINTS: Record<string, string> = {
  'WSOL': 'So11111111111111111111111111111111111111112',
  'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

/**
 * Validates all environment variables and returns a typed config object.
 * Fails fast with actionable error messages if validation fails.
 */
export function validateConfig(): ValidatedConfig {
  const errors: ValidationError[] = [];

  // Helper functions
  const getEnv = (name: string, defaultValue?: string): string => {
    const value = process.env[name];
    if (value === undefined || value === '') {
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      return '';
    }
    return value;
  };

  const requireEnv = (name: string): string => {
    const value = getEnv(name);
    if (!value) {
      errors.push({ variable: name, message: `${name} is required but not set` });
      return '';
    }
    return value;
  };

  const requireNumber = (name: string, defaultValue?: number): number => {
    const value = getEnv(name);
    if (!value && defaultValue !== undefined) {
      return defaultValue;
    }
    if (!value) {
      errors.push({ variable: name, message: `${name} is required but not set` });
      return 0;
    }
    const num = Number(value);
    if (isNaN(num)) {
      errors.push({ variable: name, message: `${name} must be a number, got: "${value}"` });
      return 0;
    }
    return num;
  };

  const requireBoolean = (name: string, defaultValue?: boolean): boolean => {
    const value = getEnv(name);
    if (!value && defaultValue !== undefined) {
      return defaultValue;
    }
    if (!value) {
      errors.push({ variable: name, message: `${name} is required but not set` });
      return false;
    }
    if (value !== 'true' && value !== 'false') {
      errors.push({ variable: name, message: `${name} must be 'true' or 'false', got: "${value}"` });
      return false;
    }
    return value === 'true';
  };

  // Parse RPC backup endpoints (comma-separated)
  const parseBackupEndpoints = (value: string): string[] => {
    if (!value) return [];
    return value.split(',').map(e => e.trim()).filter(e => e.length > 0);
  };

  // Validate quote mint (accepts WSOL, USDC aliases or mint addresses)
  // Returns the normalized alias (WSOL/USDC) for compatibility with getToken()
  const validateQuoteMint = (value: string): string => {
    const upperValue = value.toUpperCase();

    // If it's a known alias, return the uppercase alias (not the address)
    if (KNOWN_QUOTE_MINTS[upperValue]) {
      return upperValue;
    }

    // Check if it's the actual mint address for a known token
    const mintAddressToAlias: Record<string, string> = {
      'So11111111111111111111111111111111111111112': 'WSOL',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
    };

    if (mintAddressToAlias[value]) {
      return mintAddressToAlias[value];
    }

    // Not a known token - error
    errors.push({
      variable: 'QUOTE_MINT',
      message: `Invalid QUOTE_MINT: "${value}". Supported values are WSOL or USDC`
    });
    return value;
  };

  // === CORE CONFIGURATION ===
  const privateKey = requireEnv('PRIVATE_KEY');
  const rpcEndpoint = requireEnv('RPC_ENDPOINT');
  const rpcWebsocketEndpoint = requireEnv('RPC_WEBSOCKET_ENDPOINT');
  const rpcBackupEndpoints = parseBackupEndpoints(getEnv('RPC_BACKUP_ENDPOINTS', ''));

  const commitmentLevel = getEnv('COMMITMENT_LEVEL', 'confirmed') as Commitment;
  if (!VALID_COMMITMENTS.includes(commitmentLevel)) {
    errors.push({
      variable: 'COMMITMENT_LEVEL',
      message: `Invalid COMMITMENT_LEVEL: "${commitmentLevel}". Must be one of: ${VALID_COMMITMENTS.join(', ')}`
    });
  }

  // === MODE ===
  const dryRun = requireBoolean('DRY_RUN', false);
  const logLevel = getEnv('LOG_LEVEL', 'info');
  const logFormatRaw = getEnv('LOG_FORMAT', 'pretty').toLowerCase();
  const logFormat = (logFormatRaw === 'compact' ? 'compact' : 'pretty') as 'pretty' | 'compact';

  // === TRADING PARAMETERS ===
  const quoteMintRaw = getEnv('QUOTE_MINT', 'WSOL');
  const quoteMint = validateQuoteMint(quoteMintRaw);
  const quoteAmount = getEnv('QUOTE_AMOUNT', '0.01');

  // Validate quote amount is a positive number
  const quoteAmountNum = Number(quoteAmount);
  if (isNaN(quoteAmountNum) || quoteAmountNum <= 0) {
    errors.push({ variable: 'QUOTE_AMOUNT', message: `QUOTE_AMOUNT must be a positive number, got: "${quoteAmount}"` });
  }

  const buySlippage = requireNumber('BUY_SLIPPAGE', 20);
  if (buySlippage < 0 || buySlippage > 100) {
    errors.push({ variable: 'BUY_SLIPPAGE', message: `BUY_SLIPPAGE must be between 0 and 100, got: ${buySlippage}` });
  }

  const sellSlippage = requireNumber('SELL_SLIPPAGE', 30);
  if (sellSlippage < 0 || sellSlippage > 100) {
    errors.push({ variable: 'SELL_SLIPPAGE', message: `SELL_SLIPPAGE must be between 0 and 100, got: ${sellSlippage}` });
  }

  const autoBuyDelay = requireNumber('AUTO_BUY_DELAY', 0);
  const autoSell = requireBoolean('AUTO_SELL', true);
  const autoSellDelay = requireNumber('AUTO_SELL_DELAY', 0);
  const oneTokenAtATime = requireBoolean('ONE_TOKEN_AT_A_TIME', true);
  const takeProfit = requireNumber('TAKE_PROFIT', 40);
  const stopLoss = requireNumber('STOP_LOSS', 20);
  const priceCheckInterval = requireNumber('PRICE_CHECK_INTERVAL', 2000);
  const priceCheckDuration = requireNumber('PRICE_CHECK_DURATION', 600000);

  // === TRANSACTION EXECUTION ===
  const transactionExecutor = getEnv('TRANSACTION_EXECUTOR', 'default') as 'default' | 'warp' | 'jito';
  if (!VALID_EXECUTORS.includes(transactionExecutor)) {
    errors.push({
      variable: 'TRANSACTION_EXECUTOR',
      message: `Invalid TRANSACTION_EXECUTOR: "${transactionExecutor}". Must be one of: ${VALID_EXECUTORS.join(', ')}`
    });
  }

  const computeUnitLimit = requireNumber('COMPUTE_UNIT_LIMIT', 101337);
  const computeUnitPrice = requireNumber('COMPUTE_UNIT_PRICE', 421197);
  const customFee = getEnv('CUSTOM_FEE', '0.006');
  const maxBuyRetries = requireNumber('MAX_BUY_RETRIES', 10);
  const maxSellRetries = requireNumber('MAX_SELL_RETRIES', 10);

  // === RISK CONTROLS ===
  const maxTotalExposureSol = requireNumber('MAX_TOTAL_EXPOSURE_SOL', 0.5);
  if (maxTotalExposureSol <= 0) {
    errors.push({ variable: 'MAX_TOTAL_EXPOSURE_SOL', message: 'MAX_TOTAL_EXPOSURE_SOL must be greater than 0' });
  }

  const maxTradesPerHour = requireNumber('MAX_TRADES_PER_HOUR', 10);
  if (maxTradesPerHour <= 0) {
    errors.push({ variable: 'MAX_TRADES_PER_HOUR', message: 'MAX_TRADES_PER_HOUR must be greater than 0' });
  }

  const minWalletBufferSol = requireNumber('MIN_WALLET_BUFFER_SOL', 0.05);
  if (minWalletBufferSol < 0) {
    errors.push({ variable: 'MIN_WALLET_BUFFER_SOL', message: 'MIN_WALLET_BUFFER_SOL cannot be negative' });
  }

  // Max hold duration (0 = disabled, default 20s)
  const maxHoldDurationMs = requireNumber('MAX_HOLD_DURATION_MS', 20000);
  if (maxHoldDurationMs < 0) {
    errors.push({ variable: 'MAX_HOLD_DURATION_MS', message: 'MAX_HOLD_DURATION_MS cannot be negative' });
  }

  // === EXECUTION QUALITY ===
  const simulateTransaction = requireBoolean('SIMULATE_TRANSACTION', true);
  const useDynamicFee = requireBoolean('USE_DYNAMIC_FEE', false);
  const priorityFeePercentile = requireNumber('PRIORITY_FEE_PERCENTILE', 75);
  if (priorityFeePercentile < 0 || priorityFeePercentile > 100) {
    errors.push({ variable: 'PRIORITY_FEE_PERCENTILE', message: 'PRIORITY_FEE_PERCENTILE must be between 0 and 100' });
  }
  const minPriorityFee = requireNumber('MIN_PRIORITY_FEE', 10000);
  const maxPriorityFee = requireNumber('MAX_PRIORITY_FEE', 1000000);
  if (minPriorityFee > maxPriorityFee) {
    errors.push({ variable: 'MIN_PRIORITY_FEE', message: 'MIN_PRIORITY_FEE cannot be greater than MAX_PRIORITY_FEE' });
  }
  const useFallbackExecutor = requireBoolean('USE_FALLBACK_EXECUTOR', true);
  const jitoBundleTimeout = requireNumber('JITO_BUNDLE_TIMEOUT', 60000);
  const jitoBundlePollInterval = requireNumber('JITO_BUNDLE_POLL_INTERVAL', 2000);

  // === OPERATIONAL ===
  const healthPort = requireNumber('HEALTH_PORT', 8080);
  const dataDir = getEnv('DATA_DIR', './data');

  // === DASHBOARD (Phase 5) ===
  const dashboardEnabled = requireBoolean('DASHBOARD_ENABLED', true);
  const dashboardPort = requireNumber('DASHBOARD_PORT', 3000); // Internal port - bootstrap proxies from public PORT
  const dashboardPollInterval = requireNumber('DASHBOARD_POLL_INTERVAL', 5000);

  // === TOKEN AGE ===
  const maxTokenAgeSeconds = requireNumber('MAX_TOKEN_AGE_SECONDS', 300); // 5 minutes default
  if (maxTokenAgeSeconds < 0) {
    errors.push({ variable: 'MAX_TOKEN_AGE_SECONDS', message: 'MAX_TOKEN_AGE_SECONDS cannot be negative' });
  }

  // === PUMP.FUN FILTERS ===
  const pumpfunMinSolInCurve = requireNumber('PUMPFUN_MIN_SOL_IN_CURVE', 5);
  if (pumpfunMinSolInCurve < 0) {
    errors.push({ variable: 'PUMPFUN_MIN_SOL_IN_CURVE', message: 'PUMPFUN_MIN_SOL_IN_CURVE cannot be negative' });
  }

  const pumpfunMaxSolInCurve = requireNumber('PUMPFUN_MAX_SOL_IN_CURVE', 300);
  if (pumpfunMaxSolInCurve <= pumpfunMinSolInCurve) {
    errors.push({ variable: 'PUMPFUN_MAX_SOL_IN_CURVE', message: 'PUMPFUN_MAX_SOL_IN_CURVE must be greater than PUMPFUN_MIN_SOL_IN_CURVE' });
  }

  const pumpfunEnableMinSolFilter = requireBoolean('PUMPFUN_ENABLE_MIN_SOL_FILTER', true);
  const pumpfunEnableMaxSolFilter = requireBoolean('PUMPFUN_ENABLE_MAX_SOL_FILTER', true);

  const pumpfunMinScoreRequired = requireNumber('PUMPFUN_MIN_SCORE_REQUIRED', 0);
  if (pumpfunMinScoreRequired < 0 || pumpfunMinScoreRequired > 100) {
    errors.push({ variable: 'PUMPFUN_MIN_SCORE_REQUIRED', message: 'PUMPFUN_MIN_SCORE_REQUIRED must be between 0 and 100' });
  }

  // === MOMENTUM GATE (Pipeline Stage 4) ===
  // Validates buy momentum before allowing purchase

  const momentumGateEnabled = requireBoolean('MOMENTUM_GATE_ENABLED', true);

  const momentumInitialDelayMs = requireNumber('MOMENTUM_INITIAL_DELAY_MS', 100);
  if (momentumInitialDelayMs < 0) {
    errors.push({ variable: 'MOMENTUM_INITIAL_DELAY_MS', message: 'MOMENTUM_INITIAL_DELAY_MS cannot be negative' });
  }

  const momentumMinTotalBuys = requireNumber('MOMENTUM_MIN_TOTAL_BUYS', 10);
  if (momentumMinTotalBuys < 1) {
    errors.push({ variable: 'MOMENTUM_MIN_TOTAL_BUYS', message: 'MOMENTUM_MIN_TOTAL_BUYS must be at least 1' });
  }

  const momentumRecheckIntervalMs = requireNumber('MOMENTUM_RECHECK_INTERVAL_MS', 100);
  if (momentumRecheckIntervalMs < 0) {
    errors.push({ variable: 'MOMENTUM_RECHECK_INTERVAL_MS', message: 'MOMENTUM_RECHECK_INTERVAL_MS cannot be negative' });
  }

  const momentumMaxChecks = requireNumber('MOMENTUM_MAX_CHECKS', 5);
  if (momentumMaxChecks < 1) {
    errors.push({ variable: 'MOMENTUM_MAX_CHECKS', message: 'MOMENTUM_MAX_CHECKS must be at least 1' });
  }

  // === TEST MODE ===
  const testModeRaw = getEnv('TEST_MODE', '').toLowerCase();
  const testMode = testModeRaw as '' | 'smoke' | 'ab';
  if (testModeRaw && testModeRaw !== 'smoke' && testModeRaw !== 'ab') {
    errors.push({ variable: 'TEST_MODE', message: `Invalid TEST_MODE: "${testModeRaw}". Must be "smoke", "ab", or empty` });
  }

  const smokeTestTimeoutMs = requireNumber('SMOKE_TEST_TIMEOUT_MS', 300000);
  if (smokeTestTimeoutMs < 30000) {
    errors.push({ variable: 'SMOKE_TEST_TIMEOUT_MS', message: 'SMOKE_TEST_TIMEOUT_MS must be at least 30000 (30 seconds)' });
  }

  // === A/B TEST ===
  const abTestDurationMs = requireNumber('AB_TEST_DURATION_MS', 14400000); // 4 hours default
  const abConfigA = getEnv('AB_CONFIG_A', '');
  const abConfigB = getEnv('AB_CONFIG_B', '');

  // === PRODUCTION TIME LIMIT ===
  const productionTimeLimitMinutes = requireNumber('PRODUCTION_TIME_LIMIT_MINUTES', 0);
  if (productionTimeLimitMinutes < 0) {
    errors.push({ variable: 'PRODUCTION_TIME_LIMIT_MINUTES', message: 'PRODUCTION_TIME_LIMIT_MINUTES cannot be negative' });
  }
  if (productionTimeLimitMinutes > 0 && productionTimeLimitMinutes < 1) {
    errors.push({ variable: 'PRODUCTION_TIME_LIMIT_MINUTES', message: 'PRODUCTION_TIME_LIMIT_MINUTES must be at least 1 minute when set, or 0 to disable' });
  }
  const productionTimeLimitMs = productionTimeLimitMinutes * 60000;

  // === BOT CONTROL ===
  const runBot = requireBoolean('RUN_BOT', true);

  // Validate private key format (base58)
  if (privateKey) {
    try {
      // Basic base58 validation - check for valid characters
      const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
      if (!base58Regex.test(privateKey)) {
        errors.push({ variable: 'PRIVATE_KEY', message: 'PRIVATE_KEY contains invalid base58 characters' });
      }
    } catch {
      errors.push({ variable: 'PRIVATE_KEY', message: 'PRIVATE_KEY is not a valid base58 string' });
    }
  }

  // Validate RPC endpoint URLs
  if (rpcEndpoint && !rpcEndpoint.startsWith('http://') && !rpcEndpoint.startsWith('https://')) {
    errors.push({ variable: 'RPC_ENDPOINT', message: 'RPC_ENDPOINT must be a valid HTTP(S) URL' });
  }

  if (rpcWebsocketEndpoint && !rpcWebsocketEndpoint.startsWith('ws://') && !rpcWebsocketEndpoint.startsWith('wss://')) {
    errors.push({ variable: 'RPC_WEBSOCKET_ENDPOINT', message: 'RPC_WEBSOCKET_ENDPOINT must be a valid WebSocket URL (ws:// or wss://)' });
  }

  // Report all errors at once
  if (errors.length > 0) {
    const isRailway = !!process.env.RAILWAY_ENVIRONMENT || !!process.env.RAILWAY_PROJECT_ID;

    logger.error('Configuration validation failed:');
    for (const error of errors) {
      logger.error(`  - ${error.variable}: ${error.message}`);
    }
    logger.error('');
    if (isRailway) {
      logger.error('You are running on Railway. Set these variables in your Railway service:');
      logger.error('  Railway Dashboard → Select your project → Variables tab');
      logger.error('Refer to .env.example in the repo for a complete configuration template.');
    } else {
      logger.error('Please check your .env file and fix the above issues.');
      logger.error('Refer to .env.example for a complete configuration template.');
    }
    // Throw error instead of process.exit() to allow bootstrap health server to report the issue
    const errorMessages = errors.map(e => `${e.variable}: ${e.message}`).join('; ');
    throw new Error(`Configuration validation failed: ${errorMessages}`);
  }

  const config: ValidatedConfig = {
    privateKey,
    rpcEndpoint,
    rpcWebsocketEndpoint,
    rpcBackupEndpoints,
    commitmentLevel,
    dryRun,
    logLevel,
    logFormat,
    quoteMint,
    quoteAmount,
    buySlippage,
    sellSlippage,
    autoBuyDelay,
    autoSell,
    autoSellDelay,
    oneTokenAtATime,
    takeProfit,
    stopLoss,
    priceCheckInterval,
    priceCheckDuration,
    transactionExecutor,
    computeUnitLimit,
    computeUnitPrice,
    customFee,
    maxBuyRetries,
    maxSellRetries,
    maxTotalExposureSol,
    maxTradesPerHour,
    minWalletBufferSol,
    maxHoldDurationMs,
    simulateTransaction,
    useDynamicFee,
    priorityFeePercentile,
    minPriorityFee,
    maxPriorityFee,
    useFallbackExecutor,
    jitoBundleTimeout,
    jitoBundlePollInterval,
    healthPort,
    dataDir,
    dashboardEnabled,
    dashboardPort,
    dashboardPollInterval,
    maxTokenAgeSeconds,
    pumpfunMinSolInCurve,
    pumpfunMaxSolInCurve,
    pumpfunEnableMinSolFilter,
    pumpfunEnableMaxSolFilter,
    pumpfunMinScoreRequired,
    momentumGateEnabled,
    momentumInitialDelayMs,
    momentumMinTotalBuys,
    momentumRecheckIntervalMs,
    momentumMaxChecks,
    testMode,
    smokeTestTimeoutMs,
    abTestDurationMs,
    abConfigA,
    abConfigB,
    runBot,
    productionTimeLimitMs,
  };

  // Log dry run mode warning
  if (config.dryRun) {
    logger.warn('DRY_RUN mode is enabled - transactions will be logged but NOT executed');
  }

  return config;
}

/**
 * Singleton instance of validated config
 */
let validatedConfig: ValidatedConfig | null = null;

/**
 * Get the validated configuration. Initializes on first call.
 */
export function getConfig(): ValidatedConfig {
  if (!validatedConfig) {
    validatedConfig = validateConfig();
  }
  return validatedConfig;
}

/**
 * Check if dry run mode is enabled
 */
export function isDryRun(): boolean {
  return getConfig().dryRun;
}
