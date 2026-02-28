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
  botMode: 'production' | 'dry_run' | 'smoke' | 'ab' | 'standby';
  dryRun: boolean;       // derived from botMode
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
  pumpfunDetectionCooldownMs: number;

  // Momentum Gate
  momentumGateEnabled: boolean;
  momentumInitialDelayMs: number;
  momentumMinTotalBuys: number;
  momentumRecheckIntervalMs: number;
  momentumMaxChecks: number;

  // Sniper Gate (Pipeline Stage 4 - Alternative to Momentum Gate)
  sniperGateEnabled: boolean;
  sniperGateInitialDelayMs: number;
  sniperGateRecheckIntervalMs: number;
  sniperGateMaxChecks: number;
  sniperGateSniperSlotThreshold: number;
  sniperGateMinBotExitPercent: number;
  sniperGateMinOrganicBuyers: number;
  sniperGateLogOnly: boolean;

  // Trailing Stop Loss
  trailingStopEnabled: boolean;
  trailingStopActivationPercent: number;
  trailingStopDistancePercent: number;
  hardTakeProfitPercent: number;

  // Smoke Test (applies when botMode='smoke')
  smokeTestTimeoutMs: number;
  smokeTestRuns: number;

  // A/B Test (applies when botMode='ab')
  abTestDurationMs: number;
  abConfigA: string;
  abConfigB: string;

  // Derived from botMode (for backward compatibility)
  testMode: '' | 'smoke' | 'ab';
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

  // === BOT MODE ===
  const VALID_BOT_MODES = ['production', 'dry_run', 'smoke', 'ab', 'standby'] as const;
  const botModeRaw = getEnv('BOT_MODE', 'production').toLowerCase();
  if (!VALID_BOT_MODES.includes(botModeRaw as any)) {
    errors.push({
      variable: 'BOT_MODE',
      message: `Invalid BOT_MODE: "${botModeRaw}". Must be one of: ${VALID_BOT_MODES.join(', ')}`
    });
  }
  const botMode = botModeRaw as 'production' | 'dry_run' | 'smoke' | 'ab' | 'standby';

  // Derive legacy flags from botMode
  const dryRun = botMode === 'dry_run' || botMode === 'ab';
  const runBot = botMode !== 'standby';
  const testMode: '' | 'smoke' | 'ab' = botMode === 'smoke' ? 'smoke' : botMode === 'ab' ? 'ab' : '';

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
  // Upper bound is strictly < 100: at exactly 100% the BuyExactSolIn slippage floor
  // collapses to zero (minTokensOut = expectedTokens × 0 = 0), meaning the program
  // will accept any outcome including receiving 0 tokens — a total SOL loss.
  if (buySlippage < 0 || buySlippage >= 100) {
    errors.push({ variable: 'BUY_SLIPPAGE', message: `BUY_SLIPPAGE must be between 0 and 99 (percent), got: ${buySlippage}` });
  }

  const sellSlippage = requireNumber('SELL_SLIPPAGE', 30);
  if (sellSlippage < 0 || sellSlippage >= 100) {
    errors.push({ variable: 'SELL_SLIPPAGE', message: `SELL_SLIPPAGE must be between 0 and 99 (percent), got: ${sellSlippage}` });
  }

  const autoBuyDelay = requireNumber('AUTO_BUY_DELAY', 0);
  const autoSell = requireBoolean('AUTO_SELL', true);
  const autoSellDelay = requireNumber('AUTO_SELL_DELAY', 0);
  const oneTokenAtATime = requireBoolean('ONE_TOKEN_AT_A_TIME', true);
  const takeProfit = requireNumber('TAKE_PROFIT', 40);
  const stopLoss = requireNumber('STOP_LOSS', 20);
  const priceCheckIntervalSeconds = requireNumber('PRICE_CHECK_INTERVAL_SECONDS', 2);
  const priceCheckInterval = Math.round(priceCheckIntervalSeconds * 1000);
  const priceCheckDurationMinutes = requireNumber('PRICE_CHECK_DURATION_MINUTES', 600000 / 60000);
  const priceCheckDuration = Math.round(priceCheckDurationMinutes * 60000);

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
  const maxHoldDurationSeconds = requireNumber('MAX_HOLD_DURATION_SECONDS', 20);
  if (maxHoldDurationSeconds < 0) {
    errors.push({ variable: 'MAX_HOLD_DURATION_SECONDS', message: 'MAX_HOLD_DURATION_SECONDS cannot be negative' });
  }
  const maxHoldDurationMs = Math.round(maxHoldDurationSeconds * 1000);

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

  const pumpfunDetectionCooldownSeconds = requireNumber('PUMPFUN_DETECTION_COOLDOWN_SECONDS', 0);
  if (pumpfunDetectionCooldownSeconds < 0) {
    errors.push({ variable: 'PUMPFUN_DETECTION_COOLDOWN_SECONDS', message: 'PUMPFUN_DETECTION_COOLDOWN_SECONDS cannot be negative' });
  }
  const pumpfunDetectionCooldownMs = Math.round(pumpfunDetectionCooldownSeconds * 1000);

  // === MOMENTUM GATE (Pipeline Stage 4) ===
  // Validates buy momentum before allowing purchase

  const momentumGateEnabled = requireBoolean('MOMENTUM_GATE_ENABLED', true);

  const momentumInitialDelaySeconds = requireNumber('MOMENTUM_INITIAL_DELAY_SECONDS', 0.1);
  if (momentumInitialDelaySeconds < 0) {
    errors.push({ variable: 'MOMENTUM_INITIAL_DELAY_SECONDS', message: 'MOMENTUM_INITIAL_DELAY_SECONDS cannot be negative' });
  }
  const momentumInitialDelayMs = Math.round(momentumInitialDelaySeconds * 1000);

  const momentumMinTotalBuys = requireNumber('MOMENTUM_MIN_TOTAL_BUYS', 10);
  if (momentumMinTotalBuys < 1) {
    errors.push({ variable: 'MOMENTUM_MIN_TOTAL_BUYS', message: 'MOMENTUM_MIN_TOTAL_BUYS must be at least 1' });
  }

  const momentumRecheckIntervalSeconds = requireNumber('MOMENTUM_RECHECK_INTERVAL_SECONDS', 0.1);
  if (momentumRecheckIntervalSeconds < 0) {
    errors.push({ variable: 'MOMENTUM_RECHECK_INTERVAL_SECONDS', message: 'MOMENTUM_RECHECK_INTERVAL_SECONDS cannot be negative' });
  }
  const momentumRecheckIntervalMs = Math.round(momentumRecheckIntervalSeconds * 1000);

  const momentumMaxChecks = requireNumber('MOMENTUM_MAX_CHECKS', 5);
  if (momentumMaxChecks < 1) {
    errors.push({ variable: 'MOMENTUM_MAX_CHECKS', message: 'MOMENTUM_MAX_CHECKS must be at least 1' });
  }

  // === SNIPER GATE (Pipeline Stage 4 - Alternative to Momentum Gate) ===
  // Identifies sniper bot wallets by slot delta, monitors for their exits,
  // then evaluates organic demand. When enabled, replaces the momentum gate.

  const sniperGateEnabled = requireBoolean('SNIPER_GATE_ENABLED', false);

  const sniperGateInitialDelaySeconds = requireNumber('SNIPER_GATE_INITIAL_DELAY_SECONDS', 0.5);
  if (sniperGateInitialDelaySeconds < 0) {
    errors.push({ variable: 'SNIPER_GATE_INITIAL_DELAY_SECONDS', message: 'cannot be negative' });
  }
  const sniperGateInitialDelayMs = Math.round(sniperGateInitialDelaySeconds * 1000);

  const sniperGateRecheckIntervalSeconds = requireNumber('SNIPER_GATE_RECHECK_INTERVAL_SECONDS', 1);
  if (sniperGateRecheckIntervalSeconds < 0.1) {
    errors.push({ variable: 'SNIPER_GATE_RECHECK_INTERVAL_SECONDS', message: 'must be >= 0.1' });
  }
  const sniperGateRecheckIntervalMs = Math.round(sniperGateRecheckIntervalSeconds * 1000);

  const sniperGateMaxChecks = requireNumber('SNIPER_GATE_MAX_CHECKS', 10);
  if (sniperGateMaxChecks < 1) {
    errors.push({ variable: 'SNIPER_GATE_MAX_CHECKS', message: 'must be >= 1' });
  }

  const sniperGateSniperSlotThreshold = requireNumber('SNIPER_GATE_SNIPER_SLOT_THRESHOLD', 3);
  if (sniperGateSniperSlotThreshold < 0) {
    errors.push({ variable: 'SNIPER_GATE_SNIPER_SLOT_THRESHOLD', message: 'cannot be negative' });
  }

  const sniperGateMinBotExitPercent = requireNumber('SNIPER_GATE_MIN_BOT_EXIT_PERCENT', 50);
  if (sniperGateMinBotExitPercent < 0 || sniperGateMinBotExitPercent > 100) {
    errors.push({ variable: 'SNIPER_GATE_MIN_BOT_EXIT_PERCENT', message: 'must be 0-100' });
  }

  const sniperGateMinOrganicBuyers = requireNumber('SNIPER_GATE_MIN_ORGANIC_BUYERS', 3);
  if (sniperGateMinOrganicBuyers < 1) {
    errors.push({ variable: 'SNIPER_GATE_MIN_ORGANIC_BUYERS', message: 'must be >= 1' });
  }

  const sniperGateLogOnly = requireBoolean('SNIPER_GATE_LOG_ONLY', false);

  // === TRAILING STOP LOSS ===
  const trailingStopEnabled = requireBoolean('TRAILING_STOP_ENABLED', false);

  const trailingStopActivationPercent = requireNumber('TRAILING_STOP_ACTIVATION_PERCENT', 15);
  if (trailingStopActivationPercent < 0) {
    errors.push({ variable: 'TRAILING_STOP_ACTIVATION_PERCENT', message: 'cannot be negative' });
  }

  const trailingStopDistancePercent = requireNumber('TRAILING_STOP_DISTANCE_PERCENT', 10);
  if (trailingStopDistancePercent < 0) {
    errors.push({ variable: 'TRAILING_STOP_DISTANCE_PERCENT', message: 'cannot be negative' });
  }

  const hardTakeProfitPercent = requireNumber('HARD_TAKE_PROFIT_PERCENT', 0);
  if (hardTakeProfitPercent < 0) {
    errors.push({ variable: 'HARD_TAKE_PROFIT_PERCENT', message: 'cannot be negative' });
  }

  // === SMOKE TEST (applies when BOT_MODE=smoke) ===
  const smokeTestTimeoutMinutes = requireNumber('SMOKE_TEST_TIMEOUT_MINUTES', 5);
  if (smokeTestTimeoutMinutes < 0.5) {
    errors.push({ variable: 'SMOKE_TEST_TIMEOUT_MINUTES', message: 'SMOKE_TEST_TIMEOUT_MINUTES must be at least 0.5 (30 seconds)' });
  }
  const smokeTestTimeoutMs = Math.round(smokeTestTimeoutMinutes * 60000);

  const smokeTestRuns = requireNumber('SMOKE_TEST_RUNS', 1);
  if (smokeTestRuns < 1 || !Number.isInteger(smokeTestRuns)) {
    errors.push({ variable: 'SMOKE_TEST_RUNS', message: 'SMOKE_TEST_RUNS must be a positive integer (default: 1)' });
  }

  // === A/B TEST (applies when BOT_MODE=ab) ===
  const abTestDurationMinutes = requireNumber('AB_TEST_DURATION_MINUTES', 240); // 4 hours default
  const abTestDurationMs = Math.round(abTestDurationMinutes * 60000);
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

  // Conflict warnings
  if (sniperGateEnabled && momentumGateEnabled) {
    logger.warn(
      'Both SNIPER_GATE and MOMENTUM_GATE are enabled. '
      + 'Sniper gate takes priority at Stage 4.',
    );
  }

  if (trailingStopEnabled && takeProfit > 0) {
    logger.warn(
      'Both TRAILING_STOP and TAKE_PROFIT are configured. '
      + 'When trailing stop is enabled, fixed take profit is ignored. '
      + 'Use HARD_TAKE_PROFIT_PERCENT for a ceiling with trailing stop.',
    );
  }

  if (trailingStopEnabled && trailingStopDistancePercent >= trailingStopActivationPercent) {
    logger.warn(
      `TRAILING_STOP_DISTANCE_PERCENT (${trailingStopDistancePercent}) >= `
      + `TRAILING_STOP_ACTIVATION_PERCENT (${trailingStopActivationPercent}). `
      + 'The trail level will be at or below zero when activation triggers, making '
      + 'the trailing stop functionally inactive. Set DISTANCE < ACTIVATION.',
    );
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
    botMode,
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
    pumpfunDetectionCooldownMs,
    momentumGateEnabled,
    momentumInitialDelayMs,
    momentumMinTotalBuys,
    momentumRecheckIntervalMs,
    momentumMaxChecks,
    sniperGateEnabled,
    sniperGateInitialDelayMs,
    sniperGateRecheckIntervalMs,
    sniperGateMaxChecks,
    sniperGateSniperSlotThreshold,
    sniperGateMinBotExitPercent,
    sniperGateMinOrganicBuyers,
    sniperGateLogOnly,
    trailingStopEnabled,
    trailingStopActivationPercent,
    trailingStopDistancePercent,
    hardTakeProfitPercent,
    testMode,
    smokeTestTimeoutMs,
    smokeTestRuns,
    abTestDurationMs,
    abConfigA,
    abConfigB,
    runBot,
    productionTimeLimitMs,
  };

  // Log mode info
  if (config.botMode === 'dry_run') {
    logger.warn('BOT_MODE=dry_run - transactions will be logged but NOT executed');
  } else if (config.botMode === 'standby') {
    logger.warn('BOT_MODE=standby - bot will not connect to Solana or consume RPC credits');
  } else if (config.botMode === 'smoke') {
    logger.info(`BOT_MODE=smoke - will run ${config.smokeTestRuns} sequential end-to-end test cycle(s)`);
  } else if (config.botMode === 'ab') {
    logger.info('BOT_MODE=ab - will run A/B paper trade comparison and exit');
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
