import { Commitment } from '@solana/web3.js';
import { getConfig, isDryRun, ValidatedConfig } from './config-validator';

// Get validated configuration
const config: ValidatedConfig = getConfig();

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
export const RUN_BOT = config.runBot;
export { isDryRun };

// ============================================================================
// BOT
// ============================================================================
export const ONE_TOKEN_AT_A_TIME = config.oneTokenAtATime;
export const COMPUTE_UNIT_LIMIT = config.computeUnitLimit;
export const COMPUTE_UNIT_PRICE = config.computeUnitPrice;
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
// RISK CONTROLS
// ============================================================================
export const MAX_TOTAL_EXPOSURE_SOL = config.maxTotalExposureSol;
export const MAX_TRADES_PER_HOUR = config.maxTradesPerHour;
export const MIN_WALLET_BUFFER_SOL = config.minWalletBufferSol;
export const MAX_HOLD_DURATION_MS = config.maxHoldDurationMs;

// ============================================================================
// EXECUTION QUALITY
// ============================================================================
export const SIMULATE_TRANSACTION = config.simulateTransaction;
export const USE_DYNAMIC_FEE = config.useDynamicFee;
export const PRIORITY_FEE_PERCENTILE = config.priorityFeePercentile;
export const MIN_PRIORITY_FEE = config.minPriorityFee;
export const MAX_PRIORITY_FEE = config.maxPriorityFee;
export const USE_FALLBACK_EXECUTOR = config.useFallbackExecutor;
export const JITO_BUNDLE_TIMEOUT = config.jitoBundleTimeout;
export const JITO_BUNDLE_POLL_INTERVAL = config.jitoBundlePollInterval;

// ============================================================================
// OPERATIONAL
// ============================================================================
export const HEALTH_PORT = config.healthPort;

// ============================================================================
// TOKEN AGE
// ============================================================================
export const MAX_TOKEN_AGE_SECONDS = config.maxTokenAgeSeconds;

// ============================================================================
// PUMP.FUN FILTERS
// ============================================================================
export const PUMPFUN_MIN_SOL_IN_CURVE = config.pumpfunMinSolInCurve;
export const PUMPFUN_MAX_SOL_IN_CURVE = config.pumpfunMaxSolInCurve;
export const PUMPFUN_ENABLE_MIN_SOL_FILTER = config.pumpfunEnableMinSolFilter;
export const PUMPFUN_ENABLE_MAX_SOL_FILTER = config.pumpfunEnableMaxSolFilter;
export const PUMPFUN_MIN_SCORE_REQUIRED = config.pumpfunMinScoreRequired;

// ============================================================================
// TEST MODE
// ============================================================================
export const TEST_MODE = config.testMode;
export const LOG_FORMAT = config.logFormat;

// Export the full config for advanced use cases
export { config as validatedConfig };
