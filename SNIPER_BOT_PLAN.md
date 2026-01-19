# Solana Sniper Bot Implementation Plan

> **Status:** Phase 4 Complete
> **Base Repo:** warp-solana-bot v2.0.1
> **Target Deployment:** Railway
> **RPC Provider:** Helius

---

## Executive Summary

This document outlines the staged upgrade plan to evolve the existing Warp Solana Trading Bot into a production-grade sniper bot. The plan is based on a thorough audit of the current codebase and addresses gaps in reliability, risk controls, persistence, execution quality, and monitoring.

**Key Constraints:**
- Helius RPC with WebSocket support
- Initial capital: 0.01 SOL per trade, 0.25-0.5 SOL max exposure
- Persistent stop-loss (no time limit)
- Jito executor recommended for MEV protection
- Strict filters by default
- Discord notifications
- SQLite persistence for Railway

---

## Table of Contents

1. [Current Codebase Summary](#1-current-codebase-summary)
2. [Sniping Strategy Surface Area](#2-sniping-strategy-surface-area)
3. [Identified Gaps](#3-identified-gaps)
4. [Implementation Phases](#4-implementation-phases)
   - [Phase 0: Configuration Foundation](#phase-0-configuration-foundation)
   - [Phase 1: Stability & Resilience](#phase-1-stability--resilience)
   - [Phase 2: Risk Controls](#phase-2-risk-controls)
   - [Phase 3: Persistence & Recovery](#phase-3-persistence--recovery)
   - [Phase 4: Execution Quality](#phase-4-execution-quality)
   - [Phase 5: Notifications & Monitoring](#phase-5-notifications--monitoring)
5. [File Change Map](#5-file-change-map)
6. [Environment Variables Reference](#6-environment-variables-reference)
7. [Dockerfile](#7-dockerfile)

---

## 1. Current Codebase Summary

### Architecture Overview

**Project:** `warp-solana-bot` v2.0.1
**Stack:** TypeScript (ts-node), 27 source files across 6 modules
**DEX Support:** Raydium AmmV4 **only** (no Jupiter, Orca, or aggregator routing)

```
├── index.ts              # Entry point, event orchestration
├── bot.ts                # Core buy/sell/swap logic, filter matching
├── listeners/            # WebSocket subscriptions (pools, markets, wallet)
├── filters/              # Pool validation (burn, renounce, metadata, size)
├── transactions/         # Execution backends (default RPC, Warp, Jito)
├── cache/                # In-memory caches (market, pool, snipe-list)
└── helpers/              # Config, wallet, logging, utilities
```

### Runtime Flow

```
npm run start
    ↓
Load config from .env → validate wallet has quote token ATA
    ↓
Optional: PRE_LOAD_EXISTING_MARKETS (fetches all OpenBook markets)
    ↓
Subscribe to 3 WebSocket streams:
  ├─ Raydium AmmV4 pools (LIQUIDITY_STATE_LAYOUT_V4)
  ├─ OpenBook markets (for pool key construction)
  └─ Wallet token accounts (for auto-sell trigger)
    ↓
Event loop:
  • Pool detected → check if new → run filters → buy()
  • Wallet balance changed → sell() with price monitoring
```

### Transaction Execution Options

| Executor | How It Works | Fee Model |
|----------|--------------|-----------|
| `default` | Standard RPC `sendRawTransaction` | Compute units (`COMPUTE_UNIT_PRICE`) |
| `warp` | Sends to `tx.warp.id` hosted service | Fixed SOL fee to Warp wallet |
| `jito` | Bundles to 5 regional Jito endpoints | Tip to random validator from 8 accounts |

---

## 2. Sniping Strategy Surface Area

### Pool Detection

- **Mechanism:** Real-time WebSocket subscription to `MAINNET_PROGRAM_ID.AmmV4`
- **Filtering criteria:**
  - Quote mint matches configured token (WSOL/USDC)
  - Market program is OpenBook
  - Pool status byte = 6 (operational)
  - `poolOpenTime > runTimestamp` (only NEW pools after bot start)

### Safety Filters (Parallel Execution, All Must Pass)

| Filter | Purpose | Config Flag |
|--------|---------|-------------|
| `BurnFilter` | LP tokens supply = 0 | `CHECK_IF_BURNED` |
| `RenouncedFreezeFilter` | Mint authority renounced, no freeze authority | `CHECK_IF_MINT_IS_RENOUNCED`, `CHECK_IF_FREEZABLE` |
| `MutableFilter` | Metadata immutable, has social links | `CHECK_IF_MUTABLE`, `CHECK_IF_SOCIALS` |
| `PoolSizeFilter` | Quote vault within min/max range | `MIN_POOL_SIZE`, `MAX_POOL_SIZE` |

**Consecutive Match System:** Filters must pass N times consecutively within a time window (reduces false positives from transient states).

### Auto Buy Logic

- Configurable delay before buy (`AUTO_BUY_DELAY`)
- Fixed buy amount per token (`QUOTE_AMOUNT`)
- Slippage tolerance (`BUY_SLIPPAGE`, default 20%)
- Retry loop (`MAX_BUY_RETRIES`, default 10)
- Mutex lock option (`ONE_TOKEN_AT_A_TIME`)

### Auto Sell Logic

- Triggered by wallet token account change detection
- Price monitoring loop with `PRICE_CHECK_INTERVAL` over `PRICE_CHECK_DURATION`
- **Take Profit:** Exits when price reaches +N% (`TAKE_PROFIT`)
- **Stop Loss:** Exits when price drops -N% (`STOP_LOSS`)
- Closes token account after sell (recovers rent)

### Alternative Mode: Snipe List

- `USE_SNIPE_LIST=true` bypasses all filters
- Reads token mints from `snipe-list.txt`
- File auto-reloads every `SNIPE_LIST_REFRESH_INTERVAL`

---

## 3. Identified Gaps

### Reliability Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| No RPC rate limiting | Relies on delays/timeouts only | Will get 429'd by public RPCs under load |
| No connection recovery | Single WebSocket connection, no reconnect logic | Bot dies silently on disconnect |
| No health checks | No heartbeat, no liveness probe | Can't detect zombie state |
| No transaction confirmation backoff | Fixed polling, no exponential backoff | Wastes RPC calls |
| Single-threaded pool processing | Events processed sequentially | Misses fast pools during filter execution |

### Risk Control Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| No max daily/hourly exposure | Unlimited trades if pools keep appearing | Can drain wallet on rug factory days |
| No per-token position cap | Buys full `QUOTE_AMOUNT` every time | No diversification control |
| No blacklist | Can't exclude known scam creators | Vulnerable to repeat rugs |
| No profit/loss tracking | Logs but doesn't aggregate | No session P&L visibility |
| Stop loss is passive | Only checked during `priceCheckDuration` | If duration expires, no protection |

### Execution Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| No priority fee estimation | Static `COMPUTE_UNIT_PRICE` | Overpays in quiet times, underpays in congestion |
| No transaction simulation | Sends directly | Fails on-chain instead of pre-flight |
| No bundle confirmation | Jito returns bundle ID, but confirmation is basic | Can't distinguish landed vs dropped |
| Single RPC endpoint | One endpoint, no fallback | Single point of failure |

### Monitoring Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| Logs only (no metrics) | Pino logs to stdout | No dashboards, no alerts |
| No trade history persistence | In-memory only | Loses history on restart |
| No external notification | No Discord/Telegram webhooks | Can't alert on trades or errors |
| No wallet balance monitoring | Only validates on startup | Won't know when funds run low |

### Configuration Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| No config validation | Trusts all env vars | Silent failures on typos |
| No runtime config reload | Requires restart | Can't tune without downtime |
| No multi-wallet support | Single `PRIVATE_KEY` | Can't spread risk across wallets |

### Testing Gaps

| Gap | Current State | Impact |
|-----|---------------|--------|
| No unit tests | Zero test files | Can't verify filter logic |
| No integration tests | No devnet/localnet testing | Changes go straight to mainnet |
| No simulation mode | Always trades for real | Can't paper trade |

---

## 4. Implementation Phases

### Phase 0: Configuration Foundation

**Goal:** Establish a robust configuration system before touching any logic.

#### 0.1 Environment Validation Layer

Create `helpers/config-validator.ts`:
- Validates all required env vars at startup
- Provides typed config object with defaults
- Fails fast with actionable error messages

#### 0.2 Dry Run / Paper Trading Mode

When `DRY_RUN=true`:
- All transaction executors log what they *would* send but don't submit
- Track "virtual" positions and P&L
- Useful for testing filters and logic without risk

#### 0.3 Filter Preset System

```
FILTER_PRESET=strict | balanced | aggressive | custom
```

| Preset | Burned LP | Renounced Mint | No Freeze | Immutable | Socials | Pool Size |
|--------|-----------|----------------|-----------|-----------|---------|-----------|
| `strict` | Required | Required | Required | Required | Required | 5-50 SOL |
| `balanced` | Required | Required | Required | Optional | Optional | 2-100 SOL |
| `aggressive` | Optional | Required | Required | Skip | Skip | 1-500 SOL |
| `custom` | Use individual `CHECK_IF_*` flags |

---

### Phase 1: Stability & Resilience

**Goal:** Bot runs reliably on Railway without manual intervention.

#### 1.1 WebSocket Reconnection

Wrap subscription setup in reconnection handler with exponential backoff:
- Detect disconnects
- Exponential backoff reconnect (1s, 2s, 4s, 8s...)
- Max 10 attempts before exit (Railway will restart)

#### 1.2 RPC Failover

New `helpers/rpc-manager.ts`:
- Parse comma-separated endpoints
- Track endpoint health (success/failure counts)
- Rotate to next endpoint on failure
- Provide `getConnection()` that returns healthy connection

#### 1.3 Health Check Endpoint

New `health.ts`:
- Minimal HTTP server on port 8080
- `/health` endpoint returns 200 if healthy, 503 if not
- Checks: WebSocket connected, last activity recent

#### 1.4 Graceful Shutdown

Handle SIGTERM from Railway:
- Unsubscribe from all WebSocket streams
- Save state to persistence layer
- Exit cleanly

#### 1.5 Structured Logging

Enhancements to existing Pino logging:
- Add `correlationId` to all logs for a trade
- Add structured fields for machine parsing
- Configure log level via `LOG_LEVEL` env var

---

### Phase 2: Risk Controls

**Goal:** Prevent the bot from draining your wallet through bugs or bad market conditions.

#### 2.1 Exposure Tracking & Limits

New `risk/exposure-manager.ts`:
- Track `totalDeployedSol` across open positions
- Track `tradesThisHour` rolling count
- Block trades when limits exceeded

#### 2.2 Blacklist System

New `risk/blacklist.ts`:
- Load from `data/blacklist.json`
- Support both token mints and creator addresses
- Check before other filters run

#### 2.3 Persistent Stop-Loss Monitoring

**Current problem:** Stop-loss monitoring ends after `PRICE_CHECK_DURATION`.

**Solution:** New `risk/position-monitor.ts`:
- Decouple monitoring from buy flow
- Monitor indefinitely until TP, SL, or manual intervention
- Optional `MAX_HOLD_DURATION` for time-based exit (disabled by default)

#### 2.4 Wallet Balance Guard

Before each buy, verify:
- Enough SOL for trade + gas
- Buffer for recovery (`MIN_WALLET_BUFFER_SOL`)

#### 2.5 P&L Tracking

New `risk/pnl-tracker.ts`:
- Record all trades with prices
- Calculate realized P&L on sells
- Calculate unrealized P&L on open positions
- Provide session summary

---

### Phase 3: Persistence & Recovery

**Goal:** Bot can restart without losing state or double-entering positions.

#### 3.1 State Persistence Layer

New `persistence/state-store.ts` with SQLite (`better-sqlite3`):

```sql
CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  token_mint TEXT UNIQUE NOT NULL,
  entry_price REAL NOT NULL,
  amount_token REAL NOT NULL,
  amount_sol REAL NOT NULL,
  entry_timestamp INTEGER NOT NULL,
  pool_id TEXT NOT NULL,
  status TEXT DEFAULT 'open'
);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  position_id TEXT,
  type TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  amount_sol REAL NOT NULL,
  amount_token REAL NOT NULL,
  price REAL NOT NULL,
  timestamp INTEGER NOT NULL,
  tx_signature TEXT,
  status TEXT NOT NULL
);

CREATE TABLE seen_pools (
  pool_id TEXT PRIMARY KEY,
  token_mint TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  action_taken TEXT
);

CREATE TABLE blacklist (
  address TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  reason TEXT,
  added_timestamp INTEGER NOT NULL
);
```

#### 3.2 Startup Recovery Flow

On startup:
1. Load all positions with `status='open'`
2. Verify token still in wallet
3. Resume monitoring if present, mark closed if absent
4. Load `seen_pools` into memory cache

#### 3.3 Idempotent Trade Recording

Record trade intent BEFORE sending, update status after:
1. Check if already have position
2. Record pending trade
3. Execute transaction
4. Update status (confirmed/failed)

#### 3.4 Railway Volume Configuration

Configure persistent volume in Railway dashboard for `./data` directory.

---

### Phase 4: Execution Quality

**Goal:** Land transactions reliably with appropriate fees and MEV protection.

#### 4.1 Transaction Simulation

Before sending any transaction:
```typescript
const simulation = await connection.simulateTransaction(transaction);
if (simulation.value.err) {
  return { confirmed: false, error: 'Simulation failed' };
}
```

Benefits: Catch errors before paying fees, faster feedback loop.

#### 4.2 Dynamic Priority Fee Estimation

New `helpers/fee-estimator.ts`:
- Query `getRecentPrioritizationFees()`
- Use configurable percentile (default 75th)
- Apply min/max bounds

#### 4.3 Executor Selection & Fallback

**Recommended:** `TRANSACTION_EXECUTOR=jito`

Implement fallback chain:
1. Jito (primary, MEV-protected)
2. Default RPC (fallback with elevated priority fee)

#### 4.4 Jito Bundle Confirmation

Enhance `jito-rpc-transaction-executor.ts`:
- Poll `getBundleStatuses` after submission
- Distinguish landed vs dropped
- Proper confirmation before returning

#### 4.5 Pre-Compute Transaction During Filter Check

While filters run, prepare transaction in parallel:
- Start filter check and tx preparation concurrently
- If filters pass, immediately send pre-prepared transaction
- Refresh blockhash if filters take too long

---

### Phase 5: Notifications & Monitoring

**Goal:** Know what the bot is doing without watching logs.

#### 5.1 Notification Architecture

New `notifications/notifier.ts`:
```typescript
interface Notifier {
  notify(event: NotificationEvent): Promise<void>;
}

interface NotificationEvent {
  type: 'trade_buy' | 'trade_sell' | 'error' | 'warning' | 'info';
  title: string;
  fields: Record<string, string>;
  severity: 'info' | 'warning' | 'critical';
}
```

#### 5.2 Discord Webhook Integration

New `notifications/discord-notifier.ts`:
- Format events as Discord embeds
- Color-code by severity
- Include relevant fields (token, amount, tx link, etc.)

#### 5.3 Notification Events

| Event | When | Severity |
|-------|------|----------|
| `bot_started` | Startup complete | info |
| `trade_buy` | Buy confirmed | info |
| `trade_sell` | Sell confirmed | info |
| `take_profit` | TP triggered | info |
| `stop_loss` | SL triggered | warning |
| `filter_rejected` | Pool failed filters | info |
| `tx_failed` | Transaction failed | warning |
| `exposure_limit` | Limit reached | warning |
| `connection_lost` | WebSocket disconnected | critical |
| `connection_restored` | Reconnected | info |
| `low_balance` | Wallet below threshold | critical |

#### 5.4 Session Summary Reports

Periodic summary every 4 hours:
- Uptime
- Trade counts (buys/sells)
- Realized P&L
- Open positions
- Wallet balance

#### 5.5 Telegram Support (Future)

Design for extensibility with `TelegramNotifier` implementing same interface.

---

## 5. File Change Map

### New Files to Create

| File | Phase | Purpose |
|------|-------|---------|
| `helpers/config-validator.ts` | 0 | Env var validation, typed config |
| `helpers/filter-presets.ts` | 0 | Preset definitions |
| `helpers/rpc-manager.ts` | 1 | Multi-endpoint with failover |
| `helpers/fee-estimator.ts` | 4 | Dynamic priority fee calculation |
| `health.ts` | 1 | HTTP health check endpoint |
| `risk/exposure-manager.ts` | 2 | Exposure limits and tracking |
| `risk/blacklist.ts` | 2 | Mint/creator blacklist |
| `risk/pnl-tracker.ts` | 2 | P&L calculation and tracking |
| `risk/position-monitor.ts` | 2 | Persistent stop-loss monitoring |
| `persistence/state-store.ts` | 3 | SQLite wrapper and migrations |
| `persistence/models.ts` | 3 | TypeScript interfaces for DB entities |
| `notifications/notifier.ts` | 5 | Base notification interface |
| `notifications/discord-notifier.ts` | 5 | Discord webhook implementation |
| `Dockerfile` | 1 | Production container build |
| `railway.json` | 1 | Railway deployment config |
| `.env.example` | 0 | Complete env var template |

### Existing Files to Modify

| File | Phase | Changes |
|------|-------|---------|
| `index.ts` | 0-3 | Config validation, recovery flow, graceful shutdown, health server |
| `bot.ts` | 2-4 | Exposure check, simulation, pre-compute optimization |
| `helpers/constants.ts` | 0 | New config constants, filter presets |
| `listeners/listeners.ts` | 1 | Reconnection logic |
| `filters/pool-filters.ts` | 0 | Preset system integration |
| `transactions/default-transaction-executor.ts` | 4 | Simulation before send |
| `transactions/jito-rpc-transaction-executor.ts` | 4 | Bundle status polling |
| `transactions/warp-transaction-executor.ts` | 4 | Simulation before send |

### Files Unchanged

| File | Reason |
|------|--------|
| `filters/burn.filter.ts` | Filter logic is solid |
| `filters/mutable.filter.ts` | Filter logic is solid |
| `filters/renounced.filter.ts` | Filter logic is solid |
| `filters/pool-size.filter.ts` | Filter logic is solid |
| `cache/*.ts` | Caching works well |
| `helpers/market.ts` | Market fetching works |
| `helpers/liquidity.ts` | Pool key construction works |

---

## 6. Environment Variables Reference

```bash
# ═══════════════════════════════════════════════════════════════
# CORE CONFIGURATION
# ═══════════════════════════════════════════════════════════════

# RPC Configuration (Helius)
RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
RPC_WEBSOCKET_ENDPOINT=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
RPC_BACKUP_ENDPOINTS=  # Optional: comma-separated

# Wallet
PRIVATE_KEY=your_base58_private_key

# Mode
DRY_RUN=true
LOG_LEVEL=info

# ═══════════════════════════════════════════════════════════════
# TRADING PARAMETERS
# ═══════════════════════════════════════════════════════════════

QUOTE_MINT=So11111111111111111111111111111111111111112
QUOTE_AMOUNT=0.01
BUY_SLIPPAGE=20
SELL_SLIPPAGE=30
AUTO_BUY_DELAY=0
AUTO_SELL=true
ONE_TOKEN_AT_A_TIME=true
TAKE_PROFIT=40
STOP_LOSS=20
PRICE_CHECK_INTERVAL=2000

# ═══════════════════════════════════════════════════════════════
# RISK CONTROLS
# ═══════════════════════════════════════════════════════════════

MAX_TOTAL_EXPOSURE_SOL=0.5
MAX_TRADES_PER_HOUR=10
MIN_WALLET_BUFFER_SOL=0.05

# ═══════════════════════════════════════════════════════════════
# FILTERS
# ═══════════════════════════════════════════════════════════════

FILTER_PRESET=strict
CHECK_IF_BURNED=true
CHECK_IF_MINT_IS_RENOUNCED=true
CHECK_IF_FREEZABLE=true
CHECK_IF_MUTABLE=true
CHECK_IF_SOCIALS=true
MIN_POOL_SIZE=5
MAX_POOL_SIZE=50
FILTER_CHECK_INTERVAL=2000
FILTER_CHECK_DURATION=60000
CONSECUTIVE_FILTER_MATCHES=3
USE_SNIPE_LIST=false
SNIPE_LIST_REFRESH_INTERVAL=30000

# ═══════════════════════════════════════════════════════════════
# TRANSACTION EXECUTION
# ═══════════════════════════════════════════════════════════════

TRANSACTION_EXECUTOR=jito
COMPUTE_UNIT_LIMIT=101337
COMPUTE_UNIT_PRICE=421197
PRIORITY_FEE_PERCENTILE=75
MIN_PRIORITY_FEE=10000
MAX_PRIORITY_FEE=1000000
CUSTOM_FEE=0.006
MAX_BUY_RETRIES=10
MAX_SELL_RETRIES=10

# ═══════════════════════════════════════════════════════════════
# PERSISTENCE
# ═══════════════════════════════════════════════════════════════

DATA_DIR=./data

# ═══════════════════════════════════════════════════════════════
# NOTIFICATIONS
# ═══════════════════════════════════════════════════════════════

DISCORD_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# ═══════════════════════════════════════════════════════════════
# OPERATIONAL
# ═══════════════════════════════════════════════════════════════

HEALTH_PORT=8080
CACHE_NEW_MARKETS=true
PRE_LOAD_EXISTING_MARKETS=false
```

---

## 7. Dockerfile

```dockerfile
# Build stage
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build 2>/dev/null || true

# Runtime stage
FROM node:20-alpine

RUN addgroup -g 1001 -S botuser && \
    adduser -S botuser -u 1001

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/*.ts ./
COPY --from=builder /app/*.json ./
COPY --from=builder /app/cache ./cache
COPY --from=builder /app/filters ./filters
COPY --from=builder /app/helpers ./helpers
COPY --from=builder /app/listeners ./listeners
COPY --from=builder /app/transactions ./transactions

RUN mkdir -p ./data && chown -R botuser:botuser ./data

USER botuser

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

EXPOSE 8080

CMD ["npx", "ts-node", "--transpile-only", "index.ts"]
```

---

## Next Steps

When ready to begin implementation:

1. **Confirm Helius API key** is available
2. **Choose starting phase** (recommend Phase 0 + Phase 1 together)
3. **Set up Railway project** with persistent volume for `./data`
4. **Provide Discord webhook URL** when ready for notifications

This plan can be executed incrementally. Each phase is designed to be independently deployable and testable.
