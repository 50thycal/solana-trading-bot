# Plan: AI-Assisted Trading Bot Analysis & Improvement Loop

## Context (from your answers)

- **Research bot**: Separate Railway service (`pumpfun-research-collector`), SQLite at `/data/research.db`, collects per-token snapshots (price, tx counts, buy/sell estimates) every 5-10s for 30min windows every 4h (12.5% coverage). You're open to modifying it.
- **Deployment**: GitHub push → Railway auto-deploy. Config via Railway env vars. No SSH. All output must be HTTP endpoints/dashboard.
- **Runtime**: Smoke test mode — 30min windows, max 1 trade per window, repeating cycles. Real money.
- **Trading**: Real on-chain transactions from a single wallet. Analysis must use actual fills, fees, slippage.

---

## Architecture Decision: All Features as Dashboard HTTP Endpoints

Since you have no SSH access and config changes are via Railway env vars, every analysis feature will be:
- A new API endpoint on the existing dashboard server (`dashboard/server.ts`)
- A new dashboard page in `dashboard/public/` for visual access
- Plain-text `/compact` variants optimized for pasting into Claude

---

## Phase 1: Run Journal (Low effort, High impact)

### What it does
Automatically captures what you were testing on each bot session, so you never lose context.

### Database changes (`persistence/state-store.ts`)

New table `run_journal` (schema v5 migration):
```sql
CREATE TABLE run_journal (
  session_id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  hypothesis TEXT,
  config_snapshot TEXT NOT NULL,       -- Full config JSON (secrets redacted)
  bot_mode TEXT NOT NULL,
  quote_amount_sol REAL,
  take_profit_pct REAL,
  stop_loss_pct REAL,
  max_hold_duration_s INTEGER,
  sniper_gate_enabled INTEGER,
  momentum_gate_enabled INTEGER,
  trailing_stop_enabled INTEGER,
  total_detections INTEGER DEFAULT 0,
  total_trades INTEGER DEFAULT 0,
  total_wins INTEGER DEFAULT 0,
  total_losses INTEGER DEFAULT 0,
  realized_pnl_sol REAL DEFAULT 0,
  outcome_notes TEXT,
  tags TEXT
);
```

### New env var
- `RUN_HYPOTHESIS` — set in Railway before each run to describe what you're testing

### Implementation files
1. **`persistence/state-store.ts`** — Add v5 migration, add `createJournalEntry()`, `updateJournalEntry()`, `closeJournalEntry()`, `getJournalEntries()` methods
2. **`bot.ts`** — On startup, create journal entry with config snapshot + hypothesis. On shutdown, close it with aggregated stats.
3. **`helpers/config-validator.ts`** — Add `RUN_HYPOTHESIS` to config, add `getRedactedConfigSnapshot()` that strips `PRIVATE_KEY` and `RPC_ENDPOINT` passwords
4. **`dashboard/server.ts`** — Add endpoints:
   - `GET /api/journal` — List all journal entries (paginated)
   - `GET /api/journal/:sessionId` — Single entry with linked trades
   - `POST /api/journal/:sessionId/notes` — Add outcome notes after a run
   - `GET /api/journal/compact` — Plain text for Claude
5. **`dashboard/public/journal.html`** + **`journal.js`** — Dashboard page showing run history with hypotheses, configs, outcomes

### How you'll use it
1. In Railway env vars, set `RUN_HYPOTHESIS="Testing TP=20% down from 40%"`
2. Deploy (auto via Railway)
3. Bot runs, auto-logs config + hypothesis
4. After run, visit dashboard → Journal page, add outcome notes
5. When pasting into Claude: hit `/api/journal/compact?last=3` to get last 3 runs as structured text

---

## Phase 2: AI Analysis Report (Medium effort, Very High impact)

### What it does
Comprehensive analysis endpoints that compute insights from your real trade data, optimized for AI consumption.

### New file: `helpers/ai-analysis.ts`

Core analysis engine with these computed sections:

**a) Session Summary**
- Config used (from run_journal)
- Hypothesis, duration, detection count
- Market conditions summary (if research bot data available)

**b) Trade Performance Analysis**
- Win/loss count and percentages
- Average win SOL vs average loss SOL (expectancy)
- Best and worst trades with token details
- P&L by trade sequence (are later trades better?)
- Hold duration distribution (bucketed: <10s, 10-30s, 30-60s, >60s)
- Entry price vs exit price scatter

**c) Slippage & Execution Analysis** (from existing trade-audit data)
- Average buy slippage (intended vs actual SOL spent)
- Average sell slippage
- Transaction cost breakdown (gas + priority fees)
- Failed transaction rate and reasons

**d) Pipeline Efficiency**
- Funnel: detected → cheap gates → deep filters → gate → bought
- Top 10 rejection reasons with counts
- Of tokens that passed all gates and were bought — what % were profitable?
- Filter calibration: are any filters rejecting too many or too few?

**e) Entry Condition Correlations**
- From `pool_detections` + `positions` + `trades`: join on token_mint
  - SOL in bonding curve at detection vs trade P&L
  - Pool quote reserve at detection vs trade P&L
  - Pipeline duration vs trade P&L
- From `sniper_gate_observations` + `trades` (when sniper gate enabled):
  - Bot count at entry vs P&L
  - Organic buyer count at entry vs P&L
  - Bot exit % at entry vs P&L

**f) Exit Analysis**
- Breakdown by exit reason: TP hit, SL hit, trailing stop, max hold timeout
- For max-hold exits: what was the unrealized P&L at exit? (Were these potential winners?)
- For SL exits: how deep did price go after exit? (Was SL too tight?)
- Trailing stop effectiveness: did it capture more than a fixed TP would have?

**g) Time-of-Day Analysis**
- P&L bucketed by hour (UTC)
- Win rate by hour
- Trade count by hour
- Identifies profitable vs unprofitable time windows

**h) Cross-Run Comparison** (when multiple journal entries exist)
- Side-by-side: Run A config vs Run B config + outcomes
- What changed between runs and did it help?
- Trend: are results improving over time?

### Implementation files
1. **`helpers/ai-analysis.ts`** — Core analysis engine (~400 lines). Queries SQLite directly via `getStateStore()`. Returns structured `AnalysisReport` object.
2. **`dashboard/server.ts`** — Add endpoints:
   - `GET /api/ai-report` — Full JSON analysis (current session or `?session=<id>`)
   - `GET /api/ai-report/compact` — Plain text markdown optimized for Claude (this is the money endpoint)
   - `GET /api/ai-report/compare?sessions=id1,id2` — Cross-run comparison
3. **`dashboard/public/ai-report.html`** + **`ai-report.js`** — Dashboard page rendering the analysis visually with charts

### Output format for `/api/ai-report/compact`

```markdown
# Trading Bot Analysis Report
## Session: abc123 | 2024-01-15 21:00-21:30 UTC
## Hypothesis: "Testing TP=20% with trailing stop at 10%"

### Config (key params)
QUOTE_AMOUNT=0.01 SOL | TP=20% | SL=15% | MAX_HOLD=30s
TRAILING_STOP=enabled (activate=10%, distance=5%)
SNIPER_GATE=enabled (threshold=3 slots, min_organic=3)

### Performance
Trades: 1 | Wins: 0 | Losses: 1 | Win Rate: 0%
P&L: -0.008 SOL | Avg Win: -- | Avg Loss: -0.008 SOL
Expectancy: -0.008 SOL/trade

### Pipeline (this session)
Detected: 47 | Cheap Gates: 31 pass (66%) | Deep Filter: 12 pass (39%) | Gate: 3 pass (25%) | Bought: 1 (2.1% of detected)
Top rejections: pattern_match (8), min_sol_in_curve (6), freeze_authority (3)

### Exit Analysis
SL exits: 1 (100%) | TP exits: 0 | Trailing: 0 | Timeout: 0
SL exit avg loss: -0.008 SOL

### Entry Conditions (bought tokens)
Token XYZ: SOL in curve=12.3, organic buyers=4, bot count=2, pipeline=340ms

### Cross-Run Trend (last 3)
Run 1: -0.015 SOL (TP=40%, no trailing) → 0% win rate
Run 2: -0.008 SOL (TP=20%, no trailing) → 0% win rate
Run 3: -0.008 SOL (TP=20%, trailing) → 0% win rate [current]

### AI Recommendations
[Computed suggestions based on patterns in the data]
```

### How you'll use it
1. After a run (or during), visit dashboard or `curl https://your-bot.railway.app/api/ai-report/compact?last=3`
2. Copy the plain text output
3. Paste into Claude with "Analyze my last 3 trading runs and suggest improvements"
4. Claude has full structured data to give specific, actionable recommendations

---

## Phase 3: Market Context Integration (Medium effort, High impact)

### The problem
Your research bot collects rich per-token data but it's on a separate Railway service with its own SQLite. The trading bot can't read its DB directly.

### Solution: Two-part approach

**Part A: Add a market summary API to the research bot** (changes in `pumpfun-research-collector`)

New endpoint on the research bot's HTTP server (or add one if none exists):
- `GET /api/market-summary?from=<timestamp>&to=<timestamp>`

Returns:
```json
{
  "period": { "from": 1705350000, "to": 1705351800 },
  "tokens_created": 142,
  "tokens_with_2x": 8,
  "hit_2x_rate_pct": 5.6,
  "avg_initial_price_sol": 0.0000000283,
  "avg_peak_gain_pct": 45.2,
  "median_peak_gain_pct": 12.1,
  "avg_buy_velocity": 0.8,
  "avg_sell_ratio": 0.35,
  "total_snapshots": 4200,
  "coverage_pct": 100
}
```

This is a simple aggregation query across the research bot's `tokens`, `snapshots`, and `outcomes` tables for a time window. Minimal code.

**Part B: Trading bot fetches market context** (changes in `solana-trading-bot`)

1. **New env var**: `RESEARCH_BOT_URL` — URL of the research bot's Railway service (e.g., `https://pumpfun-research.up.railway.app`)
2. **`helpers/market-context.ts`** — Fetches market summary from research bot API on a schedule (every 5 min) and caches locally
3. **`persistence/state-store.ts`** — New table `market_snapshots` (v5 migration):
   ```sql
   CREATE TABLE market_snapshots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     captured_at INTEGER NOT NULL,
     period_from INTEGER NOT NULL,
     period_to INTEGER NOT NULL,
     tokens_created INTEGER,
     hit_2x_rate_pct REAL,
     avg_peak_gain_pct REAL,
     median_peak_gain_pct REAL,
     avg_buy_velocity REAL,
     avg_sell_ratio REAL,
     source TEXT DEFAULT 'research_bot'
   );
   ```
4. **`helpers/ai-analysis.ts`** — Correlate market snapshots with trade outcomes. Include in the AI report:
   - "During this session, the market had X tokens created with Y% hitting 2x"
   - "Your win rate was Z% vs market 2x rate of Y%"
   - Correlation: "You perform better when market 2x rate > 5%"

**Part C: Fallback — self-collected market context** (if research bot isn't available)

Even without the research bot, the trading bot already sees every token via its WebSocket listener. We can derive basic market metrics from `pool_detections` and `seen_pools`:
- Tokens detected per 5-min window
- % that passed filters (proxy for market quality)
- Average SOL in curve at detection

This is computed from existing data — no new data collection needed.

### Implementation priority
- Part C (fallback) is free — just queries on existing data. Build this first.
- Part A requires a small change to the research bot. Do when ready.
- Part B connects them. Do after Part A.

---

## Phase 4: Automated Recommendations Engine (Low effort, High impact)

### What it does
Computes specific parameter change suggestions based on accumulated trade data. Not AI — just rule-based analysis that produces structured suggestions.

### New file: `helpers/recommendations.ts`

Rules engine that examines trade history and produces recommendations:

| Pattern Detected | Recommendation |
|---|---|
| TP never triggers, winners reverse to losses | "Reduce TAKE_PROFIT from X% to Y% (median winner peaks at Y%)" |
| SL triggers on >70% of trades | "SL may be too tight. Current: X%. Trades that hit SL had avg max gain of Y% before reversing" |
| Max-hold exits have positive unrealized P&L | "MAX_HOLD_DURATION may be too short. X% of timeout exits were still profitable" |
| Max-hold exits have negative P&L | "MAX_HOLD_DURATION may be too long. Consider reducing to cut losers faster" |
| Win rate varies by hour | "Consider adding time-of-day filter. Profitable hours: X-Y UTC" |
| Pipeline rejects >90% at one stage | "Filter X may be too aggressive. Relaxing from A to B would let N more tokens through" |
| Organic buyer count correlates with wins | "Tokens with ≥N organic buyers win at X% vs Y% overall. Consider raising SNIPER_GATE_MIN_ORGANIC_BUYERS" |
| Trailing stop captures more than fixed TP | "Trailing stop added +X% vs fixed TP over N trades. Keep enabled." |
| Cost-adjusted: fees eat >20% of gross P&L | "Transaction costs are significant. Consider raising QUOTE_AMOUNT or reducing trade frequency" |

### Implementation
1. **`helpers/recommendations.ts`** — ~200 lines. Takes `AnalysisReport` as input, applies rules, outputs `Recommendation[]`
2. Included in `/api/ai-report/compact` output under "### Computed Recommendations"
3. Also available standalone: `GET /api/recommendations`

### Why this is separate from "asking Claude"
These are data-driven, mechanical checks. They catch the obvious stuff instantly. Claude adds the nuanced analysis on top.

---

## Phase 5: Dashboard Integration (Medium effort, Medium impact)

### New dashboard pages

1. **`/journal`** — Run journal with hypothesis, config diff between runs, outcome notes
2. **`/ai-report`** — Full analysis view with:
   - Performance cards (win rate, P&L, expectancy)
   - Pipeline funnel visualization
   - Entry condition correlation scatter plots
   - Exit reason pie chart
   - Time-of-day heatmap
   - Recommendations panel
   - "Copy for Claude" button that copies `/api/ai-report/compact` output
3. **`/compare`** — Side-by-side run comparison

### Modifications to existing pages
- **`index.html` / `home.js`** — Add link to journal and AI report in nav
- **`nav.js`** — Add new nav items

---

## Implementation Order & File Changes

### Sprint 1: Foundation (Run Journal + AI Report Core)

**Files to create:**
- `helpers/ai-analysis.ts` — Core analysis engine
- `helpers/recommendations.ts` — Rule-based recommendations
- `dashboard/public/journal.html` + `journal.js` — Journal page
- `dashboard/public/ai-report.html` + `ai-report.js` — AI report page

**Files to modify:**
- `persistence/state-store.ts` — v5 migration (run_journal + market_snapshots tables), new query methods
- `persistence/models.ts` — New TypeScript interfaces
- `helpers/config-validator.ts` — Add `RUN_HYPOTHESIS`, `RESEARCH_BOT_URL` env vars
- `bot.ts` — Journal entry creation on startup/shutdown
- `dashboard/server.ts` — New API endpoints
- `dashboard/public/nav.js` — New nav links
- `dashboard/public/styles.css` — Styles for new pages
- `.env.example` — Document new env vars

### Sprint 2: Market Context

**Files to create:**
- `helpers/market-context.ts` — Research bot API client + fallback from own data

**Files to modify:**
- `helpers/ai-analysis.ts` — Add market context correlation
- `persistence/state-store.ts` — Market snapshots queries
- `dashboard/server.ts` — Market context endpoints

### Sprint 3: Research Bot Changes (separate repo)

**Files to create/modify in `pumpfun-research-collector`:**
- Add HTTP server if none exists, or add endpoint to existing
- `GET /api/market-summary` endpoint with time-range query

---

## Env Vars Summary (new)

| Var | Default | Purpose |
|-----|---------|---------|
| `RUN_HYPOTHESIS` | `""` | Describe what you're testing this run |
| `RESEARCH_BOT_URL` | `""` | URL of research bot for market context (optional) |

---

## Data Flow After Implementation

```
┌─────────────────────────────────────────────────────────────────┐
│ BEFORE EACH RUN                                                 │
│  1. Set RUN_HYPOTHESIS in Railway env vars                      │
│  2. Push → Railway auto-deploys                                 │
├─────────────────────────────────────────────────────────────────┤
│ DURING RUN (automatic)                                          │
│  - Bot creates run_journal entry with config snapshot           │
│  - Trades execute and record to positions/trades tables         │
│  - Pipeline stats accumulate                                    │
│  - Market context fetched from research bot (if configured)     │
│  - Market context derived from own detections (always)          │
├─────────────────────────────────────────────────────────────────┤
│ AFTER RUN (your workflow)                                       │
│  1. Visit dashboard → /ai-report                                │
│  2. Review visual analysis OR click "Copy for Claude"           │
│  3. Paste into Claude → get specific, data-backed suggestions   │
│  4. Or: curl /api/recommendations for quick mechanical checks   │
│  5. Update config based on insights                             │
│  6. Set new RUN_HYPOTHESIS → deploy → repeat                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## What This Unlocks

**Immediate (Sprint 1):**
- Every run is tagged with what you were testing
- Full trade analysis available as structured text for Claude
- Mechanical recommendations surface obvious parameter issues
- No more screenshotting the dashboard

**Short-term (Sprint 2):**
- Market context answers "was it the market or my config?"
- Correlation analysis identifies which conditions predict winners
- Time-of-day filtering potential identified

**Medium-term (with data accumulation):**
- Cross-run comparison shows which config changes actually helped
- Evidence-based filter thresholds replace gut feel
- Potential market conditions gate (only trade when conditions are favorable)

---

## Open Design Decisions

1. **Journal auto-close**: Should the journal entry auto-close when the smoke test window ends, or when the bot process exits? → Recommend: on process exit, to capture the full session.

2. **Research bot API auth**: Should the market summary endpoint require auth? → Recommend: yes, a simple API key in env var.

3. **Recommendation confidence**: Should recommendations require a minimum sample size (e.g., ≥5 trades) before suggesting parameter changes? → Recommend: yes, show "insufficient data" below threshold.

4. **Historical data**: Should the AI report analyze only the current session or include all historical trades? → Recommend: default to current session with `?include_history=true` option for cross-session analysis.
