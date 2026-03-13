# Trade Feedback Loop — Implementation Plan

## Goal
After a smoke test completes a full buy+sell cycle, send trade performance data back to the research bot so it can learn which scores/features predict profitable trades.

## Architecture

```
Smoke Test completes buy+sell
  → Collect: research score snapshot (from buy time) + trade outcome (P&L, timing, slippage, exit trigger)
  → POST to research bot: /api/feedback/trade
  → Research bot uses this to refine scoring model weights
  → Next model refresh picks up improved weights
```

## Files to Create/Modify

### 1. NEW: `pipeline/trade-feedback-loop.ts` (~150 lines)

**TradeOutcomeReport interface:**
```typescript
{
  // Token identification
  tokenMint: string;
  tokenSymbol: string;

  // Research score snapshot (captured at buy time)
  researchScore: {
    score: number;
    signal: string;
    features: TokenFeatureVector;
    featureScores: Array<{ name: string; score: number; raw: number }>;
    scoreThreshold: number;
    modelSampleCount: number;
  };

  // Trade outcome
  trade: {
    entryAmountSol: number;
    exitAmountSol: number;
    pnlSol: number;
    pnlPercent: number;
    holdDurationMs: number;
    exitTrigger: string; // 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_exit' | 'graduation'
    buyTimestamp: number;
    sellTimestamp: number;
  };

  // Execution quality
  execution: {
    buySlippagePercent?: number;
    sellSlippagePercent?: number;
    buyOverheadSol?: number;
    highWaterMarkPercent?: number;
  };

  // Environment
  environment: {
    botMode: string;
    timestamp: number;
  };
}
```

**TradeFeedbackReporter class:**
- Constructor takes `researchBotUrl: string`
- `async sendFeedback(report: TradeOutcomeReport): Promise<void>`
  - POST to `{researchBotUrl}/api/feedback/trade`
  - 3s timeout, non-fatal on error
  - Log the report locally regardless of whether POST succeeds
- `getLastReport(): TradeOutcomeReport | null` (for dashboard)

### 2. MODIFY: `pipeline/index.ts`
- Export `TradeFeedbackReporter` and `TradeOutcomeReport` from the new file

### 3. MODIFY: `smoke-test.ts`

**a) Store research score on state (at buy time):**
- Add `pipelineContext: PipelineContext | null` to the state object
- After pipeline passes and buy succeeds (line ~1268), store `result.context` on state

**b) After buildReport, trigger feedback (at end of successful run):**
- After `buildReport()` returns with `overallResult === 'PASS'` and both buy+sell completed:
  - Construct `TradeOutcomeReport` from state + report data
  - Call `feedbackReporter.sendFeedback(report)`
  - Wrap in try/catch — feedback errors must never affect the smoke test result

### 4. MODIFY: `dashboard/server.ts`
- Add `GET /api/trade-feedback` endpoint
- Returns the last feedback report (from `TradeFeedbackReporter.getLastReport()`)

## What the Research Bot Needs to Implement (Later)

`POST /api/feedback/trade` endpoint that:
1. Receives the `TradeOutcomeReport`
2. Correlates the token with its dataset
3. Analyzes which features predicted the outcome correctly
4. Adjusts scoring model weights accordingly

## Key Design Decisions

- **Smoke tests only** — production feedback can be added later by hooking into position monitor's sell event
- **Research bot owns the analysis** — the trading bot just sends raw data, doesn't try to classify outcomes locally
- **Non-fatal** — feedback failures never block or affect smoke test results
- **Store context at buy time** — the research score and feature vector at the moment of the buy decision are what matter, not the current state
- **Simple POST, no response processing** — the trading bot fires and forgets; it doesn't need the research bot's analysis back
