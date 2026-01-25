import { Commitment } from '@solana/web3.js';
import { logger } from './logger';
import { getConfig, isDryRun, ValidatedConfig } from './config-validator';
import { resolveFilterSettings, FilterPresetName, ResolvedFilterSettings } from './filter-presets';

// Get validated configuration
const config: ValidatedConfig = getConfig();

// Resolve filter settings based on preset
const filterSettings: ResolvedFilterSettings = resolveFilterSettings(
  config.filterPreset as FilterPresetName,
  {
    checkIfBurned: config.checkIfBurned,
    checkIfMintIsRenounced: config.checkIfMintIsRenounced,
    checkIfFreezable: config.checkIfFreezable,
    checkIfMutable: config.checkIfMutable,
    checkIfSocials: config.checkIfSocials,
    minPoolSize: config.minPoolSize,
    maxPoolSize: config.maxPoolSize,
  }
);

// ============================================================================
// WALLET
// ============================================================================
export const PRIVATE_KEY = config.privateKey;

// ============================================================================
// CONNECTION
// ============================================================================
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = config.commitmentLevel;
export const RPC_ENDPOINT = config.rpcEndpoint;
export const RPC_WEBSOCKET_ENDPOINT = config.rpcWebsocketEndpoint;
export const RPC_BACKUP_ENDPOINTS = config.rpcBackupEndpoints;

// ============================================================================
// MODE
// ============================================================================
export const DRY_RUN = config.dryRun;
export const LOG_LEVEL = config.logLevel;
export { isDryRun };

// ============================================================================
// BOT
// ============================================================================
export const ONE_TOKEN_AT_A_TIME = config.oneTokenAtATime;
export const COMPUTE_UNIT_LIMIT = config.computeUnitLimit;
export const COMPUTE_UNIT_PRICE = config.computeUnitPrice;
export const PRE_LOAD_EXISTING_MARKETS = config.preLoadExistingMarkets;
export const CACHE_NEW_MARKETS = config.cacheNewMarkets;
export const ENABLE_CPMM = config.enableCpmm;
export const ENABLE_DLMM = config.enableDlmm;
export const TRANSACTION_EXECUTOR = config.transactionExecutor;
export const CUSTOM_FEE = config.customFee;

// ============================================================================
// BUY
// ============================================================================
export const AUTO_BUY_DELAY = config.autoBuyDelay;
export const QUOTE_MINT = config.quoteMint;
export const QUOTE_AMOUNT = config.quoteAmount;
export const MAX_BUY_RETRIES = config.maxBuyRetries;
export const BUY_SLIPPAGE = config.buySlippage;

// ============================================================================
// SELL
// ============================================================================
export const AUTO_SELL = config.autoSell;
export const AUTO_SELL_DELAY = config.autoSellDelay;
export const MAX_SELL_RETRIES = config.maxSellRetries;
export const TAKE_PROFIT = config.takeProfit;
export const STOP_LOSS = config.stopLoss;
export const PRICE_CHECK_INTERVAL = config.priceCheckInterval;
export const PRICE_CHECK_DURATION = config.priceCheckDuration;
export const SELL_SLIPPAGE = config.sellSlippage;

// ============================================================================
// FILTERS (resolved from preset or custom settings)
// ============================================================================
export const FILTER_PRESET = config.filterPreset;
export const FILTER_CHECK_INTERVAL = config.filterCheckInterval;
export const FILTER_CHECK_DURATION = config.filterCheckDuration;
export const CONSECUTIVE_FILTER_MATCHES = config.consecutiveFilterMatches;

// Filter flags resolved from preset
export const CHECK_IF_MUTABLE = filterSettings.checkIfMutable;
export const CHECK_IF_SOCIALS = filterSettings.checkIfSocials;
export const CHECK_IF_MINT_IS_RENOUNCED = filterSettings.checkIfMintIsRenounced;
export const CHECK_IF_FREEZABLE = filterSettings.checkIfFreezable;
export const CHECK_IF_BURNED = filterSettings.checkIfBurned;
export const MIN_POOL_SIZE = filterSettings.minPoolSize;
export const MAX_POOL_SIZE = filterSettings.maxPoolSize;

// Snipe list
export const USE_SNIPE_LIST = config.useSnipeList;
export const SNIPE_LIST_REFRESH_INTERVAL = config.snipeListRefreshInterval;

// ============================================================================
// RISK CONTROLS (Phase 2)
// ============================================================================
export const MAX_TOTAL_EXPOSURE_SOL = config.maxTotalExposureSol;
export const MAX_TRADES_PER_HOUR = config.maxTradesPerHour;
export const MIN_WALLET_BUFFER_SOL = config.minWalletBufferSol;
export const MAX_HOLD_DURATION_MS = config.maxHoldDurationMs;

// ============================================================================
// EXECUTION QUALITY (Phase 4)
// ============================================================================
export const SIMULATE_TRANSACTION = config.simulateTransaction;
export const USE_DYNAMIC_FEE = config.useDynamicFee;
export const PRIORITY_FEE_PERCENTILE = config.priorityFeePercentile;
export const MIN_PRIORITY_FEE = config.minPriorityFee;
export const MAX_PRIORITY_FEE = config.maxPriorityFee;
export const USE_FALLBACK_EXECUTOR = config.useFallbackExecutor;
export const JITO_BUNDLE_TIMEOUT = config.jitoBundleTimeout;
export const JITO_BUNDLE_POLL_INTERVAL = config.jitoBundlePollInterval;
export const PRECOMPUTE_TRANSACTION = config.precomputeTransaction;

// ============================================================================
// OPERATIONAL
// ============================================================================
export const HEALTH_PORT = config.healthPort;
export const DATA_DIR = config.dataDir;

// ============================================================================
// TOKEN AGE VALIDATION (Pool Detection Phase 1)
// ============================================================================
export const MAX_TOKEN_AGE_SECONDS = config.maxTokenAgeSeconds;
export const ENABLE_TOKEN_AGE_CHECK = config.enableTokenAgeCheck;

// ============================================================================
// MINT DETECTION (Pool Detection Phase 0)
// ============================================================================
export const ENABLE_HELIUS_MINT_DETECTION = config.enableHeliusMintDetection;

// ============================================================================
// LOGGING
// ============================================================================

/**
 * Log the active filter preset configuration
 */
export function logFilterPresetInfo(): void {
  if (config.filterPreset === 'custom') {
    logger.info('Filter preset: custom (using individual CHECK_IF_* settings)');
  } else {
    logger.info(`Filter preset: ${config.filterPreset}`);
  }
  logger.info(`  Burned LP check: ${filterSettings.checkIfBurned}`);
  logger.info(`  Renounced mint check: ${filterSettings.checkIfMintIsRenounced}`);
  logger.info(`  Freezable check: ${filterSettings.checkIfFreezable}`);
  logger.info(`  Mutable check: ${filterSettings.checkIfMutable}`);
  logger.info(`  Socials check: ${filterSettings.checkIfSocials}`);
  logger.info(`  Pool size range: ${filterSettings.minPoolSize} - ${filterSettings.maxPoolSize}`);
}

// Export the resolved filter settings for external use
export { filterSettings };

// Export the full config for advanced use cases
export { config as validatedConfig };
