# Plan: AI-Assisted Trading Bot Analysis & Improvement Loop

## Problem Summary

You have a Solana pump.fun trading bot with:
- A SQLite database storing trades, positions, paper trades, pipeline decisions, and sniper gate observations
- A web dashboard for monitoring
- An A/B testing framework
- Paper trade tracking with TP/SL simulation

But you're not making money, and the feedback loop between "run bot → analyze results → improve config/code" is slow and manual. Specific pain points:

1. **No structured experiment tracking** — You forget what you were testing on a given run
2. **Database is underutilized** — Rich trade data sits in SQLite but isn't queried for insights
3. **AI can't access the data directly** — You manually screenshot the dashboard and paste it into Claude
4. **Market context is missing** — Bot only takes snapshots, doesn't capture the full pattern of pump.fun market behavior
5. **No systematic way to correlate config changes with outcomes**

---

## The Plan: 5 Components

### 1. Run Journal — "What Was I Testing?"

**Problem:** You forget what each run was meant to test.

**Solution:** Add a `run_journal` table and a simple mechanism to tag each bot session with a hypothesis.

```
run_journal table:
  - session_id (TEXT, primary key)
  - started_at (INTEGER)
  - ended_at (INTEGER)
  - hypothesis (TEXT)        — "Testing if 30s max hold with 25% TP works better than 20s/40%"
  - config_snapshot (TEXT)   — JSON blob of the full config at start time
  - bot_mode (TEXT)          — 'production' | 'dry_run' | 'paper'
  - outcome_notes (TEXT)     — Filled in after the run: "Lost 0.3 SOL, TP never hit"
  - tags (TEXT)              — Comma-separated: "tp-tuning,aggressive,evening-session"
```

**How it works:**
- On bot startup, automatically capture the full config as JSON and create a journal entry
- Add an env var `RUN_HYPOTHESIS` — set it before each run to describe what you're testing
- Add a dashboard page or API endpoint to review past runs with their hypotheses and outcomes
- After a run, you (or AI) can fill in `outcome_notes` via the dashboard

**Why this matters for AI analysis:** When you ask Claude to analyze a run, it gets the full context — what config was used, what you were trying to test, and what happened. No more guessing.

---

### 2. AI Analysis Export — "Let Claude Query the Database"

**Problem:** Claude can't see your database. You have to manually relay information.

**Solution:** Build a CLI script and/or dashboard API endpoint that exports structured analysis reports from the database in a format optimized for AI consumption.

**`scripts/export-analysis.ts`** — A CLI tool that queries SQLite and outputs a structured markdown/JSON report:

```
Usage: npx ts-node scripts/export-analysis.ts [--session <id>] [--last <N>] [--format md|json]
```

**What it exports:**

**a) Session Summary**
- Config snapshot (from run_journal)
- Hypothesis being tested
- Duration, total tokens seen, total trades

**b) Trade Performance**
- Win/loss breakdown with percentages
- Average win size vs average loss size (expectancy calculation)
- Best and worst trades with token details
- P&L curve over time (text-based or data points)
- Hold duration distribution

**c) Pipeline Efficiency**
- Funnel: tokens detected → cheap gates → deep filters → momentum/sniper gate → bought
- Top 10 rejection reasons with counts
- What percentage of tokens that passed all gates were actually profitable?

**d) Pattern Analysis**
- Time-of-day performance (which hours are profitable vs not)
- Correlation between entry metrics and outcomes:
  - SOL in curve at entry vs P&L
  - Sniper bot count at entry vs P&L
  - Organic buyer count at entry vs P&L
  - Pipeline duration vs P&L
- Tokens that hit TP vs SL vs time-exit — what distinguished them at entry?

**e) Cross-Run Comparison**
- Compare the last N runs side by side
- Which config changes correlated with improved results?
- Regression detection: "Run 5 was worse than Run 4 — the only config change was X"

**Why this matters:** Instead of screenshotting the dashboard, you run `npx ts-node scripts/export-analysis.ts --last 3` and paste the output into Claude. Claude gets structured, complete data and can give you specific, data-backed recommendations.

**Dashboard integration:** Also expose this as `/api/ai-report?session=<id>` so you can fetch it from the dashboard UI and copy it.

---

### 3. Market Context Capture — "What Was the Market Doing?"

**Problem:** Your bot takes snapshots but doesn't capture the broader pump.fun market pattern. You can't tell if a bad run was due to bad config or bad market conditions.

**Solution:** Add a `market_context` table that continuously captures market-level metrics, independent of whether your bot trades.

```
market_context table:
  - timestamp (INTEGER)
  - tokens_created_5m (INTEGER)     — New tokens in last 5 min
  - tokens_graduated_5m (INTEGER)   — Tokens that hit graduation in last 5 min
  - avg_sol_in_curve (REAL)         — Average SOL across active bonding curves
  - total_volume_sol_5m (REAL)      — Total trading volume on pump.fun
  - graduation_rate_pct (REAL)      — % of tokens that graduate (5m window)
  - avg_token_lifespan_min (REAL)   — How long tokens stay active before dying
```

**How it works:**
- Your existing second bot (the market data collector) feeds this table, OR
- Add a lightweight background task to the main bot that polls pump.fun stats every 5 minutes
- The AI analysis export (Component 2) includes market context for each run period
- This lets Claude say: "Your bot lost money on this run, but the market was extremely unfavorable — only 2% of tokens graduated vs the usual 8%. Your filters were actually performing well relative to the market."

**Correlation queries the AI can answer:**
- "Does your bot perform better during high-volume or low-volume periods?"
- "What's the graduation rate when you're profitable vs when you're not?"
- "Should you only run the bot during certain market conditions?"

This directly supports your "quality over quantity" strategy — you could build a **market conditions gate** that only enables trading when conditions are favorable.

---

### 4. Recursive Improvement Loop — "The Actual Workflow"

**Problem:** The loop of "run → analyze → change → run again" is ad hoc and lossy.

**Solution:** Formalize the workflow so each cycle builds on the last.

**The loop:**

```
┌─────────────────────────────────────────────────┐
│  1. SET HYPOTHESIS                              │
│     Set RUN_HYPOTHESIS env var                  │
│     "Testing if minSolInCurve=5 filters junk"   │
├─────────────────────────────────────────────────┤
│  2. RUN BOT                                     │
│     Bot auto-captures config + hypothesis       │
│     Market context captured in background       │
├─────────────────────────────────────────────────┤
│  3. EXPORT & ANALYZE                            │
│     Run: scripts/export-analysis.ts --last 1    │
│     Paste output into Claude                    │
│     Claude compares against previous runs       │
├─────────────────────────────────────────────────┤
│  4. AI GENERATES RECOMMENDATIONS                │
│     "Based on 47 trades across 3 runs:          │
│      - Your TP of 40% never hits. Reduce to 20% │
│      - Tokens with >3 organic buyers at entry   │
│        win 65% of the time vs 30% overall       │
│      - You're profitable 9pm-1am UTC only"      │
├─────────────────────────────────────────────────┤
│  5. APPLY CHANGES                               │
│     Update config based on recommendations      │
│     Claude can directly edit .env or suggest     │
│     code changes for new filter logic            │
├─────────────────────────────────────────────────┤
│  6. RECORD & REPEAT                             │
│     New hypothesis based on recommendations     │
│     Previous run becomes the baseline            │
│     Loop back to step 1                          │
└─────────────────────────────────────────────────┘
```

**Key principle:** Every run has a clear before/after. You always know what changed and whether it helped.

---

### 5. Smart Filters from Data — "Quality Over Quantity"

**Problem:** You want fewer, better trades. Your current filters are configured by gut feel.

**Solution:** Use the accumulated data to derive evidence-based entry criteria.

**What the data can tell you (once Components 1-3 are in place):**

**a) Which entry conditions predict winners?**
Query all closed paper trades + real trades. For each, you have:
- SOL in bonding curve at entry
- Sniper bot count / organic buyer count (from sniper gate observations)
- Time since token creation
- Pipeline duration
- Market conditions at time of entry

Run correlations: "Of trades where organic buyers > 5 at entry, 60% were profitable. Of trades where organic buyers < 3, only 15% were profitable." → **Raise the organic buyer threshold.**

**b) Optimal exit parameters**
- Plot the price path of every trade. Where did winners peak? Where did losers bottom?
- If 80% of your winners peak within 15 seconds but your max hold is 60 seconds, you're giving back gains
- If your TP is 40% but the median winner only goes +18%, your TP never triggers and winners become losers on the reversal

**c) Time-based filtering**
- If data shows you only make money between 8pm-2am UTC, add a time-of-day gate
- This is the simplest "quality over quantity" filter — just don't trade during bad hours

**d) Market conditions gate**
- Using Component 3 data: if graduation rate < 5%, pause trading
- If token creation rate is unusually high (spam/bot flood), pause trading
- This alone could prevent most losing sessions

---

## Implementation Priority

| Phase | Component | Effort | Impact |
|-------|-----------|--------|--------|
| **1** | Run Journal (Component 1) | Low | High — Immediately fixes the "what was I testing" problem |
| **2** | AI Analysis Export (Component 2) | Medium | Very High — This is the core accelerator for AI-assisted improvement |
| **3** | Market Context Capture (Component 3) | Medium | High — Needed for answering "was it the market or my config?" |
| **4** | Formalize the Loop (Component 4) | Low | High — Just workflow discipline, minimal code |
| **5** | Data-Driven Filters (Component 5) | Ongoing | Very High — This is where the money is, but needs data from Phases 1-3 first |

**Phase 1-2 can be built in a single session.** They're the highest-leverage items — once the AI can see your data directly, every subsequent analysis session becomes 10x more productive.

---

## What This Looks Like In Practice

**Today (manual, lossy):**
1. Change some config values
2. Run bot for a while
3. Look at dashboard, try to remember what you changed
4. Screenshot dashboard, paste into Claude
5. Get vague suggestions because Claude only sees a picture

**After this plan (structured, cumulative):**
1. `RUN_HYPOTHESIS="Testing minOrganicBuyers=4 up from 2"` → deploy
2. Bot runs, auto-logs everything with the hypothesis and full config
3. `npx ts-node scripts/export-analysis.ts --last 2 --format md` → paste into Claude
4. Claude sees: "Run 7 (minOrganicBuyers=4): 12 trades, 58% win rate, +0.4 SOL. Run 6 (minOrganicBuyers=2): 31 trades, 29% win rate, -1.2 SOL. The filter is working — fewer trades but much higher quality. Data also shows tokens with >6 organic buyers have an 80% win rate. Consider raising to 6."
5. You raise to 6, set new hypothesis, run again
6. Cumulative learning compounds over time

---

## Questions Before Building

1. **Your second market data bot** — What data does it collect? Is it also SQLite? Same repo? If we can tap into that data, Component 3 might already be half-built.

2. **Where does the bot run?** You mentioned Railway. Do you SSH into it to change configs, or is it all env vars through Railway's UI? This affects how we design the hypothesis-setting workflow.

3. **How long are your typical runs?** 30 minutes? 4 hours? All day? This affects how we bucket the analysis (per-session vs per-hour vs per-day).

4. **Paper trading vs real trading** — Are you currently running paper trades (dry_run) or real trades? The analysis export needs to pull from the right tables.
