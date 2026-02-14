# Audit Report: Env Config Dashboard + Railway API Integration

**Branch under review:** `claude/organize-env-variables-Tq13w`
**Audit date:** 2026-02-14
**Verdict:** Safe with Risks

---

## Issues (ordered by severity)

### Issue A — Server-side Railway push accepts arbitrary variable names, including sensitive ones
**Severity: High**
**Files:** `dashboard/server.ts:1465-1476`, `helpers/railway-api.ts:90-134`

The `/api/railway/push` endpoint validates only that `body.variables` is an object
(`server.ts:1466`), then passes it directly to `pushVariablesToRailway()` with no
further checks. There is:

- No validation that variable names belong to the known set in `ENV_CATEGORIES`
- No server-side enforcement excluding sensitive variables (`PRIVATE_KEY`,
  `RPC_ENDPOINT`, `DASHBOARD_PASSWORD`, `RAILWAY_API_TOKEN`, etc.)

The client-side code (`env-config.js:359`) filters out `v.sensitive`, but this is
trivially bypassed via a direct POST request. An authenticated user (or any user
when `DASHBOARD_PASSWORD` is unset) could craft:

```
POST /api/railway/push
{ "variables": { "PRIVATE_KEY": "attacker_key", "ARBITRARY_VAR": "value" } }
```

This would overwrite the bot's private key (or any other variable) on Railway.

**Why it matters:** The UI and documentation explicitly promise that sensitive
variables are "excluded entirely." The server does not enforce this contract.
This is a privilege boundary violation — the Railway push becomes an unrestricted
env-var writer.

**Minimal corrective action:** Add server-side validation in `handleRailwayPush`
that rejects any variable name marked `sensitive: true` in `ENV_CATEGORIES`, and
optionally restrict to the known variable name set.

---

### Issue B — Push to Railway sends all non-sensitive vars, not just changed ones
**Severity: Medium**
**Files:** `dashboard/public/env-config.js:354-365`

The push handler iterates all categories, calls `getEffectiveValue(v)` for each,
and includes any with a truthy value. `getEffectiveValue` (`env-config.js:207-212`)
falls back to `v.defaultValue` when no edited or current value exists. This means:

- Variables that were never set on Railway (and have non-empty defaults like
  `"0.01"`, `"true"`, `"confirmed"`) will be pushed as if the user explicitly
  configured them.
- Variables that were intentionally set to non-default values directly on Railway
  (outside this dashboard) will be overwritten if the dashboard loaded the old value.

**Why it matters:** A user clicking "Push to Railway" immediately after loading
the page would push ~50+ variables including many defaults, potentially overwriting
intentional Railway-side customizations.

**Minimal corrective action:** Track which variables the user actually modified in
the UI session and only push those, or at minimum only push variables that differ
from their default values AND have a current env value.

---

### Issue C — Unauthenticated Railway operations when DASHBOARD_PASSWORD is unset
**Severity: Medium**
**Files:** `dashboard/server.ts:1465-1486`, `dashboard/server.ts:148-157`

When `DASHBOARD_PASSWORD` is not configured (which the code treats as the default),
the `/api/railway/push` and `/api/railway/restart` endpoints are fully accessible
to any client with network access to the dashboard port.

The origin check (`server.ts:426-441`) mitigates browser-based CSRF but does not
protect against direct HTTP requests (scripts, curl, other services on the same
network).

Combined with `Access-Control-Allow-Origin: *` (`server.ts:149`), all GET endpoints
(including `/api/env-reference` which returns current env var values) are also
readable by any website the user visits.

**Why it matters:** The bot is typically deployed on Railway with a public URL.
Without `DASHBOARD_PASSWORD`, anyone who discovers the URL can read configuration
values, push arbitrary env vars to Railway, and trigger bot restarts.

**Minimal corrective action:** Either require `DASHBOARD_PASSWORD` when Railway API
credentials are configured, or add a separate authorization check specific to the
Railway endpoints.

---

### Issue D — No rate limiting on Railway push/restart endpoints
**Severity: Low**
**Files:** `dashboard/server.ts:1465-1486`

The login endpoint has rate limiting (`server.ts:1647-1657`), but the Railway push
and restart endpoints have none. Rapid repeated calls could trigger excessive
Railway API usage or repeated redeployments causing service disruption.

**Why it matters:** A single malicious or errant client could cause continuous
redeploys by hammering `/api/railway/restart`.

**Minimal corrective action:** Add a simple cooldown (e.g., one restart per 60
seconds, one push per 10 seconds) enforced server-side.

---

### Issue E — `escapeAttr` does not escape `&` character
**Severity: Low**
**Files:** `dashboard/public/env-config.js:443-445`

The `escapeAttr` function only escapes `"` and `'`. The `&` character is not
escaped, which could cause incorrect rendering if env var values or placeholders
contain `&` followed by valid entity names. In the current usage context
(double-quoted HTML attribute values from controlled metadata), the risk is
negligible. Values entered by users into text inputs could produce garbled display
on re-render if they contain `&amp;`-like sequences.

**Why it matters:** Minor display corruption possible. Not exploitable as XSS
since the values stay within attribute contexts.

**Minimal corrective action:** Add `.replace(/&/g, '&amp;')` as the first
replacement in `escapeAttr`.

---

## Recommended Immediate Fixes

Only **Issue A** warrants an immediate fix before deployment:

Add server-side allowlisting in `handleRailwayPush` (`server.ts:1465`):
- Build a `Set` of allowed (non-sensitive) variable names from `ENV_CATEGORIES`
- Reject or strip any variable name not in that set before calling
  `pushVariablesToRailway`

Issue C should be addressed soon after, either by requiring auth when Railway
credentials exist, or by gating Railway endpoints behind an explicit opt-in flag.

---

## Audit Confidence: High

All added and modified files were reviewed in full. The change set is
self-contained (3 new files, 4 modified files) with clear boundaries. The
server-side endpoints, client-side logic, metadata definitions, and Railway API
interactions are all visible and comprehensible. No external dependencies were
introduced beyond Node.js built-ins.
