# Smoke Test Profitability Analysis - 2026-03-01

## Executive Summary

Across 32 smoke test runs over 24 hours, the bot lost **-0.1667 SOL** total with a
**50% pass rate** (16/32 runs executed a trade). Of the 16 runs that traded, only
**2 hit take profit** (12.5% win rate). The bot is bleeding money due to three
compounding problems: the sniper gate filters too aggressively (50% of runs never
trade), the trailing stop exits too early relative to fee overhead, and fixed
transaction costs eat 12-15% of each 0.02 SOL position.

---

## Data Overview

| Metric | Value |
|--------|-------|
| Total Runs | 32 |
| Runs That Traded | 16 (50%) |
| Runs With Zero Trades | 16 (50%) |
| Total P&L | -0.1667 SOL |
| Best Trade | +0.008928 SOL (Run 3, take_profit) |
| Worst Trade | -0.044387 SOL (Run 15, buy failures) |
| Win Rate (on executed trades) | 3/16 = 18.75% |

### Three Config Phases Tested

| Phase | Runs | Key Changes | Pass Rate | Avg P&L |
|-------|------|-------------|-----------|---------|
| 1 (Runs 1-5) | 5 | SL=20, hold=30s, organic=10, trail_act=20 | 80% | -0.005665 |
| 2 (Runs 6-20) | 15 | SL=15, hold=45s, organic=15, trail_act=10 | 47% | -0.004692 |
| 3 (Runs 21-32) | 12 | SL=10, hold=120s, sniper_delay=300ms | 50% | -0.005497 |

---

## Pattern Analysis

### Pattern 1: Sniper Gate Blocks 50% of Runs

The single biggest issue. 16 of 32 runs evaluated 65-120 tokens each but **zero
passed the full pipeline**. These runs timed out with no trade, exit trigger "unknown".

| Config | MIN_ORGANIC_BUYERS | MAX_CHECKS | No-Trade Rate |
|--------|-------------------|------------|---------------|
| Phase 1 | 10 | 10 | 20% (1/5) |
| Phase 2 | 15 | 20 | 47% (7/15) |
| Phase 3 | 15 | 20 | 42% (5/12) |

**Root cause:** Requiring 15 organic buyers within 20 seconds is extremely
restrictive. Most pump.fun tokens don't accumulate 15 distinct non-bot wallets
that quickly. When the threshold was 10 organic buyers with 10 max checks (Phase 1),
the pass rate was 80%.

The sniper gate's purpose is to avoid buying into sniper-dominated tokens. But at
15 organic buyers, it's filtering out the vast majority of legitimate opportunities.
The bot spends 30-45 minutes per run evaluating tokens and finding nothing.

### Pattern 2: Stop Loss Dominates Exit Distribution

Of the 16 runs that executed trades (excluding buy failure anomalies):

| Exit Trigger | Count | Avg P&L | Total P&L |
|-------------|-------|---------|-----------|
| take_profit | 2 | +0.008296 | +0.016591 |
| stop_loss | 8 | -0.009900 | -0.079201 |
| time_exit | 5 | -0.001965 | -0.009825 |
| unknown (buy failures) | 3 | -0.031410 | -0.094230 |

Stop loss is triggered 4x more often than take profit. The 50% take profit target
is rarely reached, while the 10-15% stop loss is triggered by normal pump.fun volatility.

### Pattern 3: Transaction Fee Overhead is Significant

Analyzing time_exit runs where the token price barely moved reveals the fixed
overhead per round-trip trade:

| Run | P&L | Hold Time | Notes |
|-----|-----|-----------|-------|
| 5 | -0.002745 | 2m50s | Minimal price movement |
| 16 | -0.002936 | 15m41s | Minimal price movement |
| 27 | -0.002295 | 22m7s | Minimal price movement |
| 29 | +0.000842 | 7m27s | Small gain offsetting fees |
| 32 | -0.002691 | 35m58s | Minimal price movement |

**Fixed overhead per round-trip: ~0.0025-0.003 SOL**

On a 0.02 SOL position, this is **12-15% overhead**. Sources:
- Pump.fun protocol fees: 1.25% per side = ~2.5% round trip
- Jito tips / priority fees / gas: remainder
- ATA rent: one-time 0.002 SOL (recoverable)

**Break-even requires ~15% token appreciation just to cover fees.**

### Pattern 4: Trailing Stop Exits Below Break-Even

With `TRAILING_STOP_ACTIVATION_PERCENT=10` and `TRAILING_STOP_DISTANCE_PERCENT=5`:

```
Token goes +10% → trailing stop activates
Token dips to +5% → trailing stop sells

Bonding curve P&L: +5%
After ~15% overhead: NET LOSS of ~-10%
```

The trailing stop can sell at what looks like a "profit" on the bonding curve but
is actually a loss after fees. This is confirmed by the time_exit data showing small
losses even when tokens haven't tanked.

With Phase 1's `TRAILING_STOP_ACTIVATION_PERCENT=20`:
```
Token goes +20% → trail activates
Token dips to +15% → trail sells

Bonding curve P&L: +15%
After ~15% overhead: ~BREAK EVEN
```

Phase 1's higher activation threshold was closer to break-even, which is why
Run 3 hit the best take_profit of +0.008928 SOL.

### Pattern 5: Stop Loss Actual Losses Exceed Expected

| Stop Loss % | Expected Loss | Actual Avg Loss | Actual Worst | Overhead |
|------------|--------------|-----------------|-------------|----------|
| 20% | -0.004 | -0.006880 | -0.006880 | +72% |
| 15% | -0.003 | -0.007678 | -0.011048 | +156% |
| 10% | -0.002 | -0.009449 | -0.026881 | +372% |

The tighter the stop loss, the worse the actual-vs-expected ratio becomes. This is
because the fixed overhead (~0.003 SOL) represents a larger percentage of smaller
stop loss amounts. A 10% SL on 0.02 SOL is only 0.002 SOL of trade loss, but the
overhead nearly doubles it.

Additionally, Run 23 lost -0.026881 SOL at 10% SL, suggesting severe sell-side
slippage. The token may have been dumping so fast that by the time the sell executed,
the price was far below the stop loss trigger point.

### Pattern 6: Buy Failures Are Extremely Costly

Three runs had buy failures that resulted in massive losses:

| Run | Pipeline Passed | Buy Failures | P&L |
|-----|----------------|-------------|-----|
| 2 | 2 | 1 | -0.027626 |
| 15 | 2 | 2 | -0.044387 |
| 22 | 2 | 2 | -0.022217 |

These are the three worst-performing runs. Failed buys waste Jito tips and gas
without acquiring tokens. Combined with any trades that did execute in the same run,
the losses compound.

---

## Root Cause Summary

```
                    WHY IS THE BOT LOSING MONEY?
                    ┌──────────────────────────┐
                    │                          │
           ┌───────┴───────┐          ┌───────┴───────┐
           │ Not Enough    │          │ Losing Trades │
           │ Trades (50%   │          │ When Trading  │
           │ no-trade)     │          │ (88% loss     │
           │               │          │  rate)         │
           └───────┬───────┘          └───────┬───────┘
                   │                          │
        ┌──────────┤              ┌───────────┼────────────┐
        │          │              │           │            │
   Sniper Gate  Tight SL     Fee         Trailing      Token
   too strict   kills on     Overhead    Stop exits    Selection
   (15 organic  volatility   (15% on    below break-  (most pump
   buyers)                   0.02 SOL)  even point    tokens dump)
```

---

## Recommendations

### HIGH IMPACT: Env Variable Changes

#### 1. Loosen the Sniper Gate (Biggest Single Improvement)

```env
SNIPER_GATE_MIN_ORGANIC_BUYERS=5     # was 15 → too restrictive
SNIPER_GATE_MAX_CHECKS=12            # was 20 → 20s wait is too long for pump.fun
```

**Expected impact:** Pipeline pass rate improves from ~50% to ~75-85%. More trading
opportunities means more chances to hit take profit. Even if win rate stays the same,
more attempts = more absolute wins.

Why 5 organic buyers is still safe:
- Eliminates pure sniper-only tokens (0 organic buyers)
- Still requires meaningful non-bot demand
- Phase 1 used 10 and had 80% pass rate; 5 gives even more headroom

#### 2. Increase Position Size to Reduce Fee Overhead

```env
QUOTE_AMOUNT=0.04                    # was 0.02 → doubles position, halves fee %
```

**Expected impact:** Fee overhead drops from ~15% to ~7.5%. Break-even point drops
from ~15% gain to ~7.5% gain. This dramatically improves risk/reward.

On 0.04 SOL with ~0.003 overhead:
- Break-even: ~7.5% gain
- 50% TP net gain: ~42.5% real return (+0.017 SOL)
- 15% SL net loss: ~22.5% real loss (-0.009 SOL)
- Risk/Reward: 1.89:1 (vs 1.4:1 at 0.02 SOL)

Keep MAX_TOTAL_EXPOSURE_SOL=0.3 for safety.

#### 3. Fix Trailing Stop Activation Above Break-Even

```env
TRAILING_STOP_ACTIVATION_PERCENT=25  # was 10 → must exceed fee overhead
TRAILING_STOP_DISTANCE_PERCENT=8     # was 5 → pump.fun needs room to breathe
HARD_TAKE_PROFIT_PERCENT=80          # was 0 → lock in moonshots
```

**Expected impact:** Trailing stop only activates once the trade is safely profitable
after fees. Minimum sell point: 25% - 8% = +17% bonding curve gain, which nets ~+9.5%
real profit after fees. Hard ceiling at 80% prevents round-tripping on massive spikes.

#### 4. Widen Stop Loss

```env
STOP_LOSS=15                         # was 10 → too tight, triggers on normal volatility
```

**Expected impact:** Fewer false stop-outs. The trailing stop handles the upside
protection, so the stop loss only needs to protect against genuine dumps. 15% gives
enough room for initial pump.fun volatility while limiting worst-case loss to ~22.5%
real after fees (at 0.04 SOL position).

#### 5. Shorten Max Hold Duration

```env
MAX_HOLD_DURATION_SECONDS=45         # was 120 → time exits are all losses
```

**Expected impact:** Cuts losing time exits shorter. All time exits in the data are
losses (except Run 29 at +0.000842). If a pump.fun token hasn't moved in 45 seconds,
it's unlikely to pump. Shorter hold = less opportunity cost = faster rotation to
next trade.

#### 6. Lower Jito Tip (Minor)

```env
CUSTOM_FEE=0.004                     # was 0.006 → reduce overhead slightly
```

**Expected impact:** Saves ~0.004 SOL per round-trip (2x tip reduction of 0.002).
Still competitive for Jito bundle inclusion. Reduces overhead from ~15% to ~13%
on 0.02 SOL, or from ~7.5% to ~6.5% on 0.04 SOL.

### MEDIUM IMPACT: Pipeline Changes to Consider

#### 7. Enable Momentum Gate as Pre-Filter

```env
MOMENTUM_GATE_ENABLED=true
MOMENTUM_MIN_TOTAL_BUYS=5            # lower bar than default 10
MOMENTUM_MAX_CHECKS=3                # fast check, ~300ms
```

Running momentum gate BEFORE sniper gate (or as an alternative) could:
- Quickly filter out dead tokens (no buying activity)
- Reduce expensive sniper gate RPC calls
- Faster pipeline = earlier entry = better prices

Note: Currently the pipeline runs EITHER momentum gate OR sniper gate. Consider
running them in sequence (momentum first as cheap pre-filter, then sniper gate
for quality validation).

#### 8. Increase MIN_SOL_IN_CURVE for Better Quality

```env
PUMPFUN_MIN_SOL_IN_CURVE=8           # was 5 → higher liquidity = less slippage
```

Higher SOL in the bonding curve means more liquidity, which means:
- Less buy slippage (better entry price)
- Less sell slippage (better exit price)
- More established token (slightly lower rug risk)

---

## Recommended Optimized Config

```env
# Core
COMMITMENT_LEVEL=confirmed
BOT_MODE=smoke
LOG_LEVEL=info
LOG_FORMAT=pretty

# Trading - CHANGED
QUOTE_MINT=WSOL
QUOTE_AMOUNT=0.04                        # was 0.02 → reduce fee overhead %
BUY_SLIPPAGE=15
SELL_SLIPPAGE=20
AUTO_BUY_DELAY=0
AUTO_SELL=true
AUTO_SELL_DELAY=0
ONE_TOKEN_AT_A_TIME=true
TAKE_PROFIT=50
STOP_LOSS=15                             # was 10 → room for volatility
PRICE_CHECK_INTERVAL_SECONDS=0.05
PRICE_CHECK_DURATION_MINUTES=5

# Risk Controls
MAX_TOTAL_EXPOSURE_SOL=0.3
MAX_TRADES_PER_HOUR=5
MIN_WALLET_BUFFER_SOL=0.05
MAX_HOLD_DURATION_SECONDS=45             # was 120 → cut losers faster

# Transaction Execution - CHANGED
TRANSACTION_EXECUTOR=jito
COMPUTE_UNIT_LIMIT=101337
COMPUTE_UNIT_PRICE=421197
CUSTOM_FEE=0.004                         # was 0.006 → lower overhead
MAX_BUY_RETRIES=10
MAX_SELL_RETRIES=10

# Execution Quality
SIMULATE_TRANSACTION=true
USE_DYNAMIC_FEE=false
PRIORITY_FEE_PERCENTILE=75
MIN_PRIORITY_FEE=10000
MAX_PRIORITY_FEE=1000000
USE_FALLBACK_EXECUTOR=true
JITO_BUNDLE_TIMEOUT=60000
JITO_BUNDLE_POLL_INTERVAL=2000

# Pump.fun Filters - CHANGED
PUMPFUN_MIN_SOL_IN_CURVE=8              # was 5 → better liquidity
PUMPFUN_MAX_SOL_IN_CURVE=300
PUMPFUN_ENABLE_MIN_SOL_FILTER=true
PUMPFUN_ENABLE_MAX_SOL_FILTER=true
PUMPFUN_MIN_SCORE_REQUIRED=0
MAX_TOKEN_AGE_SECONDS=300
PUMPFUN_DETECTION_COOLDOWN_SECONDS=15

# Momentum Gate (disabled, sniper gate is primary)
MOMENTUM_GATE_ENABLED=false
MOMENTUM_INITIAL_DELAY_SECONDS=0.1
MOMENTUM_MIN_TOTAL_BUYS=3
MOMENTUM_RECHECK_INTERVAL_SECONDS=0.5
MOMENTUM_MAX_CHECKS=4

# Sniper Gate - CHANGED (most impactful)
SNIPER_GATE_ENABLED=true
SNIPER_GATE_INITIAL_DELAY_SECONDS=0.3
SNIPER_GATE_RECHECK_INTERVAL_SECONDS=1
SNIPER_GATE_MAX_CHECKS=12               # was 20 → faster decisions
SNIPER_GATE_SNIPER_SLOT_THRESHOLD=4
SNIPER_GATE_MIN_BOT_EXIT_PERCENT=100
SNIPER_GATE_MIN_ORGANIC_BUYERS=5        # was 15 → BIGGEST CHANGE
SNIPER_GATE_LOG_ONLY=false

# Trailing Stop - CHANGED
TRAILING_STOP_ENABLED=true
TRAILING_STOP_ACTIVATION_PERCENT=25      # was 10 → must exceed fee overhead
TRAILING_STOP_DISTANCE_PERCENT=8         # was 5 → more room for volatility
HARD_TAKE_PROFIT_PERCENT=80              # was 0 → lock in moonshots

# Testing
SMOKE_TEST_TIMEOUT_MINUTES=45
SMOKE_TEST_RUNS=5
```

### Change Summary

| Parameter | Old | New | Rationale |
|-----------|-----|-----|-----------|
| QUOTE_AMOUNT | 0.02 | 0.04 | Cut fee overhead from 15% to 7.5% |
| STOP_LOSS | 10 | 15 | Fewer false stop-outs on volatility |
| MAX_HOLD_DURATION_SECONDS | 120 | 45 | Time exits are all losses; cut faster |
| CUSTOM_FEE | 0.006 | 0.004 | Lower Jito tip overhead |
| PUMPFUN_MIN_SOL_IN_CURVE | 5 | 8 | Better liquidity, less slippage |
| SNIPER_GATE_MAX_CHECKS | 20 | 12 | Faster gate decisions |
| SNIPER_GATE_MIN_ORGANIC_BUYERS | 15 | 5 | BIGGEST: unlock 2-3x more trades |
| TRAILING_STOP_ACTIVATION_PERCENT | 10 | 25 | Don't trail below break-even |
| TRAILING_STOP_DISTANCE_PERCENT | 5 | 8 | Room for pump.fun volatility |
| HARD_TAKE_PROFIT_PERCENT | 0 | 80 | Lock in massive gains |

### Expected Improvement

With these changes, the bot should:
1. Trade 75-85% of runs (vs 50% currently)
2. Lose less per losing trade (wider SL but lower fee overhead % at 0.04 SOL)
3. Keep more profit on winning trades (trail activates well above break-even)
4. Lock in moonshot gains via hard TP at 80%
5. Rotate faster via 45s max hold

**Conservative estimate:** From -0.005 SOL avg P&L per run to -0.001 to +0.001 SOL,
depending on market conditions. The key is reducing the no-trade rate and improving
the risk/reward math.

---

## Next Steps

1. Run 10+ smoke tests with the optimized config above
2. Compare pipeline pass rate (target: >75%)
3. Compare win rate on executed trades (target: >25%)
4. If win rate is still low, consider enabling momentum gate as pre-filter
5. If slippage remains high on sells, increase PUMPFUN_MIN_SOL_IN_CURVE to 10-12
6. Track fee breakdown per trade to validate overhead reduction
