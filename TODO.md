# TODO list

Tracking future tasks and improvements for the trading bot.

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

---

## [ ] Investigate wrong buy amount bug — likely field ordering issue in pumpfun buy instruction encoding

The bot is not trading the quote amount that is specified in config. A previous session's plan agent flagged that the buy instruction encoding in `pumpfun.ts` may have incorrect field ordering, which could be the root cause of the wrong buy amount being sent on-chain.

**What to investigate:**
- **Field ordering in the buy instruction** — Check that the fields passed to the pumpfun buy instruction (amount, max SOL cost, etc.) are in the correct order per the pumpfun program's expected layout. Swapped fields would cause the wrong value to be interpreted as the buy amount.
- **Verify against the pumpfun IDL / on-chain program** — Compare the instruction data layout in `helpers/pumpfun.ts` with the actual pumpfun program's expected byte layout to confirm field positions.
- **Check serialization** — Make sure the BN / buffer encoding matches the expected integer sizes and endianness for each field.
- **Test with a known amount** — Do a paper trade or devnet test with a specific SOL amount and verify the on-chain instruction data matches what was intended.

Files to look at: `helpers/pumpfun.ts`

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

---

## [ ] Investigate log output vs dashboard mismatch

Dry-run tests show that the logs don't fully match what the dashboard displays. When an AI session is given a dashboard screenshot alongside the corresponding logs, most data lines up but the logs appear incomplete — missing entries or truncated info that the dashboard does show.

**Possible root causes to investigate:**

- **Incomplete log output** — Some data that the dashboard renders may not be getting logged at all, or is logged at a level (`debug`) that isn't visible in the default log output. Check whether every stat/metric the dashboard displays has a corresponding log statement.
- **Context window / truncation issues** — If logs are being consumed by an AI session, long output may be getting truncated by the context window before the AI sees it. Consider whether log output needs to be condensed or summarized to fit.
- **Dashboard showing stale or derived data** — The dashboard may be computing or aggregating values (e.g. rolling averages, cumulative counts) that aren't represented line-for-line in the logs. Verify whether the dashboard is pulling from a data source the logs don't cover.
- **Timing / refresh mismatch** — The dashboard polls or refreshes on an interval. Logs are a point-in-time snapshot. A dry-run screenshot may capture dashboard state that includes updates the logs haven't flushed yet.

Files to look at: `dashboard/server.ts`, `dashboard/public/app.js`, `helpers/logger.ts`, `risk/pumpfun-position-monitor.ts`, `pipeline/pipeline-stats.ts`, `risk/pnl-tracker.ts`
