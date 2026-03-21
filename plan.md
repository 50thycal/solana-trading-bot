# Plan: Remove Sniper Gate & Add Transaction Polling to Research Score Gate

## Problem

The sniper gate runs in log-only mode with 1 check, so `txBurst` (13.34 points, 13% of max score) is **always 0**. The sniper gate's functionality is now covered by the research scoring model, so it should be removed. But the research gate still needs the transaction polling data the sniper gate was providing.

## What the Research Gate Needs from Sniper Gate Today

1. **`checkHistory[]`** - Time-series polling snapshots used to compute `txBurst` and `buyAcceleration`
2. **`sniperSlotThreshold`** / **`signatureLimit`** - Config values passed through for the checkpoint re-fetch
3. **Transaction data fallback** (`totalBuys`, `totalSells`, `organicBuyerCount`, `sniperExitCount`) - only used when fresh fetch fails

## Plan

### Step 1: Add a transaction poller to the research score gate

Instead of depending on sniper gate's `checkHistory`, the research gate will **start its own polling loop immediately** when `execute()` is called (right after deep filters pass). This runs during the checkpoint wait time that's already happening (~15 seconds), so there's **no additional delay**.

**New polling flow inside research-score-gate.ts:**
- When `execute()` starts, immediately kick off a background polling loop
- Poll `fetchAndAnalyzeTransactions()` every ~3 seconds during the checkpoint wait
- Store results in a local `checkHistory[]` array (same structure as before)
- When checkpoint age is reached, stop polling, use the accumulated history to compute `txBurst` and `buyAcceleration`
- Use the final poll as `freshTxData` (replacing the separate checkpoint re-fetch)

This replaces both:
- The sniper gate's checkHistory (for momentum features)
- The research gate's own `fetchAndAnalyzeTransactions` call at checkpoint (lines 457-483)

**Config additions to `ResearchScoreGateConfig`:**
- `pollIntervalMs`: number (default: 3000) - how often to poll during checkpoint wait
- `sniperSlotThreshold`: number (default: 3) - for fetchAndAnalyzeTransactions
- `signatureLimit`: number (default: 40) - for fetchAndAnalyzeTransactions

### Step 2: Remove sniper gate from the pipeline

**Files to modify:**
- `pipeline/pipeline.ts` - Remove sniper gate stage execution (lines 211-226), remove from constructor, imports, config, and stage list log
- `pipeline/types.ts` - Remove `sniperGate?` from `PipelineContext` (keep `SniperGateData` type for now to avoid breaking other references)
- `pipeline/research-score-gate.ts` - Remove all `ctx.sniperGate` references in `buildFeatureVector`, replace with own polling data

**Files NOT deleted** (to avoid breaking imports elsewhere):
- `pipeline/sniper-gate.ts` - Keep the file since `fetchAndAnalyzeTransactions` is exported from it and used by the research gate

### Step 3: Update `buildFeatureVector` to use polled data directly

Instead of reading from `ctx.sniperGate.checkHistory`, pass the locally-collected `checkHistory[]` directly to `buildFeatureVector`. The function signature changes to accept polling data as a parameter rather than reading it from context.

### Step 4: Clean up config/env vars

- `SNIPER_GATE_*` env vars become unused (can be removed from deployment, no code changes needed)
- Add new env vars: `RESEARCH_SCORE_POLL_INTERVAL_MS` (default 3000), reuse existing `SNIPER_GATE_SIGNATURE_LIMIT` → `RESEARCH_SCORE_SIGNATURE_LIMIT`

## Expected Impact

- `txBurst` will now have real values (computed from ~5 polls over 15 seconds)
- `buyAcceleration` will also have real values
- This unlocks **13.34 + potential buyAcceleration contribution** → tokens can score significantly higher
- Net pipeline latency: **unchanged** (polling happens during the checkpoint wait that already exists)
- RPC load: **similar** (polling every 3s for 15s = ~5 calls, vs sniper gate doing 1-6 checks)
