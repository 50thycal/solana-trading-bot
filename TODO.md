# TODO list

Tracking future tasks and improvements for the trading bot.

---

# Implementation Plans

Each TODO below includes a **Difficulty** rating, an **Individual Plan**, and estimated **Scope** (files touched).
See the [Master Execution Plan](#master-execution-plan) at the bottom for recommended order.

### Difficulty Key

| Rating | Meaning |
|--------|---------|
| **Low** | Straightforward changes, minimal risk, no architectural decisions |
| **Medium** | Multiple files, some design decisions, moderate testing needed |
| **High** | Cross-cutting concern, significant refactoring, or requires external verification |

---

## [ ] Clean up Railway logs for readability

The current logging setup (Pino + pino-pretty) outputs 352+ log calls across the codebase, making it hard to find what matters in Railway's log viewer. Key issues to address:

- **Add log level prefixes/categories** — Tag logs by module (e.g. `[pipeline]`, `[position]`, `[tx]`, `[filter]`) so you can quickly ctrl+F in Railway to isolate a subsystem.
- **Reduce info-level noise** — A lot of routine operations (config dump, every filter pass, heartbeat-style messages) log at `info`. Demote repetitive or low-value messages to `debug` so the default Railway view stays clean.
- **Consolidate startup output** — The config printout in `index.ts` logs each setting as a separate `logger.info()` call. Bundle these into a single structured log entry so startup doesn't flood the first 50 lines.
- **Unify bootstrap logging** — `bootstrap.ts` uses its own `console.log` wrapper instead of Pino. Once the app initializes, these early logs don't match the Pino format, making Railway's log parsing inconsistent.
- **Structured context on trades** — Ensure every buy/sell/position log includes a consistent set of fields (`mint`, `action`, `amount`, `signature`) so you can filter Railway logs by any of those dimensions.
- **Consider `LOG_LEVEL` env var for Railway** — Already supported but not documented. Make it easy to flip to `debug` or `warn` in Railway's env config without a redeploy.

Files to look at: `helpers/logger.ts`, `index.ts`, `bootstrap.ts`, `listeners/pumpfun-listener.ts`, `risk/pumpfun-position-monitor.ts`

### Implementation Plan

**Difficulty: Medium**

**Scope:** ~15-20 files touched (logger.ts, index.ts, bootstrap.ts, and ~12-15 files that emit logs across pipeline/, risk/, transactions/, listeners/)

**Steps:**

1. **Update `helpers/logger.ts`** — Add `LOG_LEVEL` env var support (currently hardcoded to `'info'`). Change `level: 'info'` to `level: process.env.LOG_LEVEL || 'info'`. Add a child-logger factory function `createModuleLogger(module: string)` that returns `logger.child({ module })` so every file can tag its logs with a module prefix (e.g., `[pipeline]`, `[tx]`, `[risk]`).

2. **Create module-scoped loggers** — In each major file, replace `import { logger } from '../helpers'` with a module-specific child logger:
   - `listeners/pumpfun-listener.ts` → `createModuleLogger('listener')`
   - `risk/pumpfun-position-monitor.ts` → `createModuleLogger('position')`
   - `pipeline/pipeline.ts` → `createModuleLogger('pipeline')`
   - `transactions/*.ts` → `createModuleLogger('tx')`
   - `dashboard/server.ts` → `createModuleLogger('dashboard')`
   This is mechanical find-and-replace but spans many files.

3. **Demote noisy logs** — Audit all `logger.info()` calls. Any message that fires repeatedly (every filter pass, every heartbeat, per-token details) gets downgraded to `logger.debug()`. Keep `logger.info()` for: startup summary, trade executions, position open/close events, errors.

4. **Consolidate startup config** — In `index.ts`, gather all the individual `logger.info()` config lines into a single `logger.info({ config: { ... } }, 'Bot configuration')` structured log call.

5. **Unify bootstrap logging** — In `bootstrap.ts`, replace the custom `log()` function (lines 29-33) with the Pino logger. Since the logger is initialized before config-validator, it can be imported early. If there's a chicken-and-egg issue with config, keep the custom log only for the first 2-3 lines before Pino is available, then switch.

6. **Enforce structured trade context** — Ensure every buy/sell log call includes `{ mint, action, amountSol, signature }` as structured fields in the Pino object argument. Audit `helpers/pumpfun.ts` and `risk/pumpfun-position-monitor.ts` for this.

7. **Document `LOG_LEVEL`** — Add a note in README.md about the `LOG_LEVEL` env var (valid values: `debug`, `info`, `warn`, `error`).

**Risks:** Renaming log calls across 15+ files is tedious but low-risk. The main risk is accidentally removing a useful log message by demoting it too aggressively — review carefully.

---

## [ ] Streamline testing setup

There's no test framework or test files in the project right now — only a manual `scripts/test-pumpfun-stats.ts` script. Set up a proper testing foundation:

- **Add a test framework** — Install Vitest or Jest with ts-node support. Add `test` and `test:watch` scripts to `package.json`.
- **Unit tests for pure logic** — Start with the modules that have no external dependencies and are easy to test in isolation:
  - `pipeline/cheap-gates.ts` — filter logic
  - `filters/pumpfun-filters.ts` — token evaluation rules
  - `risk/exposure-manager.ts` — exposure limit math
  - `risk/pnl-tracker.ts` — P&L calculations
  - `helpers/fee-estimator.ts` — fee estimation
- **Mock RPC and WebSocket connections** — The listener and transaction modules hit Solana RPC. Create lightweight mocks/fixtures so tests don't need a live connection.
- **Integration test for the pipeline** — Feed a fake detected token through `pipeline/pipeline.ts` end-to-end and assert it gets filtered/passed correctly.
- **CI-friendly** — Make sure tests can run in a GitHub Actions workflow so PRs get validated automatically.
- **Paper trade regression tests** — Use `risk/paper-trade-tracker.ts` to replay known token scenarios and assert expected P&L outcomes.

Files to look at: `package.json`, `pipeline/`, `filters/`, `risk/`, `scripts/test-pumpfun-stats.ts`

### Implementation Plan

**Difficulty: Medium**

**Scope:** ~10-15 new test files, 2-3 config files modified (`package.json`, `tsconfig.json`, new `vitest.config.ts`)

**Steps:**

1. **Install Vitest** — Run `npm install -D vitest @vitest/coverage-v8`. Vitest is preferred over Jest because this project already uses TypeScript natively with `ts-node`, and Vitest has first-class TS support with no extra config. Add to `package.json`:
   ```json
   "test": "vitest run",
   "test:watch": "vitest",
   "test:coverage": "vitest run --coverage"
   ```

2. **Create `vitest.config.ts`** — Minimal config pointing at the project root. Enable `globals: true` for cleaner syntax. Configure path aliases if `tsconfig.json` has any.

3. **Unit tests — Phase 1 (pure logic, no mocks needed):**
   - `tests/pipeline/cheap-gates.test.ts` — Test each gate function (name checks, regex filters, age checks) with fixtures of known-good and known-bad token data.
   - `tests/filters/pumpfun-filters.test.ts` — Test filter evaluation rules with mock token metadata objects.
   - `tests/risk/exposure-manager.test.ts` — Test exposure limit calculations (max exposure, trades-per-hour, wallet buffer checks).
   - `tests/risk/pnl-tracker.test.ts` — Test P&L math (realized P&L from buy/sell pairs, win rate calculation).
   - `tests/helpers/fee-estimator.test.ts` — Test fee estimation with known compute unit prices and limits.

4. **Unit tests — Phase 2 (mocked dependencies):**
   - Create `tests/mocks/solana.ts` — Mock `Connection`, `Keypair`, `sendTransaction` etc. Return canned responses.
   - Create `tests/mocks/websocket.ts` — Mock WebSocket connection for the pumpfun listener.
   - `tests/helpers/pumpfun.test.ts` — Test buy/sell instruction building (verify buffer encoding, field ordering) using mocked connections.

5. **Integration test:**
   - `tests/pipeline/pipeline.integration.test.ts` — Wire up the pipeline with mocked RPC, feed a fake detected token, assert it passes/fails the expected gates.

6. **Paper trade regression tests:**
   - `tests/risk/paper-trade-tracker.test.ts` — Replay scenarios: token that 2x's (assert correct realized PnL), token that drops 50% (assert stop-loss triggers), etc.

7. **CI setup** — Add `.github/workflows/test.yml` that runs `npm ci && npm test` on push/PR.

**Risks:** The main challenge is creating accurate mocks for Solana RPC responses. Start with the pure-logic tests (Phase 1) which require no mocking at all. Mocked tests can be added incrementally.

---

## [ ] Overhaul dashboard for pumpfun-only trading

The current dashboard was built when the bot supported multiple pool types (Raydium AmmV4, CPMM, DLMM). Now that the bot is pumpfun-only, the dashboard has dead weight and missing coverage. Wipe the old UI and rebuild it around what the codebase actually tracks today.

**What to strip out:**
- **Pool detection endpoints** — `/api/pools`, `/api/pools/:id`, and related `getPoolDetections`/`getPoolDetectionStats` calls in `dashboard/server.ts`. These were built for Raydium pool scanning and aren't how pumpfun tokens are detected.
- **Pool type breakdowns** — The `byPoolType` stats (AmmV4/CPMM/DLMM) in `state-store.ts` and the dashboard. Pumpfun tokens don't go through pool detection. Remove AmmV4/CPMM/DLMM references from the models, stats, and UI.
- **Test trade endpoint** — `/api/test-trade` and `handleTestTrade()` in `server.ts` are already stubbed out (`executeTestTrade = null`) since the old Raydium trade module was removed. Delete the dead code.
- **Old filter display** — The dashboard frontend shows "Cheap Gates", "Deep Filters", "Momentum Gate" panels with the old pool-based filter names. Replace with pumpfun pipeline gate names that match `pipeline/cheap-gates.ts` and `pipeline/deep-filters.ts`.

**What to build around (already in the codebase):**
- **Pumpfun position monitor** — `risk/pumpfun-position-monitor.ts` tracks open positions with real-time unrealized P&L via `getStats()` and `getPositions()`. This is the primary data source for the positions panel.
- **Pipeline stats** — `pipeline/pipeline-stats.ts` has `getSnapshot()` with token detection counts, gate pass/fail rates, rejection reasons, and recent tokens. The funnel section should pull from this.
- **P&L tracker** — `risk/pnl-tracker.ts` with `getSessionSummary()` gives realized P&L, win rate, total trades. The P&L panel should use this.
- **Paper trade tracker** — `risk/paper-trade-tracker.ts` is already wired up in the dashboard and works. Keep this.
- **Exposure manager** — `risk/exposure-manager.ts` with `getStats()` and `getWalletBalance()`. Already used in `/api/status`.

**Frontend cleanup:**
- Wipe `dashboard/public/index.html`, `app.js`, `styles.css` and rebuild with only the panels that have real data sources behind them.
- Keep it simple — status/health overview, pipeline funnel, open positions with live P&L, trade history, paper trade panel, and rejection reasons.

Files to look at: `dashboard/server.ts`, `dashboard/public/*`, `risk/pumpfun-position-monitor.ts`, `pipeline/pipeline-stats.ts`, `risk/pnl-tracker.ts`, `persistence/models.ts`

### Implementation Plan

**Difficulty: High**

**Scope:** ~6-8 files modified (`dashboard/server.ts`, `dashboard/public/index.html`, `dashboard/public/app.js`, `dashboard/public/styles.css`, `persistence/models.ts`, `persistence/state-store.ts`). The frontend is a full rewrite.

**Steps:**

1. **Backend cleanup — Remove dead endpoints from `dashboard/server.ts`:**
   - Delete `getApiPools()` method (lines 424-450) and its route (`/api/pools`).
   - Delete `getApiPoolById()` method (lines 455-467) and the `/api/pools/:id` pattern in the default switch case.
   - Remove the `PoolAction`, `PoolType` imports if no longer needed after cleanup.
   - The `/api/stats` endpoint calls `stateStore.getPoolDetectionStats()` — replace the pool-centric stats with pipeline-based stats from `getPipelineStats().getSnapshot()`, or simplify to only return trade/position counts.

2. **Backend cleanup — Remove dead references in state-store:**
   - `getPoolDetections()`, `getPoolDetectionStats()`, `getPoolDetectionCount()`, `getPoolDetectionById()` in `state-store.ts` are only consumed by the dashboard endpoints being removed. Mark them as deprecated or remove if dashboard is the only consumer. Check if pipeline code calls them first.

3. **Frontend — Wipe and rebuild `dashboard/public/`:**
   - **`index.html`** — Rebuild with clean panels: Status/Health, Pipeline Funnel, Open Positions (with live P&L), Trade History, Paper Trades, Rejection Reasons.
   - **`app.js`** — Rewrite the data fetching to use only the active API endpoints:
     - `/api/status` → status panel (uptime, wallet balance, exposure, WS/RPC health)
     - `/api/pipeline-stats` → pipeline funnel (tokens detected → cheap gates → deep filters → momentum → bought)
     - `/api/positions` → open positions table with current P&L %
     - `/api/trades` → recent trades table
     - `/api/pnl` → realized + unrealized P&L summary
     - `/api/paper-trades` → paper trade panel (already working)
   - **`styles.css`** — Clean up. Keep it minimal with a dark theme suitable for monitoring.

4. **Update filter display names** — Replace any references to old Raydium pool-based filter names in the frontend with the actual gate names from `pipeline/cheap-gates.ts` and `pipeline/deep-filters.ts`.

5. **Test the dashboard** — Run the bot in dry-run mode, open the dashboard, verify all panels render correctly and auto-refresh.

**Risks:** This is the highest-effort item because it involves a frontend rewrite. The backend changes are straightforward deletions. The risk is breaking dashboard functionality that's currently working — specifically the paper trades panel and diagnostic endpoints which should be preserved as-is.

**Dependency:** Should be done AFTER the database schema cleanup (TODO #4) so the dashboard is built against the final schema.

---

## [ ] Wipe stale database and clean up schema

The SQLite database (`bot.db`) has accumulated data from the old Raydium-era trading. Since the bot is now pumpfun-only, the existing rows in `positions`, `trades`, `seen_pools`, `pool_detections`, and `session_stats` are from a different trading system and no longer meaningful. Wipe it and tighten the schema.

**Steps:**
- **Delete the old `bot.db` file** on Railway (or add a one-time migration that truncates all tables). The simplest approach is to delete the db file from the Railway volume and let the bot recreate it fresh on next deploy.
- **Clean up the schema** — The `pool_detections` table with its `pool_type` column (AmmV4/CPMM/DLMM) and `pool_quote_reserve` was built for Raydium pools. Either drop it entirely or repurpose it for pumpfun token detections with relevant columns (bonding curve address, market cap at detection, etc.).
- **Remove AmmV4/CPMM/DLMM from PoolType** — In `persistence/models.ts`, the `PoolType` is `'AmmV4' | 'CPMM' | 'DLMM' | 'pumpfun'`. Simplify to just `'pumpfun'` (or remove the type entirely if there's only one).
- **Trim unused columns** — The `positions` table has `pool_id` which made sense for Raydium pools but pumpfun uses bonding curve addresses. Decide if `pool_id` should be repurposed to store the bonding curve address or if a new column is needed.
- **Add a migration v4** — If keeping the database rather than wiping, add a `migrateToV4()` in `state-store.ts` that drops old data and adjusts the schema. Bump `CURRENT_SCHEMA_VERSION` to 4.
- **Update the blacklist** — Review whether any blacklisted tokens/creators are still relevant. Old Raydium-era blacklist entries can be cleared.

Files to look at: `persistence/state-store.ts`, `persistence/models.ts`, `helpers/constants.ts`

### Implementation Plan

**Difficulty: Medium**

**Scope:** 3 files (`persistence/models.ts`, `persistence/state-store.ts`, `helpers/constants.ts`), plus Railway deployment action to delete the old db file.

**Steps:**

1. **Simplify `PoolType` in `persistence/models.ts`:**
   - Change `export type PoolType = 'pumpfun' | 'AmmV4' | 'CPMM' | 'DLMM';` to `export type PoolType = 'pumpfun';`.
   - Alternatively, remove `PoolType` entirely and hardcode `'pumpfun'` everywhere — but keeping the type is cleaner for future extensibility.

2. **Repurpose `pool_detections` table or drop it:**
   - Option A (Recommended): Drop the `pool_detections` table entirely. The pipeline stats (`pipeline-stats.ts`) now track detection metrics in-memory, making this table redundant for pumpfun.
   - Option B: Repurpose it as `token_detections` — rename `pool_id` to `bonding_curve`, drop `pool_quote_reserve`, add `market_cap_at_detection`. This is more work for unclear benefit.

3. **Repurpose `pool_id` in `positions` table:**
   - The bot already stores the bonding curve address in `pool_id` for pumpfun positions (confirmed by checking `pumpfun.ts` which passes bonding curve as `poolId`). So the column works as-is; optionally rename via migration for clarity.

4. **Add migration v4 to `state-store.ts`:**
   ```
   migrateToV4():
     - DROP TABLE IF EXISTS pool_detections
     - DELETE FROM positions (truncate old Raydium data)
     - DELETE FROM trades
     - DELETE FROM seen_pools
     - DELETE FROM session_stats
     - UPDATE blacklist — optionally clear old entries
     - Bump CURRENT_SCHEMA_VERSION to 4
   ```
   Add this as a new case in the `runMigrations()` method, following the existing v1→v2→v3 pattern.

5. **Remove `PoolDetectionRecord` and related interfaces from `models.ts`** — If dropping the table, also remove `PoolDetectionRecord`, `RecordPoolDetectionInput`, `PoolDetectionQueryOptions`, `PoolDetectionStats`, `StoredFilterResult` (lines 196-272). Update imports in `state-store.ts` and `dashboard/server.ts`.

6. **Remove pool detection methods from `state-store.ts`** — Delete `recordPoolDetection()`, `getPoolDetections()`, `getPoolDetectionById()`, `getPoolDetectionCount()`, `getPoolDetectionStats()`.

7. **Railway deployment:**
   - Simplest path: Delete `bot.db` from the Railway volume before deploying the new code. The migration will then create a fresh schema.
   - Alternatively, the v4 migration handles everything, so a fresh deploy with the migration code will wipe old data automatically.

**Risks:** Data loss is intentional here — old Raydium-era data is meaningless. The main risk is missing a reference to a deleted type/method somewhere in the codebase, causing a compile error. Run `npm run tsc` (TypeScript check) after changes.

**Dependency:** This should be done BEFORE the dashboard overhaul, as the dashboard cleanup depends on knowing which DB endpoints still exist.

---

## [ ] Investigate wrong buy amount bug — likely field ordering issue in pumpfun buy instruction encoding

The bot is not trading the quote amount that is specified in config. A previous session's plan agent flagged that the buy instruction encoding in `pumpfun.ts` may have incorrect field ordering, which could be the root cause of the wrong buy amount being sent on-chain.

**What to investigate:**
- **Field ordering in the buy instruction** — Check that the fields passed to the pumpfun buy instruction (amount, max SOL cost, etc.) are in the correct order per the pumpfun program's expected layout. Swapped fields would cause the wrong value to be interpreted as the buy amount.
- **Verify against the pumpfun IDL / on-chain program** — Compare the instruction data layout in `helpers/pumpfun.ts` with the actual pumpfun program's expected byte layout to confirm field positions.
- **Check serialization** — Make sure the BN / buffer encoding matches the expected integer sizes and endianness for each field.
- **Test with a known amount** — Do a paper trade or devnet test with a specific SOL amount and verify the on-chain instruction data matches what was intended.

Files to look at: `helpers/pumpfun.ts`

### Implementation Plan

**Difficulty: High (investigation, not code volume)**

**Scope:** 1 primary file (`helpers/pumpfun.ts`), but requires external verification against the pump.fun program's on-chain IDL.

**Steps:**

1. **Audit the `buildBuyInstruction()` function (line 434 of `pumpfun.ts`):**
   - Current encoding (lines 448-457):
     ```
     discriminator (8 bytes): [102, 6, 61, 18, 1, 218, 235, 234]
     data[8..16]:  tokenAmount (u64, little-endian)
     data[16..24]: maxSolCost  (u64, little-endian)
     ```
   - The pump.fun program's buy instruction expects: `discriminator + token_amount (u64) + max_sol_cost (u64)`.
   - **Verify**: Confirm `tokenAmount` is the number of **tokens** to receive (not lamports of SOL), and `maxSolCost` is the max **lamports** of SOL to spend.

2. **Check the call site that builds `tokenAmount` and `maxSolCost`:**
   - Trace from the `executeBuy()` function to see what values are passed. The concern is that `tokenAmount` (expected tokens) and `maxSolCost` (max SOL) might be swapped, or that `maxSolCost` is being set to a raw SOL amount without converting to lamports.
   - Read the `executeBuy()` function around line 648+ to see how `expectedTokens` and `amountLamports` are calculated and passed to `buildBuyInstruction()`.

3. **Cross-reference with the pump.fun program IDL:**
   - Look up the pump.fun program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) on a Solana explorer.
   - Verify the buy discriminator bytes match `sha256("global:buy")[0..8]`.
   - Verify the instruction data layout: `[discriminator(8), token_amount(8), max_sol_cost(8)]`.

4. **Check the `computeExpectedOutflow()` usage:**
   - The outflow function (lines 85-100) calculates `maxSolCostLamports` with slippage. Verify this value is what gets passed as `maxSolCost` to the instruction.

5. **Build a test case:**
   - Create a unit test that calls `buildBuyInstruction()` with known values (e.g., 1000000 tokens, 100000000 lamports = 0.1 SOL) and deserializes the instruction data buffer to verify fields are in the correct positions.

6. **If the bug is confirmed — fix the field ordering** and add a regression test. If the ordering is correct, the bug may be in how `expectedTokens` is calculated from the bonding curve math (check `calculateExpectedTokens()` or similar functions).

**Risks:** This is a critical trading bug. Getting the fix wrong could result in over-spending SOL. The investigation should be done carefully with on-chain verification before any fix is deployed to live trading. Test on paper trade / dry-run mode first.

**Priority:** This should be the **#1 priority** because it directly affects trading correctness and could be losing money.

---

## [ ] Security check — prevent API keys and private keys from appearing in logs

Audit the entire codebase to ensure that sensitive credentials (private keys, API keys, RPC endpoint secrets) are never printed to logs. Even if most paths look safe today, add defensive guardrails so future code changes can't accidentally leak secrets.

**What to check and fix:**
- **Audit every `logger.*` and `console.log` call** — Confirm no call site passes raw private keys, full RPC URLs with API key query params, or config objects that contain secrets.
- **Expand Pino `redact` paths** — The logger in `helpers/logger.ts` currently only redacts `['poolKeys']`. Add paths for common secret field names (`privateKey`, `secretKey`, `secret`, `apiKey`, `api_key`, `authorization`) so even if a secret ends up in a structured log object it gets masked automatically.
- **Verify `maskUrl()` coverage** — `helpers/rpc-manager.ts` has a `maskUrl()` helper that replaces API key query params with `***`. Confirm every code path that logs an RPC endpoint URL runs it through `maskUrl()` first, including error/catch blocks and fallback logic.
- **Guard startup config logging** — `index.ts` and `bootstrap.ts` log configuration values at startup. Make sure `PRIVATE_KEY` and raw `RPC_ENDPOINT` / `RPC_WEBSOCKET_ENDPOINT` values are never included in these logs.
- **Sanitize error payloads** — Some error objects (especially from RPC responses) could contain the request URL or headers. Check that error serialization in catch blocks doesn't leak endpoint secrets.
- **Add a lint rule or grep check** — Consider adding a CI step or pre-commit hook that greps for patterns like `PRIVATE_KEY`, `secret`, or raw env var references inside log statements to catch future regressions.

Files to look at: `helpers/logger.ts`, `helpers/rpc-manager.ts`, `index.ts`, `bootstrap.ts`, `transactions/`, `listeners/`

### Implementation Plan

**Difficulty: Low**

**Scope:** 1-3 files modified (`helpers/logger.ts` primarily, plus auditing ~10 files for verification)

**Steps:**

1. **Expand Pino `redact` paths in `helpers/logger.ts`:**
   - Current config only redacts `['poolKeys']`. Update to:
     ```typescript
     redact: {
       paths: [
         'poolKeys',
         'privateKey', 'secretKey', 'secret',
         'apiKey', 'api_key', 'authorization',
         '*.privateKey', '*.secretKey', '*.secret',
         '*.apiKey', '*.api_key', '*.authorization',
       ],
       censor: '[REDACTED]',
     }
     ```
   - This ensures any structured log object with these field names gets auto-masked.

2. **Audit `logger.*` calls for secret leakage:**
   - Run `grep -rn 'logger\.\(info\|warn\|error\|debug\)' --include='*.ts'` and review each call for:
     - Raw `process.env.PRIVATE_KEY` references
     - Raw RPC URLs with API keys in query params
     - Full config objects that might contain secrets
   - This is a read-only audit — only fix calls that actually leak secrets.

3. **Verify `maskUrl()` coverage in `rpc-manager.ts`:**
   - The `maskUrl()` method (line 87) already masks query params. Check that every `logger.*` call in `rpc-manager.ts` that includes a URL runs it through `maskUrl()` — confirmed this is already the case (lines 77-79, 148, 153, 179, 187, 207, 226-227).
   - Check error/catch blocks specifically — error objects from failed HTTP requests might embed the request URL.

4. **Guard startup config logging in `index.ts`:**
   - Find the startup config dump and verify `PRIVATE_KEY` and raw RPC endpoint URLs are excluded. If the config log uses `getConfig()`, ensure the returned object doesn't include `privateKey`. The `getApiConfig()` in `dashboard/server.ts` already filters to safe values (lines 558-592) — apply the same pattern to startup logging.

5. **Add a CI grep check (optional):**
   - Add a script or CI step: `grep -rn 'PRIVATE_KEY\|secretKey\|process\.env\.PRIVATE' --include='*.ts' | grep -i 'log\|console' && exit 1 || exit 0`
   - This catches future regressions where someone accidentally logs a secret.

**Risks:** Very low risk. The changes are additive (expanding redact paths) and defensive. The audit is read-only. The only risk is being too aggressive with redaction and masking field names that aren't actually secrets — but the chosen names (`privateKey`, `secretKey`, etc.) are unambiguous.

---

## [ ] Investigate log output vs dashboard mismatch

Dry-run tests show that the logs don't fully match what the dashboard displays. When an AI session is given a dashboard screenshot alongside the corresponding logs, most data lines up but the logs appear incomplete — missing entries or truncated info that the dashboard does show.

**Possible root causes to investigate:**

- **Incomplete log output** — Some data that the dashboard renders may not be getting logged at all, or is logged at a level (`debug`) that isn't visible in the default log output. Check whether every stat/metric the dashboard displays has a corresponding log statement.
- **Context window / truncation issues** — If logs are being consumed by an AI session, long output may be getting truncated by the context window before the AI sees it. Consider whether log output needs to be condensed or summarized to fit.
- **Dashboard showing stale or derived data** — The dashboard may be computing or aggregating values (e.g. rolling averages, cumulative counts) that aren't represented line-for-line in the logs. Verify whether the dashboard is pulling from a data source the logs don't cover.
- **Timing / refresh mismatch** — The dashboard polls or refreshes on an interval. Logs are a point-in-time snapshot. A dry-run screenshot may capture dashboard state that includes updates the logs haven't flushed yet.

Files to look at: `dashboard/server.ts`, `dashboard/public/app.js`, `helpers/logger.ts`, `risk/pumpfun-position-monitor.ts`, `pipeline/pipeline-stats.ts`, `risk/pnl-tracker.ts`

### Implementation Plan

**Difficulty: Medium (investigation-heavy, fix may be small)**

**Scope:** Depends on root cause. Likely 2-4 files (`helpers/logger.ts`, `dashboard/server.ts`, `dashboard/public/app.js`, and possibly `pipeline/pipeline-stats.ts`).

**Steps:**

1. **Catalog what the dashboard displays vs what gets logged:**
   - Run the bot in dry-run mode.
   - Open the dashboard and take note of every metric/stat shown in each panel.
   - Simultaneously capture the log output.
   - For each dashboard metric, find the corresponding log line. Document any metrics that have NO corresponding log output.

2. **Check log levels:**
   - Some dashboard data may come from modules that log at `debug` level while the default log level is `info`. If so, the data exists but isn't visible in default logs.
   - Specifically check: `pipeline/pipeline-stats.ts` gate pass/fail details, `risk/pumpfun-position-monitor.ts` position update cycles.
   - Fix: Either promote key metrics to `info` level, or document that `LOG_LEVEL=debug` is needed for full log parity.

3. **Check derived/aggregated data:**
   - The dashboard's `/api/pipeline-stats` returns `getSnapshot()` which includes calculated fields like `buyRate` and `avgPipelineDurationMs`. These are computed on-the-fly, not logged individually.
   - Fix: Add a periodic summary log (e.g., every 60 seconds) that emits the pipeline snapshot as a structured log entry.

4. **Check timing/polling:**
   - The dashboard frontend (`app.js`) polls on an interval. If the poll captures data between log flushes, the dashboard will show data not yet in logs.
   - This is inherent to the architecture and not a "bug" — document it as expected behavior.

5. **Consider adding a log summarizer output:**
   - The `helpers/log-summarizer.ts` already exists and powers `/api/log-summaries`. Consider having it emit a periodic `logger.info()` with the bucket summary so logs contain the same aggregated view the dashboard shows.

**Risks:** Low risk. This is primarily an investigation task. Any fixes would be additive (adding log lines or promoting log levels), not changing behavior.

**Dependency:** This task benefits from the logging cleanup (TODO #1) being done first, since the module-prefix tagging and log-level changes would affect what appears in logs.

---

# Master Execution Plan

## Recommended Order of Implementation

Based on dependencies, risk, and impact, here is the recommended order:

### Phase 1: Critical Fix (Do First)

| # | TODO | Difficulty | Why First |
|---|------|-----------|-----------|
| 1 | **Investigate wrong buy amount bug** | High | Directly affects trading correctness. If the bot is spending the wrong amount, this is losing money. Must be investigated and fixed before any other work. |

### Phase 2: Security & Stability

| # | TODO | Difficulty | Why Now |
|---|------|-----------|--------|
| 2 | **Security check — prevent secrets in logs** | Low | Quick win, high impact. Expanding Pino redact paths is a ~30 min change. Protects against credential leakage in Railway logs. |
| 3 | **Clean up Railway logs for readability** | Medium | Improves debugging for all subsequent work. Module-tagged logs make it easier to investigate bugs during phases 3-4. |

### Phase 3: Data Layer Cleanup

| # | TODO | Difficulty | Why Now |
|---|------|-----------|--------|
| 4 | **Wipe stale database and clean up schema** | Medium | Must be done before the dashboard overhaul. Removes dead types (`AmmV4`, `CPMM`, `DLMM`) and tables that the dashboard currently references. The dashboard rebuild needs to know the final schema. |

### Phase 4: UI & Observability

| # | TODO | Difficulty | Why Now |
|---|------|-----------|--------|
| 5 | **Overhaul dashboard for pumpfun-only trading** | High | Depends on schema cleanup (Phase 3) and logging cleanup (Phase 2). Now that dead endpoints and types are removed, rebuild the frontend around the remaining data sources. |
| 6 | **Investigate log output vs dashboard mismatch** | Medium | Best done right after the dashboard overhaul, when both systems are freshly aligned. The new dashboard may resolve many of the mismatches on its own. |

### Phase 5: Quality Infrastructure

| # | TODO | Difficulty | Why Last |
|---|------|-----------|----------|
| 7 | **Streamline testing setup** | Medium | Foundational but not blocking anything. The test framework will be most valuable once the other changes are landed — tests can then cover the new, cleaned-up code rather than the legacy code that's about to be rewritten. |

## Difficulty Summary

| TODO | Difficulty | Estimated Files Changed |
|------|-----------|----------------------|
| Investigate buy amount bug | **High** | 1-2 (investigation + fix) |
| Security check (secrets in logs) | **Low** | 1-3 |
| Clean up Railway logs | **Medium** | 15-20 |
| Wipe stale DB / schema cleanup | **Medium** | 3-5 |
| Dashboard overhaul | **High** | 6-8 (frontend rewrite) |
| Log vs dashboard mismatch | **Medium** | 2-4 |
| Testing setup | **Medium** | 10-15 (new files) |

## Dependency Graph

```
Buy Amount Bug ──────────────────────────────────┐
                                                  │
Security Check ──→ Log Cleanup ──→ DB Schema ──→ Dashboard Overhaul ──→ Log/Dashboard Mismatch
                                                  │
                                                  └──→ Testing Setup
```

The buy amount bug is independent and should be tackled immediately. The main chain of dependencies flows: Security → Logging → Schema → Dashboard → Mismatch investigation. Testing setup can happen in parallel with Phase 3-4 but is best done last so tests cover the final codebase.
