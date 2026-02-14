/**
 * Centralized metadata for all environment variables.
 * Used by the dashboard to render the env config editor
 * and generate Railway-compatible copy-paste output.
 */

export interface EnvVarMeta {
  /** The actual environment variable name (e.g. PRIVATE_KEY) */
  name: string;
  /** Human-readable label */
  label: string;
  /** Type hint for the UI */
  type: 'string' | 'number' | 'boolean' | 'select';
  /** Default value (as string) */
  defaultValue: string;
  /** Short description */
  description: string;
  /** Whether this is a required variable */
  required?: boolean;
  /** Whether this is sensitive (should be masked, excluded from copy) */
  sensitive?: boolean;
  /** Valid options for 'select' type */
  options?: string[];
  /** Placeholder text for the input */
  placeholder?: string;
  /** Validation hint (e.g. "0-100") */
  hint?: string;
}

export interface EnvCategory {
  /** Category ID */
  id: string;
  /** Display name */
  label: string;
  /** Short description of this category */
  description: string;
  /** Variables in this category */
  vars: EnvVarMeta[];
}

/**
 * All environment variables organized by category.
 * Order matters - categories and vars are displayed in this order.
 */
export const ENV_CATEGORIES: EnvCategory[] = [
  {
    id: 'core',
    label: 'Core Configuration',
    description: 'Required connection settings for Solana RPC and wallet',
    vars: [
      {
        name: 'PRIVATE_KEY',
        label: 'Private Key',
        type: 'string',
        defaultValue: '',
        description: 'Wallet private key in base58 format',
        required: true,
        sensitive: true,
        placeholder: 'Your base58 private key',
      },
      {
        name: 'RPC_ENDPOINT',
        label: 'RPC Endpoint',
        type: 'string',
        defaultValue: '',
        description: 'HTTPS RPC endpoint (Helius recommended)',
        required: true,
        sensitive: true,
        placeholder: 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
      },
      {
        name: 'RPC_WEBSOCKET_ENDPOINT',
        label: 'RPC WebSocket Endpoint',
        type: 'string',
        defaultValue: '',
        description: 'WebSocket RPC endpoint for real-time data',
        required: true,
        sensitive: true,
        placeholder: 'wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY',
      },
      {
        name: 'RPC_BACKUP_ENDPOINTS',
        label: 'Backup RPC Endpoints',
        type: 'string',
        defaultValue: '',
        description: 'Comma-separated fallback RPC endpoints',
        sensitive: true,
        placeholder: 'https://backup1.example.com,https://backup2.example.com',
      },
      {
        name: 'COMMITMENT_LEVEL',
        label: 'Commitment Level',
        type: 'select',
        defaultValue: 'confirmed',
        description: 'Solana transaction commitment level',
        options: ['processed', 'confirmed', 'finalized'],
      },
    ],
  },
  {
    id: 'mode',
    label: 'Mode Configuration',
    description: 'Controls how the bot operates',
    vars: [
      {
        name: 'BOT_MODE',
        label: 'Bot Mode',
        type: 'select',
        defaultValue: 'production',
        description: 'Operating mode of the bot',
        options: ['production', 'dry_run', 'smoke', 'ab', 'standby'],
      },
      {
        name: 'LOG_LEVEL',
        label: 'Log Level',
        type: 'select',
        defaultValue: 'info',
        description: 'Log verbosity level',
        options: ['trace', 'debug', 'info', 'warn', 'error'],
      },
      {
        name: 'LOG_FORMAT',
        label: 'Log Format',
        type: 'select',
        defaultValue: 'pretty',
        description: 'Log output format for Railway',
        options: ['pretty', 'compact'],
      },
    ],
  },
  {
    id: 'trading',
    label: 'Trading Parameters',
    description: 'Core trading behavior - amounts, slippage, profit targets',
    vars: [
      {
        name: 'QUOTE_MINT',
        label: 'Quote Currency',
        type: 'select',
        defaultValue: 'WSOL',
        description: 'Token to spend when buying',
        options: ['WSOL', 'USDC'],
      },
      {
        name: 'QUOTE_AMOUNT',
        label: 'Trade Amount',
        type: 'number',
        defaultValue: '0.01',
        description: 'Amount to spend per trade (in quote token)',
        hint: 'e.g. 0.01 = 0.01 SOL per trade',
      },
      {
        name: 'BUY_SLIPPAGE',
        label: 'Buy Slippage %',
        type: 'number',
        defaultValue: '20',
        description: 'Buy slippage tolerance percentage',
        hint: '0-100',
      },
      {
        name: 'SELL_SLIPPAGE',
        label: 'Sell Slippage %',
        type: 'number',
        defaultValue: '30',
        description: 'Sell slippage tolerance percentage',
        hint: '0-100',
      },
      {
        name: 'AUTO_BUY_DELAY',
        label: 'Auto Buy Delay (ms)',
        type: 'number',
        defaultValue: '0',
        description: 'Delay before buying after detection',
        hint: '0 = immediate',
      },
      {
        name: 'AUTO_SELL',
        label: 'Auto Sell',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Automatically sell when targets are hit',
      },
      {
        name: 'AUTO_SELL_DELAY',
        label: 'Auto Sell Delay (ms)',
        type: 'number',
        defaultValue: '0',
        description: 'Delay before selling after trigger',
      },
      {
        name: 'ONE_TOKEN_AT_A_TIME',
        label: 'One Token at a Time',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Process only one token concurrently',
      },
      {
        name: 'TAKE_PROFIT',
        label: 'Take Profit %',
        type: 'number',
        defaultValue: '40',
        description: 'Sell when price increases by this %',
      },
      {
        name: 'STOP_LOSS',
        label: 'Stop Loss %',
        type: 'number',
        defaultValue: '20',
        description: 'Sell when price drops by this %',
      },
      {
        name: 'PRICE_CHECK_INTERVAL_SECONDS',
        label: 'Price Check Interval (s)',
        type: 'number',
        defaultValue: '2',
        description: 'How often to check P&L',
      },
      {
        name: 'PRICE_CHECK_DURATION_MINUTES',
        label: 'Price Check Duration (min)',
        type: 'number',
        defaultValue: '10',
        description: 'Max time to hold a position for P&L checks',
      },
    ],
  },
  {
    id: 'risk',
    label: 'Risk Controls',
    description: 'Exposure limits, rate limits, and safety buffers',
    vars: [
      {
        name: 'MAX_TOTAL_EXPOSURE_SOL',
        label: 'Max Total Exposure (SOL)',
        type: 'number',
        defaultValue: '0.5',
        description: 'Max SOL deployed across all positions',
      },
      {
        name: 'MAX_TRADES_PER_HOUR',
        label: 'Max Trades Per Hour',
        type: 'number',
        defaultValue: '10',
        description: 'Rolling window trade rate limit',
      },
      {
        name: 'MIN_WALLET_BUFFER_SOL',
        label: 'Min Wallet Buffer (SOL)',
        type: 'number',
        defaultValue: '0.05',
        description: 'Minimum SOL kept as gas buffer',
      },
      {
        name: 'MAX_HOLD_DURATION_SECONDS',
        label: 'Max Hold Duration (s)',
        type: 'number',
        defaultValue: '20',
        description: 'Force-sell after this many seconds (0 = disabled)',
        hint: '0 = disabled',
      },
    ],
  },
  {
    id: 'transaction',
    label: 'Transaction Execution',
    description: 'How transactions are built and sent to the network',
    vars: [
      {
        name: 'TRANSACTION_EXECUTOR',
        label: 'Executor Type',
        type: 'select',
        defaultValue: 'default',
        description: 'Transaction executor (jito recommended for MEV protection)',
        options: ['default', 'warp', 'jito'],
      },
      {
        name: 'COMPUTE_UNIT_LIMIT',
        label: 'Compute Unit Limit',
        type: 'number',
        defaultValue: '101337',
        description: 'Compute units per transaction',
      },
      {
        name: 'COMPUTE_UNIT_PRICE',
        label: 'Compute Unit Price',
        type: 'number',
        defaultValue: '421197',
        description: 'Price per compute unit (microLamports)',
      },
      {
        name: 'CUSTOM_FEE',
        label: 'Custom Fee (SOL)',
        type: 'number',
        defaultValue: '0.006',
        description: 'Fee for warp/jito executors',
      },
      {
        name: 'MAX_BUY_RETRIES',
        label: 'Max Buy Retries',
        type: 'number',
        defaultValue: '10',
        description: 'Max retry attempts for buys',
      },
      {
        name: 'MAX_SELL_RETRIES',
        label: 'Max Sell Retries',
        type: 'number',
        defaultValue: '10',
        description: 'Max retry attempts for sells',
      },
    ],
  },
  {
    id: 'execution_quality',
    label: 'Execution Quality',
    description: 'Simulation, dynamic fees, and fallback settings',
    vars: [
      {
        name: 'SIMULATE_TRANSACTION',
        label: 'Simulate Transactions',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Simulate before sending (recommended)',
      },
      {
        name: 'USE_DYNAMIC_FEE',
        label: 'Use Dynamic Fee',
        type: 'boolean',
        defaultValue: 'false',
        description: 'Estimate priority fees from network',
      },
      {
        name: 'PRIORITY_FEE_PERCENTILE',
        label: 'Priority Fee Percentile',
        type: 'number',
        defaultValue: '75',
        description: 'Percentile of recent fees to use',
        hint: '0-100',
      },
      {
        name: 'MIN_PRIORITY_FEE',
        label: 'Min Priority Fee',
        type: 'number',
        defaultValue: '10000',
        description: 'Minimum priority fee (microLamports)',
      },
      {
        name: 'MAX_PRIORITY_FEE',
        label: 'Max Priority Fee',
        type: 'number',
        defaultValue: '1000000',
        description: 'Maximum priority fee (microLamports)',
      },
      {
        name: 'USE_FALLBACK_EXECUTOR',
        label: 'Use Fallback Executor',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Fall back from jito to default on failure',
      },
      {
        name: 'JITO_BUNDLE_TIMEOUT',
        label: 'Jito Bundle Timeout (ms)',
        type: 'number',
        defaultValue: '60000',
        description: 'How long to wait for bundle confirmation',
      },
      {
        name: 'JITO_BUNDLE_POLL_INTERVAL',
        label: 'Jito Poll Interval (ms)',
        type: 'number',
        defaultValue: '2000',
        description: 'How often to check bundle status',
      },
    ],
  },
  {
    id: 'filters',
    label: 'Pump.fun Filters',
    description: 'Token filtering based on bonding curve state',
    vars: [
      {
        name: 'PUMPFUN_MIN_SOL_IN_CURVE',
        label: 'Min SOL in Curve',
        type: 'number',
        defaultValue: '5',
        description: 'Minimum SOL in bonding curve to buy',
      },
      {
        name: 'PUMPFUN_MAX_SOL_IN_CURVE',
        label: 'Max SOL in Curve',
        type: 'number',
        defaultValue: '300',
        description: 'Max SOL in curve (avoids near-graduation)',
      },
      {
        name: 'PUMPFUN_ENABLE_MIN_SOL_FILTER',
        label: 'Enable Min SOL Filter',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Require minimum SOL in curve',
      },
      {
        name: 'PUMPFUN_ENABLE_MAX_SOL_FILTER',
        label: 'Enable Max SOL Filter',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Reject near-graduation tokens',
      },
      {
        name: 'PUMPFUN_MIN_SCORE_REQUIRED',
        label: 'Min Score Required',
        type: 'number',
        defaultValue: '0',
        description: 'Minimum quality score (0-100)',
        hint: '0-100',
      },
      {
        name: 'MAX_TOKEN_AGE_SECONDS',
        label: 'Max Token Age (s)',
        type: 'number',
        defaultValue: '300',
        description: 'Max token age to be considered new',
        hint: '120=conservative, 300=standard, 600=aggressive',
      },
    ],
  },
  {
    id: 'momentum',
    label: 'Momentum Gate',
    description: 'Validates buy momentum before purchasing (Pipeline Stage 4)',
    vars: [
      {
        name: 'MOMENTUM_GATE_ENABLED',
        label: 'Momentum Gate Enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Enable momentum validation before buying',
      },
      {
        name: 'MOMENTUM_INITIAL_DELAY_SECONDS',
        label: 'Initial Delay (s)',
        type: 'number',
        defaultValue: '0.1',
        description: 'Wait before first momentum check',
      },
      {
        name: 'MOMENTUM_MIN_TOTAL_BUYS',
        label: 'Min Total Buys',
        type: 'number',
        defaultValue: '10',
        description: 'Minimum buy transactions required',
      },
      {
        name: 'MOMENTUM_RECHECK_INTERVAL_SECONDS',
        label: 'Recheck Interval (s)',
        type: 'number',
        defaultValue: '0.1',
        description: 'Wait between recheck attempts',
      },
      {
        name: 'MOMENTUM_MAX_CHECKS',
        label: 'Max Checks',
        type: 'number',
        defaultValue: '5',
        description: 'Max recheck attempts before rejecting',
      },
    ],
  },
  {
    id: 'operational',
    label: 'Operational Settings',
    description: 'Server ports, data directory, and dashboard config',
    vars: [
      {
        name: 'HEALTH_PORT',
        label: 'Health Port',
        type: 'number',
        defaultValue: '8080',
        description: 'Health check server port',
      },
      {
        name: 'DATA_DIR',
        label: 'Data Directory',
        type: 'string',
        defaultValue: './data',
        description: 'Directory for SQLite database and persistent data',
      },
      {
        name: 'DASHBOARD_ENABLED',
        label: 'Dashboard Enabled',
        type: 'boolean',
        defaultValue: 'true',
        description: 'Enable the web dashboard',
      },
      {
        name: 'DASHBOARD_PORT',
        label: 'Dashboard Port',
        type: 'number',
        defaultValue: '3000',
        description: 'Internal dashboard server port',
      },
      {
        name: 'DASHBOARD_POLL_INTERVAL',
        label: 'Dashboard Poll Interval (ms)',
        type: 'number',
        defaultValue: '5000',
        description: 'Client-side polling interval',
      },
      {
        name: 'DASHBOARD_PASSWORD',
        label: 'Dashboard Password',
        type: 'string',
        defaultValue: '',
        description: 'Optional password for dashboard auth',
        sensitive: true,
        placeholder: 'Leave empty for no auth',
      },
    ],
  },
  {
    id: 'testing',
    label: 'Testing & Time Limits',
    description: 'Smoke test, A/B test, and production time limit settings',
    vars: [
      {
        name: 'SMOKE_TEST_TIMEOUT_MINUTES',
        label: 'Smoke Test Timeout (min)',
        type: 'number',
        defaultValue: '5',
        description: 'How long smoke test waits for a token',
      },
      {
        name: 'AB_TEST_DURATION_MINUTES',
        label: 'A/B Test Duration (min)',
        type: 'number',
        defaultValue: '240',
        description: 'Duration of A/B comparison test',
      },
      {
        name: 'AB_CONFIG_A',
        label: 'A/B Config A Path',
        type: 'string',
        defaultValue: '',
        description: 'Config file path for variant A',
        placeholder: './config-a.json',
      },
      {
        name: 'AB_CONFIG_B',
        label: 'A/B Config B Path',
        type: 'string',
        defaultValue: '',
        description: 'Config file path for variant B',
        placeholder: './config-b.json',
      },
      {
        name: 'AB_TEST_DESCRIPTION',
        label: 'A/B Test Description',
        type: 'string',
        defaultValue: '',
        description: 'Description of what this A/B test is comparing',
      },
      {
        name: 'PRODUCTION_TIME_LIMIT_MINUTES',
        label: 'Production Time Limit (min)',
        type: 'number',
        defaultValue: '0',
        description: 'Auto-shutdown after N minutes (0 = infinite)',
        hint: '0 = runs forever',
      },
    ],
  },
  {
    id: 'railway',
    label: 'Railway Deployment',
    description: 'Railway API credentials for pushing config updates and restarting the bot from the dashboard',
    vars: [
      {
        name: 'RAILWAY_API_TOKEN',
        label: 'Railway API Token',
        type: 'string',
        defaultValue: '',
        description: 'API token from Railway (Account Settings > Tokens)',
        sensitive: true,
        placeholder: 'your-railway-api-token',
      },
      {
        name: 'RAILWAY_PROJECT_ID',
        label: 'Railway Project ID',
        type: 'string',
        defaultValue: '',
        description: 'Project ID (from Railway dashboard URL or Settings)',
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      {
        name: 'RAILWAY_ENVIRONMENT_ID',
        label: 'Railway Environment ID',
        type: 'string',
        defaultValue: '',
        description: 'Environment ID (from Railway dashboard URL)',
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
      {
        name: 'RAILWAY_SERVICE_ID',
        label: 'Railway Service ID',
        type: 'string',
        defaultValue: '',
        description: 'Service ID (from Railway dashboard URL)',
        placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
      },
    ],
  },
];

/**
 * Get a flat list of all env var names
 */
export function getAllEnvVarNames(): string[] {
  const names: string[] = [];
  for (const cat of ENV_CATEGORIES) {
    for (const v of cat.vars) {
      names.push(v.name);
    }
  }
  return names;
}

/**
 * Get the set of non-sensitive variable names that are allowed
 * to be pushed to Railway via the dashboard. Sensitive variables
 * (private keys, API tokens, passwords) are excluded.
 */
export function getAllowedPushVarNames(): Set<string> {
  const allowed = new Set<string>();
  for (const cat of ENV_CATEGORIES) {
    for (const v of cat.vars) {
      if (!v.sensitive) {
        allowed.add(v.name);
      }
    }
  }
  return allowed;
}

/**
 * Get current values for all non-sensitive env vars.
 * Sensitive variables (keys, passwords, RPC endpoints with API keys)
 * are completely excluded - never sent to the client.
 */
export function getCurrentEnvValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const cat of ENV_CATEGORIES) {
    for (const v of cat.vars) {
      if (v.sensitive) continue; // completely exclude sensitive vars
      const raw = process.env[v.name];
      if (raw !== undefined && raw !== '') {
        values[v.name] = raw;
      }
    }
  }
  return values;
}
