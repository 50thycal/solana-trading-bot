# Solana Sniper Trading Bot — North Star Document

## Purpose

This document defines the **intended final behavior and scope** of the Solana Sniper Trading Bot. It serves as a **single source of truth** that Claude should always reference when planning, modifying, or auditing the system. Any implementation decisions should align with the intent described here.

The goal is **clarity over cleverness**: a deterministic, observable, and auditable bot that detects new token launches, evaluates them via filters, executes trades when conditions are met, tracks positions, and exits positions according to defined logic.

---

## High-Level Objective

Build a **profitable, reliable pump.fun-first sniper bot** that:

1. Detects **newly launched tokens** on pump.fun bonding curves as early as possible
2. Normalizes token metadata into a single internal "CandidateToken" shape
3. Runs tokens through a **filtering and risk evaluation pipeline**
4. Automatically executes buy orders when criteria are met
5. Tracks open positions with continuous monitoring
6. Executes sell rules (TP/SL/time-based)
7. Logs all activity with full transparency for debugging and iteration

---

## Current Focus: pump.fun-First Pipeline

**PUMP_FUN_ONLY_MODE is ENABLED by default.**

This means the bot runs a single, focused pipeline:

```
pump.fun detection → safety checks → buy → position monitor → sell → record/log outcome
```

All other detection systems (Raydium AmmV4, CPMM, Meteora DLMM, Helius Mint) are **disabled but preserved** for future expansion. They can be re-enabled by setting `PUMP_FUN_ONLY_MODE=false`.

---

## Core Philosophy

* **Single pipeline focus**: One detection source, one execution path, one position manager
* **Event-driven first**: WebSockets over polling wherever possible
* **Deterministic decision-making**: Every buy/sell must be explainable via logged rules
* **Safety > speed** (but still fast): Avoid obvious rugs, exploits, and bad launches
* **Observability**: If something happens, it should be visible in logs and dashboards
* **Iterative improvement**: Get one thing working well before expanding scope

---

## System Lifecycle (End-to-End)

### 1. Token Discovery (pump.fun)

The bot listens for **new bonding curve creation events** on pump.fun using WebSocket subscription to the pump.fun program logs.

**Detection Source**: `listeners/pumpfun-listener.ts`
- Monitors pump.fun program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- Detects "Create" instructions that signal new token launches
- Extracts: mint address, bonding curve PDA, creator, metadata (name, symbol, uri)

All discovery events are normalized into a **DetectedToken** interface.

---

### 2. Safety Checks & Filtering

Before any buy is executed, the token must pass multiple safety gates:

**Gate 1: Deduplication**
- Check if bonding curve already processed (seen_pools table)
- Check if we already have an open position for this token
- Check if there's a pending trade in progress

**Gate 2: Blacklist**
- Token mint blacklist check
- Creator/deployer blacklist check

**Gate 3: Risk Exposure**
- Total exposure limit check (MAX_TOTAL_EXPOSURE_SOL)
- Hourly trade rate limit (MAX_TRADES_PER_HOUR)
- Wallet balance buffer requirement (MIN_WALLET_BUFFER_SOL)

**Gate 4: Bonding Curve Verification**
- Verify bonding curve state is accessible
- Check token hasn't graduated (complete flag)

Each gate **logs its decision** with structured data.

---

### 3. Trade Execution (Buy)

When a token passes all safety checks:

1. Record that we're attempting this buy (seen_pools)
2. Execute buy on pump.fun bonding curve via `buyOnPumpFun()`
3. On success:
   - Record position in SQLite (state_store)
   - Record in P&L tracker
   - Add to exposure manager
   - Add to pump.fun position monitor
4. On failure:
   - Log error with details
   - Record failed attempt in dashboard

**Configuration:**
- `QUOTE_AMOUNT`: SOL amount per trade
- `BUY_SLIPPAGE`: Maximum acceptable slippage (BPS)
- `COMPUTE_UNIT_LIMIT` / `COMPUTE_UNIT_PRICE`: Transaction fees

---

### 4. Position Tracking

Every bought position is tracked in:

1. **SQLite State Store** (`persistence/state-store.ts`)
   - Position entry details
   - Current status (open/closed)
   - Exit details when sold

2. **Exposure Manager** (`risk/exposure-manager.ts`)
   - Real-time exposure tracking
   - Position value updates

3. **pump.fun Position Monitor** (`risk/pumpfun-position-monitor.ts`)
   - Continuous TP/SL monitoring
   - Uses bonding curve state for price calculation

---

### 5. Sell Logic & Exit

The pump.fun position monitor checks positions on an interval and triggers sells when conditions are met:

**Trigger Conditions:**
- **Take Profit**: PnL % >= TAKE_PROFIT
- **Stop Loss**: PnL % <= -STOP_LOSS
- **Time Exit**: Hold duration >= MAX_HOLD_DURATION_MS (if enabled)
- **Graduation**: Token graduated from bonding curve

**Execution:**
1. Calculate current token value via bonding curve math
2. Determine trigger condition
3. Execute sell via `sellOnPumpFun()`
4. Update all tracking systems
5. Log final P&L

---

### 6. Logging & Observability

**Logging is mandatory and comprehensive.**

Every token gets a clear timeline:
- Detection timestamp and source
- Safety check results (pass/fail with reasons)
- Buy execution (success/fail, signature, amounts)
- Position monitoring events
- Sell execution (trigger type, signature, final P&L)

**Structured Logging:**
- All logs are JSON-formatted via Pino
- Key fields: mint, poolId, action, reason, signature, pnlPercent

**Dashboard:**
- Web UI for real-time monitoring
- Pool detection event log
- Position status overview
- P&L summary

**Heartbeat:**
- 5-minute interval stats logging
- Detection counts per platform
- Open position count
- Mint cache statistics

---

## Guardrails

### Do Not Trade If Unsure
- Missing bonding curve state → skip
- Blacklisted token/creator → skip
- Exposure limit exceeded → skip
- Any safety check failure → skip with logged reason

### Keep Risk Exposure Bounded
- `MAX_TOTAL_EXPOSURE_SOL`: Maximum SOL deployed at any time
- `MAX_TRADES_PER_HOUR`: Rate limiting
- `MIN_WALLET_BUFFER_SOL`: Always keep reserve in wallet
- All configurable via environment variables

### Avoid Duplicate Trades
- Track seen bonding curves in SQLite
- Check for existing open position before buy
- Check for pending trades (idempotency)

---

## Minimum Viability Definition

The bot is minimally viable when it can:

1. **Detect** a new pump.fun token launch
2. **Filter** it through safety checks
3. **Buy** with small fixed sizing
4. **Monitor** the position continuously
5. **Sell** when TP/SL/time conditions are met
6. **Log** the complete lifecycle with clear reasoning

The bot must complete at least one full trade loop (buy → hold → sell) safely and produce a clear log of:
- Why it bought (passed all checks)
- What it bought (token, amount, price)
- Why it sold (which trigger)
- The result (profit/loss in SOL and %)

---

## Configuration Reference

### Mode Control
```env
PUMP_FUN_ONLY_MODE=true       # Focus on pump.fun only (default: true)
DRY_RUN=false                  # Log without executing (default: false)
```

### Trading
```env
QUOTE_AMOUNT=0.01              # SOL per trade
BUY_SLIPPAGE=20                # Max slippage %
SELL_SLIPPAGE=30               # Max slippage %
```

### Risk Controls
```env
MAX_TOTAL_EXPOSURE_SOL=0.5     # Max total deployed
MAX_TRADES_PER_HOUR=10         # Rate limit
MIN_WALLET_BUFFER_SOL=0.05     # Wallet reserve
```

### Exit Rules
```env
TAKE_PROFIT=40                 # TP threshold %
STOP_LOSS=20                   # SL threshold %
MAX_HOLD_DURATION_MS=0         # Time exit (0=disabled)
PRICE_CHECK_INTERVAL=2000      # Monitor interval ms
```

---

## Non-Goals (For Now)

The following are **explicitly out of scope** while in pump.fun-first mode:

- Multi-DEX detection (Raydium, Meteora)
- CPMM/AMM/DLMM pool trading
- Helius mint detection
- Social sentiment analysis
- Complex strategy optimization
- Autonomous parameter tuning

These can be re-enabled later by setting `PUMP_FUN_ONLY_MODE=false`.

---

## Future Expansion Path

When pump.fun pipeline is stable and profitable:

1. **Phase 1**: Re-enable Raydium AmmV4 detection
2. **Phase 2**: Add CPMM support
3. **Phase 3**: Add Meteora DLMM support
4. **Phase 4**: Advanced filtering (social signals, holder analysis)
5. **Phase 5**: Strategy optimization and backtesting

Each phase should only begin when the previous is stable.

---

## Guiding Principle for Claude

When in doubt:

> **Favor clarity, safety, and observability over speed or complexity.**
> **Complete one pipeline well before expanding scope.**

Any architectural or implementation decision should be justified by how well it supports the pump.fun-first lifecycle defined above.

---

## File Reference

### Core Pipeline
- `index.ts` - Main entry point, event handlers
- `listeners/pumpfun-listener.ts` - pump.fun detection
- `helpers/pumpfun.ts` - Buy/sell transaction builders
- `risk/pumpfun-position-monitor.ts` - Position monitoring

### Shared Infrastructure
- `persistence/state-store.ts` - SQLite database
- `risk/exposure-manager.ts` - Risk limits
- `risk/pnl-tracker.ts` - P&L recording
- `risk/blacklist.ts` - Token/creator blacklists
- `filters/pool-filters.ts` - Filter chain (for future use)

### Configuration
- `helpers/config-validator.ts` - Environment validation
- `helpers/constants.ts` - Exported config values
- `.env` - Runtime configuration
