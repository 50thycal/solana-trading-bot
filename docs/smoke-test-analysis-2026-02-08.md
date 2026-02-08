# Smoke Test Analysis - 2026-02-08T04:41

## Overview

Two consecutive smoke test runs were captured. Run 1 **FAILED** (3/4 steps, 300s timeout).
Run 2 **PASSED** (9/9 steps, 44.7s).

## Run 1 Summary (FAIL)

- **Duration:** 300.5s (hit timeout)
- **Tokens seen:** 50
- **Pipeline passed:** 0
- **Net cost:** 0 SOL

All 50 tokens passed cheap-gates but were rejected at deep-filters with
`Failed: minSolInCurve (1/2 passed)`. The default `minSolInCurve=5` SOL filter
blocked every newly created token since they start with minimal SOL in their
bonding curve. This is working as designed but is too strict for a 5-minute window
to guarantee at least one passing token.

## Run 2 Summary (PASS)

- **Duration:** 44.7s
- **Tokens seen:** 7
- **Pipeline passed:** 2
- **Net cost:** 0.001996 SOL (wallet 1.039 -> 1.037 SOL)
- **Exit trigger:** time_exit (max hold 20s reached)
- **Buy failures:** 1 (Bitecoin - slippage)

### Token Pipeline Results (Run 2)

| Token | Cheap Gates | Deep Filters | Momentum | Buy |
|-------|-------------|-------------|----------|-----|
| FreeSol | PASS (1ms) | REJECT (minSolInCurve) | - | - |
| BRDG | PASS (0ms) | REJECT (minSolInCurve) | - | - |
| Aiden | PASS (0ms) | REJECT (minSolInCurve) | - | - |
| FATHER | PASS (0ms) | REJECT (minSolInCurve) | - | - |
| Bitecoin | PASS (0ms) | PASS (35ms) | PASS - 11 buys (2022ms) | FAIL (slippage) |
| 2XSOL | PASS (0ms) | PASS (36ms) | PASS - 12 buys (1985ms) | SUCCESS |
| Colon | seen, not fully processed | - | - | - |

### Successful Trade (2XSOL)

- **Buy:** 15,271,559,238 tokens, 0.0031 SOL spent (includes gas), score: 74
- **Hold:** 20.075s, PnL: +15.76%, value: 0.001158 SOL
- **Sell:** 0.001144 SOL received, slippage: -1.25%
- **Exit:** time_exit (max hold 20s)

## Key Findings

### 1. Bitecoin Buy Failure - Slippage Exceeded

Error `TooMuchSolRequired` (0x1772):
- `Left: 1200000` (maxSolCost = 0.0012 SOL, i.e., 0.001 + 20% slippage)
- `Right: 1249192` (actual cost = 0.001249 SOL, ~24.9% above base)

The ~2s momentum gate delay allowed enough price movement to exceed the 20%
BUY_SLIPPAGE buffer. This is correct safety behavior.

### 2. DRY_RUN=true Did Not Prevent Real Trades

The smoke test executes real transactions regardless of DRY_RUN. The position
monitor logged `DRY RUN - would have sold tokens`, but the smoke test's own
sell logic executed the actual sell. Real SOL was spent.

### 3. Create vs CreateV2 Both Handled Correctly

Old-style `Create` (14 accounts, TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA)
and new-style `CreateV2` (16 accounts, TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb)
were both parsed and processed correctly.

### 4. Momentum Gate Working as Designed

Both passing tokens cleared `minTotalBuys=10` threshold (11 and 12 buys
respectively). The ~2s total delay is consistent with initial delay + up to 5
polling rounds + RPC latency.

## Env Vars vs. Effective Config

| Variable | Set Value | Effective | Notes |
|----------|-----------|-----------|-------|
| BUY_SLIPPAGE | 20 | 20% (2000 bps) | Caused Bitecoin failure |
| SELL_SLIPPAGE | 30 | 50% (5000 bps) | Smoke test overrides to min 50% |
| TAKE_PROFIT | 40 | 40% | Never triggered |
| STOP_LOSS | 20 | 20% | Never triggered |
| MAX_HOLD_DURATION_MS | 20000 | 20000ms | Triggered at 20075ms |
| QUOTE_AMOUNT | 0.001 | 0.001 SOL | |
| DRY_RUN | true | Ignored by smoke test | Real trades executed |
| PUMPFUN_MIN_SOL_IN_CURVE | (not set) | 5 SOL (default) | Strict for new tokens |
| PUMPFUN_MAX_SOL_IN_CURVE | (not set) | 300 SOL (default) | |
| MOMENTUM_MIN_TOTAL_BUYS | (not set) | 10 (default) | |
| SMOKE_TEST_TIMEOUT_MS | 300000 | 300s | Run 1 hit this |

## Recommendations

1. **DRY_RUN gap:** Smoke test should respect DRY_RUN or at minimum warn that
   it will execute real transactions despite DRY_RUN=true.

2. **BUY_SLIPPAGE:** Consider 25-30% for smoke tests since the momentum gate
   introduces ~2s delay during which fast-moving tokens will shift price.

3. **minSolInCurve:** Consider lowering to 1-2 SOL for smoke tests, or adding
   a smoke-test-specific override. At 5 SOL, a 5-minute window with 50 tokens
   had 0 passes in Run 1.
