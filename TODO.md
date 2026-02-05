# TODO

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
