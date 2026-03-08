# Research Score Gate — Integration Plan

> Integrates the research bot's scoring model into the trading bot pipeline
> as a new gate after the sniper gate, replacing the momentum gate.

## Pipeline After This Change

```
Cheap Gates → Deep Filters → Sniper Gate → Research Score Gate → Execute
```

---

## Phase 1: Remove Momentum Gate

| File | Action |
|------|--------|
| `pipeline/momentum-gate.ts` | DELETE |
| `pipeline/types.ts` | Remove `MomentumGateData`, `momentumGate?` from `PipelineContext`, `MOMENTUM_*` rejection reasons |
| `pipeline/index.ts` | Remove `export * from './momentum-gate'` |
| `pipeline/pipeline.ts` | Remove momentum gate import, stage, config; sniper gate always runs |
| `helpers/config-validator.ts` | Remove `momentumGate*` from `ValidatedConfig`, remove `MOMENTUM_*` env var parsing, remove sniper/momentum conflict warning |
| `index.ts` | Remove `momentumGate:` block from `initPipeline` call |
| `smoke-test.ts` | Remove `momentumGate:` block from `initPipeline` call |
| `pipeline/pipeline-stats.ts` | Remove momentum gate stats tracking |

## Phase 2: Add Types

In `pipeline/types.ts`:
- `TokenFeatureVector` interface (matching research bot exactly)
- `ScoringRule` and `ScoringModel` interfaces
- `ResearchScoreGateData` interface
- `researchScore?` on `PipelineContext`
- `RESEARCH_SCORE_LOW` rejection reason

## Phase 3: Create Research Score Gate Stage

New file: `pipeline/research-score-gate.ts`
- Implements `PipelineStage<PipelineContext, ResearchScoreGateData>`
- Fetches model from `GET {researchBotUrl}/api/analysis/model?checkpoint={checkpoint}&full=true`
- Caches model in memory with configurable refresh interval
- Builds `TokenFeatureVector` from pipeline context:
  - BondingCurveState (BN → number conversion)
  - SniperGateData (correct field names: `sniperWalletCount`, `organicBuyerCount`, etc.)
  - Derives momentum features from `checkHistory` (no sniper gate modification needed)
- Scores token using same algorithm as research bot
- Pass/reject based on threshold
- Graceful degradation: if no model available, pass with warning

## Phase 4: Wire Into Pipeline

- `pipeline/pipeline.ts`: Add research score gate as Stage 5 after sniper gate
- `pipeline/index.ts`: Export research score gate
- Sniper gate always runs (no more conditional with momentum gate)

## Phase 5: Config & Env Vars

- `helpers/config-validator.ts`: Add `RESEARCH_SCORE_*` env vars
- Reuse existing `RESEARCH_BOT_URL`
- Change `SNIPER_GATE_ENABLED` default to `true`
- Wire config in `index.ts` and `smoke-test.ts`

```env
RESEARCH_SCORE_GATE_ENABLED=true      # default: true
RESEARCH_SCORE_THRESHOLD=50           # default: 50
RESEARCH_SCORE_CHECKPOINT=30          # default: 30
RESEARCH_SCORE_LOG_ONLY=false         # default: false
RESEARCH_SCORE_MODEL_REFRESH_INTERVAL=300000  # default: 5 min
```

## Phase 6: Pipeline Stats & Dashboard

- Track research score pass/reject counts, average scores, distribution
- Show research score data in dashboard trade journal / diagnostic views

## Key Design Decisions

1. **Derive momentum features from `checkHistory`** — The sniper gate's per-poll snapshots already contain `totalBuys`, `organicCount`, `checkedAt`, giving us `buyAcceleration` and `txBurst` without modifying the sniper gate.
2. **Graceful degradation** — If research bot is unreachable and no cached model exists, pass the token with a warning log. This prevents blocking all trades if the research bot is down.
3. **Same feature names as research bot** — `TokenFeatureVector` uses identical field names so scoring rules apply directly.
