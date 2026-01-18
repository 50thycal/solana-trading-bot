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

  // Filters
  filterPreset: 'strict' | 'balanced' | 'aggressive' | 'custom';
  checkIfBurned: boolean;
  checkIfMintIsRenounced: boolean;
  checkIfFreezable: boolean;
  checkIfMutable: boolean;
  checkIfSocials: boolean;
  minPoolSize: string;
  maxPoolSize: string;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveFilterMatches: number;
  useSnipeList: boolean;
  snipeListRefreshInterval: number;

  // Bot
  preLoadExistingMarkets: boolean;
  cacheNewMarkets: boolean;

  // Operational
  healthPort: number;
  dataDir: string;
}

interface ValidationError {
  variable: string;
  message: string;
}

const VALID_COMMITMENTS: Commitment[] = ['processed', 'confirmed', 'finalized'];
const VALID_EXECUTORS = ['default', 'warp', 'jito'] as const;
const VALID_PRESETS = ['strict', 'balanced', 'aggressive', 'custom'] as const;
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

  // === TRADING PARAMETERS ===
  const quoteMintRaw = requireEnv('QUOTE_MINT');
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

  // === FILTERS ===
  const filterPreset = getEnv('FILTER_PRESET', 'custom') as 'strict' | 'balanced' | 'aggressive' | 'custom';
  if (!VALID_PRESETS.includes(filterPreset)) {
    errors.push({
      variable: 'FILTER_PRESET',
      message: `Invalid FILTER_PRESET: "${filterPreset}". Must be one of: ${VALID_PRESETS.join(', ')}`
    });
  }

  const checkIfBurned = requireBoolean('CHECK_IF_BURNED', true);
  const checkIfMintIsRenounced = requireBoolean('CHECK_IF_MINT_IS_RENOUNCED', true);
  const checkIfFreezable = requireBoolean('CHECK_IF_FREEZABLE', true);
  const checkIfMutable = requireBoolean('CHECK_IF_MUTABLE', true);
  const checkIfSocials = requireBoolean('CHECK_IF_SOCIALS', true);
  const minPoolSize = getEnv('MIN_POOL_SIZE', '5');
  const maxPoolSize = getEnv('MAX_POOL_SIZE', '50');
  const filterCheckInterval = requireNumber('FILTER_CHECK_INTERVAL', 2000);
  const filterCheckDuration = requireNumber('FILTER_CHECK_DURATION', 60000);
  const consecutiveFilterMatches = requireNumber('CONSECUTIVE_FILTER_MATCHES', 3);
  const useSnipeList = requireBoolean('USE_SNIPE_LIST', false);
  const snipeListRefreshInterval = requireNumber('SNIPE_LIST_REFRESH_INTERVAL', 30000);

  // === BOT ===
  const preLoadExistingMarkets = requireBoolean('PRE_LOAD_EXISTING_MARKETS', false);
  const cacheNewMarkets = requireBoolean('CACHE_NEW_MARKETS', false);

  // === OPERATIONAL ===
  const healthPort = requireNumber('HEALTH_PORT', 8080);
  const dataDir = getEnv('DATA_DIR', './data');

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
    logger.error('Configuration validation failed:');
    for (const error of errors) {
      logger.error(`  - ${error.variable}: ${error.message}`);
    }
    logger.error('');
    logger.error('Please check your .env file and fix the above issues.');
    logger.error('Refer to .env.example for a complete configuration template.');
    process.exit(1);
  }

  const config: ValidatedConfig = {
    privateKey,
    rpcEndpoint,
    rpcWebsocketEndpoint,
    rpcBackupEndpoints,
    commitmentLevel,
    dryRun,
    logLevel,
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
    filterPreset,
    checkIfBurned,
    checkIfMintIsRenounced,
    checkIfFreezable,
    checkIfMutable,
    checkIfSocials,
    minPoolSize,
    maxPoolSize,
    filterCheckInterval,
    filterCheckDuration,
    consecutiveFilterMatches,
    useSnipeList,
    snipeListRefreshInterval,
    preLoadExistingMarkets,
    cacheNewMarkets,
    healthPort,
    dataDir,
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
