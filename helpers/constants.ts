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
export const BOT_MODE = config.botMode;
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
export const PUMPFUN_DETECTION_COOLDOWN_MS = config.pumpfunDetectionCooldownMs;

// ============================================================================
// MOMENTUM GATE
// ============================================================================
export const MOMENTUM_GATE_ENABLED = config.momentumGateEnabled;
export const MOMENTUM_INITIAL_DELAY_MS = config.momentumInitialDelayMs;
export const MOMENTUM_MIN_TOTAL_BUYS = config.momentumMinTotalBuys;
export const MOMENTUM_RECHECK_INTERVAL_MS = config.momentumRecheckIntervalMs;
export const MOMENTUM_MAX_CHECKS = config.momentumMaxChecks;

// ============================================================================
// SNIPER GATE
// ============================================================================
export const SNIPER_GATE_ENABLED = config.sniperGateEnabled;
export const SNIPER_GATE_INITIAL_DELAY_MS = config.sniperGateInitialDelayMs;
export const SNIPER_GATE_RECHECK_INTERVAL_MS = config.sniperGateRecheckIntervalMs;
export const SNIPER_GATE_MAX_CHECKS = config.sniperGateMaxChecks;
export const SNIPER_GATE_SNIPER_SLOT_THRESHOLD = config.sniperGateSniperSlotThreshold;
export const SNIPER_GATE_MIN_BOT_EXIT_PERCENT = config.sniperGateMinBotExitPercent;
export const SNIPER_GATE_MIN_ORGANIC_BUYERS = config.sniperGateMinOrganicBuyers;
export const SNIPER_GATE_LOG_ONLY = config.sniperGateLogOnly;

// ============================================================================
// TRAILING STOP
// ============================================================================
export const TRAILING_STOP_ENABLED = config.trailingStopEnabled;
export const TRAILING_STOP_ACTIVATION_PERCENT = config.trailingStopActivationPercent;
export const TRAILING_STOP_DISTANCE_PERCENT = config.trailingStopDistancePercent;
export const HARD_TAKE_PROFIT_PERCENT = config.hardTakeProfitPercent;

// ============================================================================
// TEST MODE
// ============================================================================
export const TEST_MODE = config.testMode;
export const SMOKE_TEST_TIMEOUT_MS = config.smokeTestTimeoutMs;
export const SMOKE_TEST_RUNS = config.smokeTestRuns;
export const LOG_FORMAT = config.logFormat;

// ============================================================================
// A/B TEST
// ============================================================================
export const AB_TEST_DURATION_MS = config.abTestDurationMs;
export const AB_CONFIG_A = config.abConfigA;
export const AB_CONFIG_B = config.abConfigB;

// ============================================================================
// PRODUCTION TIME LIMIT
// ============================================================================
export const PRODUCTION_TIME_LIMIT_MS = config.productionTimeLimitMs;

// Export the full config for advanced use cases
export { config as validatedConfig };
