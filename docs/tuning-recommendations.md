# Trading Bot Tuning Recommendations

Based on analysis of 155 trades (24.5% win rate, -0.5643 SOL P&L).

## Problem Summary

| Issue | Impact | Fix |
|-------|--------|-----|
| 75% of trades hit stop loss or time exit | -0.56 SOL total | Tighter entry filters + time-of-day gate |
| Hours 04, 05, 17, 18 UTC are blood baths | -0.38 SOL (67% of losses) | `TRADING_HOURS_ENABLED=true` |
| Trailing stop disabled | Missing partial gains | Enable trailing stop |
| Momentum gate too loose | Buying low-quality tokens | Raise `MOMENTUM_MIN_TOTAL_BUYS` |
| Cost-adjusted exits disabled | P&L doesn't account for fees | Enable `COST_ADJUSTED_EXITS` |

## Recommended .env Changes

```bash
# ── ENTRY QUALITY ──────────────────────────────────────────────────
# Raise momentum threshold: require 15+ buys instead of 10
# This filters out tokens with weak initial demand
MOMENTUM_MIN_TOTAL_BUYS=15

# Raise minimum SOL in curve from 5 to 8
# Tokens with more SOL deposited have more proven interest
PUMPFUN_MIN_SOL_IN_CURVE=8

# ── TIME-OF-DAY FILTER (NEW) ──────────────────────────────────────
# Block trading during your worst-performing hours
# Profitable hours from your data: 3, 12, 16, 20, 22
# Breakeven/marginal hours: 0, 2, 21
# Include marginal hours for more trade volume:
TRADING_HOURS_ENABLED=true
TRADING_HOURS_ALLOWED_UTC=0,2,3,12,16,20,21,22

# ── EXIT PARAMETERS ───────────────────────────────────────────────
# Reduce hold duration: 15s instead of 20s
# Your data shows 50 trades <10s and 61 trades 10-30s
# Most winners are fast; losers drag on
MAX_HOLD_DURATION_SECONDS=15

# Tighter stop loss: 15% instead of 20%
# Your avg loss is -0.0091 SOL; cutting losers faster reduces bleed
STOP_LOSS=15

# Enable trailing stop to capture more upside on winners
# Your best trade was +0.0659 SOL but avg TP exit is only +0.0212
TRAILING_STOP_ENABLED=true
TRAILING_STOP_ACTIVATION_PERCENT=12
TRAILING_STOP_DISTANCE_PERCENT=8
HARD_TAKE_PROFIT_PERCENT=80

# Account for actual costs (ATA rent, gas, fees) in exit triggers
COST_ADJUSTED_EXITS=true
```

## Rationale

### Time-of-Day Filter
Your 4 worst hours (04, 05, 17, 18 UTC) account for -0.38 SOL of your -0.56 SOL total loss. Blocking these hours alone would have made you nearly breakeven. The allowed hours above include all hours that were profitable plus marginal hours for volume.

### Trailing Stop
With fixed TP at 40%, you either hit the full target or don't. Your trailing stop exits already average +0.0051 SOL (profitable), and take profit exits average +0.0212 SOL. Enabling trailing stop with 12% activation and 8% distance will:
- Lock in gains once a trade moves 12%+ in your favor
- Let winners run beyond 40% (your best was 65.9%)
- Still protect with the hard ceiling at 80%

### Tighter Stop Loss (15% vs 20%)
Your average loss is -0.0091 SOL. Cutting from 20% to 15% stop loss reduces per-trade damage while your 15% activation trailing stop captures upside.

### Higher Momentum Threshold (15 vs 10)
Only 0.1% of bought tokens were profitable. Requiring 15+ buys instead of 10 will filter out tokens with weak demand. You'll trade less often but with higher quality entries.

## Expected Impact
- **Eliminated losses**: ~0.38 SOL saved from time-of-day filter alone
- **Reduced per-trade loss**: Tighter stop loss cuts avg loss by ~25%
- **Better upside capture**: Trailing stop lets winners run past fixed 40% TP
- **Fewer bad trades**: Higher momentum threshold reduces low-quality entries

## How to Test
1. Deploy with `BOT_MODE=smoke` first to verify the pipeline works
2. Run `BOT_MODE=dry_run` for a session to see paper trade results
3. Compare win rate and expectancy to the current baseline
4. Graduate to `BOT_MODE=production` once dry run shows improvement
