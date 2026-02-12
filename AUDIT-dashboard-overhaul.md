# Code Audit Report — Branch `claude/dashboard-overhaul-YjWeP`

**Auditor:** Claude Code (automated)
**Date:** 2026-02-12
**Commits audited:** b3df2b4, 948e492, 4b2101b, a0d9f36
**Base:** 21a005e (main)
**Files reviewed:** 13 (all changed files read in full)

---

## 1. Audit Verdict: Safe with Risks

The changes are functionally sound and the core intent (dashboard overhaul, wallet
balance fallback, TypeScript compile fix) is correctly implemented. No critical
regressions or broken logic were found. However, there are multiple medium-severity
XSS vulnerabilities in the client-side dashboard code that should be addressed.

---

## 2. Issues (ordered by severity)

### Issue 1 — XSS via innerHTML with unescaped API data

- **Severity:** Medium
- **Files:** `dashboard/public/home.js`, `dashboard/public/production.js`, `dashboard/public/smoke-test.js`, `dashboard/public/diagnostic.html`
- **Description:** Multiple client-side files inject API response data into the DOM
  via `.innerHTML` without HTML escaping. Solana token names/symbols can contain
  arbitrary text. Key locations:
  - `home.js:179` — `item.name` (infra breakdown) injected unescaped
  - `home.js:312` — `run.summary` injected unescaped
  - `production.js:234` — `formatRejectionReason(item.reason)` does case-conversion but no escaping
  - `smoke-test.js:95-96` — `step.name` and `step.details` injected unescaped
  - `diagnostic.html:189` — `r.tokenSymbol` directly concatenated in HTML string
- **Why it matters:** If any API response contains attacker-controlled data (e.g., a
  malicious token name), it could execute arbitrary JavaScript in the dashboard
  viewer's browser. The dashboard listens with `Access-Control-Allow-Origin: *`.
- **Mitigation context:** `production.js` already has `escapeHtml()` and uses it for
  token name/symbol, but inconsistently for other fields. `home.js` and
  `smoke-test.js` lack the function entirely.
- **Corrective action:** Add `escapeHtml()` to all files using innerHTML with API
  data and apply it consistently to all string fields from API responses.

### Issue 2 — Unescaped error message in bootstrap HTML response

- **Severity:** Medium
- **File:** `bootstrap.ts:114-124`
- **Description:** When `startupState === 'failed'`, the `startupError` string is
  interpolated directly into an HTML response: `<h2>Failed: ${startupError}</h2>`.
  Exception messages can contain angle brackets or other HTML characters.
- **Corrective action:** Escape `statusLabel` before embedding in the HTML response.

### Issue 3 — No request body size limit in parseRequestBody

- **Severity:** Low
- **File:** `dashboard/server.ts:402-417`
- **Description:** `parseRequestBody` accumulates the entire request body without
  any size limit. The dashboard has CORS `*` and no authentication. A large POST
  body could exhaust memory.
- **Corrective action:** Add a maximum body size check (e.g., reject > 1 MB).

### Issue 4 — Wildcard CORS with no authentication on state-mutating endpoints

- **Severity:** Low
- **File:** `dashboard/server.ts:139-141`
- **Description:** `Access-Control-Allow-Origin: *` with POST endpoints that reset
  stats and clear paper trades. Any webpage on the same network can call these.
- **Corrective action:** No immediate action if dashboard is always on private
  network. Restrict CORS if ever exposed publicly.

### Issue 5 — Unused parsed body in POST handler

- **Severity:** Low
- **File:** `dashboard/server.ts:373`
- **Description:** `const body = await this.parseRequestBody(req);` — the result is
  never used. All three POST handlers ignore the request body.
- **Corrective action:** Remove the `parseRequestBody` call or defer to handlers
  that need it.

---

## 3. Recommended Immediate Fixes

Only Issue 1 warrants immediate attention:

1. Add `escapeHtml` to `home.js` and `smoke-test.js` (they currently lack it)
   and ensure all string data from API responses is escaped before innerHTML insertion.
2. Use `escapeHtml` consistently in `production.js` for rejection reasons and
   run summaries.
3. Escape `r.tokenSymbol` in `diagnostic.html` inline script.

Issues 2-5 are lower priority and can be addressed in a follow-up.

---

## 4. Verified Safe

The following aspects of the changes were verified and found correct:

- **Wallet balance fallback** (`server.ts:711-735`): Correctly creates a cached RPC
  connection when `exposureManager` is null (AB/smoke modes). The null guard at
  lines 727-728 satisfies TypeScript and prevents runtime errors.
- **Directory traversal protection** (`server.ts:1333`): `path.normalize()` resolves
  embedded `../` references, and the regex strips leading `../` patterns. Combined
  with `path.join`, the resolved path is always within `publicDir`.
- **Connection status override** (`server.ts:449-451, 506-508`): Correctly reports
  connected=true for AB/smoke modes which manage their own websocket connections.
- **Bootstrap flow** (`bootstrap.ts`): AB and smoke modes correctly start the
  dashboard, mark state as ready, and keep the server running for result viewing.
- **AB store caching** (`server.ts:1259-1272`): Properly checks for database
  existence before opening, caches the instance, and closes it on server stop.
- **Config/wallet imports**: `getWallet()` returns a Keypair with `.publicKey`,
  `config.privateKey` is a required validated field, `ABTestStore` constructor
  accepts `dataDir` — all verified against source.

---

## 5. Audit Confidence: High

All 13 changed files were read in full. Critical dependency chains were verified
against source (wallet helper, config-validator, exposure-manager initialization,
ABTestStore constructor). Path traversal, null-safety, and mode-switching logic
were analyzed and confirmed correct.
