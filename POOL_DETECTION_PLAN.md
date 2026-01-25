# Pool Detection Standardization Plan

> **Status:** Phase 1 - Not Started
> **Objective:** Detect genuinely NEW token launches across all pool types
> **Pool Types:** AMMV4, CPMM, DLMM

---

## Executive Summary

This document outlines the plan to standardize WebSocket-based pool detection across all three supported pool types (Raydium AMMV4, Raydium CPMM, Meteora DLMM). The primary goal is to ensure the bot detects **newly launched tokens**, not just new pools for existing tokens.

**Key Problem Being Solved:**
The current system detects "new pools" but doesn't verify if the underlying token is actually new. An existing token (e.g., a meme coin from weeks ago) could create a new liquidity pool and trigger the bot, leading to trades on tokens that are not fresh launches.

**Solution:**
1. Add token age validation (verify mint was created recently)
2. Standardize detection patterns across all pool types
3. Create unified event emission for consistent downstream processing

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Target Architecture](#2-target-architecture)
3. [Implementation Phases](#3-implementation-phases)
   - [Phase 1A: CPMM Reference Implementation](#phase-1a-cpmm-reference-implementation)
   - [Phase 1B: Apply Pattern to AMMV4](#phase-1b-apply-pattern-to-ammv4)
   - [Phase 1C: Apply Pattern to DLMM](#phase-1c-apply-pattern-to-dlmm)
   - [Phase 1D: Unified Event System](#phase-1d-unified-event-system)
4. [Passing Criteria](#4-passing-criteria)
5. [File Change Map](#5-file-change-map)
6. [Configuration Reference](#6-configuration-reference)
7. [Testing & Validation](#7-testing--validation)

---

## 1. Current State Analysis

### WebSocket Subscription Comparison

| Aspect | AMMV4 | CPMM | DLMM |
|--------|-------|------|------|
| **Program ID** | `675kPX9MHTjS2zt1qrXYaB26ysqC7VycyioQfCqo33j` | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` |
| **Subscription Filters** | dataSize + 3 memcmp | dataSize only | None (variable size) |
| **Handler Filtering** | Minimal | Quote token + status | Everything (discriminator, quote, status, activation) |
| **Data Layout** | `LIQUIDITY_STATE_LAYOUT_V4` | `CpmmPoolInfoLayout` | Custom partial (248 bytes) |
| **Event Emitted** | `'pool'` | `'cpmm-pool'` | `'dlmm-pool'` |

### Current "New Pool" Detection Logic

**Location:** `index.ts:564` and `index.ts:612`

```typescript
// AMMV4 and CPMM
const isNewPool = !exists && poolOpenTime > runTimestamp;

// DLMM (different approach)
const isNewPool = !exists && isActivated;
```

### Critical Gap: No Token Age Validation

**What's Missing:**
- No check if the token mint was recently created
- No verification this is the first pool for the token
- Bot can be triggered by new pools for old tokens

**Evidence:** Search for `getMint`, `mint.*age`, `token.*creation` returns no results related to age checking.

---

## 2. Target Architecture

### Unified Detection Flow

```
WebSocket Event
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│              POOL TYPE DECODER                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐              │
│  │  AMMV4   │  │   CPMM   │  │   DLMM   │              │
│  │ Decoder  │  │ Decoder  │  │ Decoder  │              │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘              │
└───────┼─────────────┼─────────────┼─────────────────────┘
        │             │             │
        └─────────────┼─────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│           UNIFIED VALIDATION PIPELINE                   │
│                                                         │
│  1. Quote Token Check     - Is WSOL in the pair?       │
│  2. Pool Status Check     - Is pool enabled/active?    │
│  3. Pool Timing Check     - Pool created after start?  │
│  4. TOKEN AGE CHECK (NEW) - Mint created recently?     │
│                                                         │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│              UNIFIED EVENT EMISSION                     │
│                                                         │
│  emit('new-token-pool', {                              │
│    poolType: 'AMMV4' | 'CPMM' | 'DLMM',               │
│    poolId,                                             │
│    baseMint,                                           │
│    quoteMint,                                          │
│    tokenAge,        // seconds since mint creation     │
│    isTokenNew,      // true if < MAX_TOKEN_AGE        │
│    ...poolSpecificData                                 │
│  })                                                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### Unified Pool Detection Interface

**New File:** `types/detected-pool.ts`

```typescript
export type PoolType = 'AMMV4' | 'CPMM' | 'DLMM';

export interface DetectedPool {
  // Identity
  poolId: PublicKey;
  poolType: PoolType;

  // Token Information
  baseMint: PublicKey;           // The new token
  quoteMint: PublicKey;          // WSOL
  baseDecimals: number;
  quoteDecimals: number;

  // Timing Information
  poolCreationTime: number;      // When pool was created (unix timestamp)
  detectedAt: number;            // When we detected it (unix timestamp)

  // Token Validation (NEW)
  tokenAge: number;              // Seconds since token mint was created
  isTokenNew: boolean;           // tokenAge <= MAX_TOKEN_AGE_SECONDS
  tokenFirstTxSignature: string; // First transaction for the mint

  // Pool-Specific Raw Data (for trading)
  rawState: LiquidityStateV4 | CpmmPoolState | DlmmPoolState;
}

export interface TokenAgeResult {
  ageSeconds: number;
  firstTxTime: number;
  firstTxSignature: string;
  isNew: boolean;
}
```

---

## 3. Implementation Phases

### Phase 1A: CPMM Reference Implementation

**Goal:** Implement the standardized detection pattern on CPMM first, as a reference for other pool types.

**Why CPMM First:**
- Middle-ground complexity (not as simple as AMMV4, not as complex as DLMM)
- Currently uses handler-based filtering (closer to target pattern)
- Fully implemented trading (can test end-to-end)

#### Tasks

**1A.1: Create Token Age Validator**

**New File:** `helpers/token-validator.ts`

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';

export interface TokenAgeResult {
  ageSeconds: number;
  firstTxTime: number;
  firstTxSignature: string;
  isNew: boolean;
}

export async function getTokenAge(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<TokenAgeResult> {
  const currentTime = Math.floor(Date.now() / 1000);

  try {
    // Get the first transaction for this mint address
    // Using 'before' parameter = null and limit = 1 gets oldest signatures
    // We need to use a different approach: get recent and check
    const signatures = await connection.getSignaturesForAddress(
      mintAddress,
      { limit: 1 },  // Get first/oldest transaction
      'confirmed'
    );

    if (signatures.length === 0) {
      // Brand new mint with no transaction history yet
      // This is actually the ideal case - truly new
      logger.debug({ mint: mintAddress.toString() }, 'Token has no transaction history - brand new');
      return {
        ageSeconds: 0,
        firstTxTime: currentTime,
        firstTxSignature: '',
        isNew: true
      };
    }

    const firstTx = signatures[signatures.length - 1]; // Oldest is last in array
    const firstTxTime = firstTx.blockTime ?? currentTime;
    const ageSeconds = currentTime - firstTxTime;

    return {
      ageSeconds,
      firstTxTime,
      firstTxSignature: firstTx.signature,
      isNew: ageSeconds <= maxAgeSeconds
    };
  } catch (error) {
    logger.error({ mint: mintAddress.toString(), error }, 'Failed to get token age');
    // On error, assume NOT new (fail safe)
    return {
      ageSeconds: Infinity,
      firstTxTime: 0,
      firstTxSignature: '',
      isNew: false
    };
  }
}
```

**1A.2: Add Configuration Constants**

**File:** `helpers/constants.ts`

```typescript
// Token Age Validation
export const MAX_TOKEN_AGE_SECONDS = Number(retrieveEnvVariable('MAX_TOKEN_AGE_SECONDS', logger) || 300);
export const ENABLE_TOKEN_AGE_CHECK = retrieveEnvVariable('ENABLE_TOKEN_AGE_CHECK', logger) !== 'false';
```

**1A.3: Update CPMM Handler in Listeners**

**File:** `listeners/listeners.ts`

Modify the CPMM subscription handler to:
1. Call `getTokenAge()` after basic validation
2. Only emit if token is genuinely new
3. Include token age data in emitted event

**1A.4: Update CPMM Event Handler in index.ts**

**File:** `index.ts`

Update the `'cpmm-pool'` event handler to use the new `DetectedPool` interface.

**1A.5: Add Diagnostic Logging**

Add structured logging at each validation step:
```
[CPMM] WebSocket event received (account: Abc123...)
[CPMM] ├─ Decode: Success
[CPMM] ├─ Quote token (WSOL): PASS
[CPMM] ├─ Pool status (swap enabled): PASS
[CPMM] ├─ Pool timing (after bot start): PASS
[CPMM] ├─ Token age: 45 seconds (max: 300) PASS
[CPMM] └─ EMITTING: New token pool detected
```

#### Passing Criteria for Phase 1A

| Criterion | Validation Method |
|-----------|-------------------|
| Token age check executes | Log shows "Token age: X seconds" for each detected pool |
| Old tokens rejected | Pools with tokens > 5 minutes old are not emitted |
| New tokens accepted | Pools with tokens < 5 minutes old are emitted |
| No false positives | Creating a new pool for an existing token does NOT trigger buy |
| RPC calls work | Token age RPC calls complete without timeout |
| Error handling works | Invalid/failed RPC calls default to "not new" (fail safe) |
| Logging is clear | Each validation step logged with PASS/FAIL |

---

### Phase 1B: Apply Pattern to AMMV4

**Goal:** Apply the same standardized pattern to AMMV4 pool detection.

#### Tasks

**1B.1: Refactor AMMV4 Handler**

Move from subscription-level memcmp filtering to handler-based filtering:
- Keep dataSize filter (efficient pre-filter)
- Move quote token check to handler
- Move status check to handler
- Add token age check

**1B.2: Update Event Emission**

Change from `emit('pool', ...)` to use unified pattern.

**1B.3: Update Bot Handler**

Modify `bot.buy()` to accept `DetectedPool` interface.

#### Passing Criteria for Phase 1B

| Criterion | Validation Method |
|-----------|-------------------|
| Same validation pipeline as CPMM | Logs show identical validation steps |
| Token age check active | Old tokens rejected, new tokens accepted |
| Existing functionality preserved | Bot still buys on valid new token launches |
| No regression | All existing tests/validations still pass |

---

### Phase 1C: Apply Pattern to DLMM

**Goal:** Apply the standardized pattern to DLMM pool detection.

#### Tasks

**1C.1: Standardize DLMM Handler**

DLMM already uses handler-based filtering. Add:
- Token age validation
- Unified event emission

**1C.2: Update Event Emission**

Change from `emit('dlmm-pool', ...)` to unified pattern.

**1C.3: Document DLMM-Specific Considerations**

- Activation point vs pool open time
- Variable account sizes
- Discriminator-based filtering requirement

#### Passing Criteria for Phase 1C

| Criterion | Validation Method |
|-----------|-------------------|
| Token age check active | Logs show token age validation |
| DLMM-specific validation preserved | Discriminator, activation point checks still work |
| Unified event format | DLMM pools emit with same structure as AMMV4/CPMM |

---

### Phase 1D: Unified Event System

**Goal:** Consolidate all pool detection into a single event type.

#### Tasks

**1D.1: Create Unified Event Handler**

**File:** `index.ts`

```typescript
// Replace three separate handlers with one
listener.on('new-token-pool', async (pool: DetectedPool) => {
  logger.info({
    poolType: pool.poolType,
    poolId: pool.poolId.toString(),
    baseMint: pool.baseMint.toString(),
    tokenAge: pool.tokenAge
  }, 'New token pool detected');

  switch (pool.poolType) {
    case 'AMMV4':
      await bot.buy(pool);
      break;
    case 'CPMM':
      await bot.buyCpmm(pool);
      break;
    case 'DLMM':
      await bot.buyDlmm(pool);
      break;
  }
});
```

**1D.2: Remove Legacy Event Handlers**

Remove:
- `listener.on('pool', ...)`
- `listener.on('cpmm-pool', ...)`
- `listener.on('dlmm-pool', ...)`

**1D.3: Update Detection Statistics**

Consolidate stats tracking across all pool types:

```typescript
interface DetectionStats {
  // Per pool type
  ammv4: PoolTypeStats;
  cpmm: PoolTypeStats;
  dlmm: PoolTypeStats;

  // Totals
  totalEvents: number;
  totalEmitted: number;
  totalRejectedTokenAge: number;
}

interface PoolTypeStats {
  events: number;
  invalidStructure: number;
  wrongQuoteToken: number;
  poolNotEnabled: number;
  poolNotNew: number;
  tokenTooOld: number;
  emitted: number;
}
```

#### Passing Criteria for Phase 1D

| Criterion | Validation Method |
|-----------|-------------------|
| Single event type works | All pool types trigger 'new-token-pool' |
| Legacy events removed | No 'pool', 'cpmm-pool', 'dlmm-pool' events |
| Correct routing | AMMV4 calls buy(), CPMM calls buyCpmm(), DLMM calls buyDlmm() |
| Stats unified | Single stats output shows all pool types |

---

## 4. Passing Criteria

### Overall Phase 1 Success Criteria

| # | Criterion | How to Verify |
|---|-----------|---------------|
| 1 | **New tokens detected** | Launch a new token, create pool, bot detects within seconds |
| 2 | **Old tokens rejected** | Create pool for token > 5 min old, bot does NOT trigger |
| 3 | **All pool types work** | Test detection on AMMV4, CPMM, and DLMM pools |
| 4 | **Unified event format** | All pools emit `DetectedPool` structure |
| 5 | **Token age logged** | Every detection shows token age in logs |
| 6 | **Fail-safe behavior** | RPC errors default to "token not new" |
| 7 | **No regressions** | Existing filter system still works |
| 8 | **Stats tracking** | Periodic stats show rejection reasons |

### Verification Test Plan

**Test 1: New Token Launch Detection**
1. Deploy a new token on mainnet (or use devnet for testing)
2. Create liquidity pool immediately after
3. Verify bot detects and logs token age < 60 seconds
4. Verify event is emitted

**Test 2: Old Token Rejection**
1. Find an existing token (> 1 hour old)
2. Create new liquidity pool for it
3. Verify bot detects pool but rejects due to token age
4. Verify NO event is emitted
5. Verify log shows "Token age: X seconds (max: 300) FAIL"

**Test 3: Cross-Pool-Type Consistency**
1. For each pool type (AMMV4, CPMM, DLMM):
   - Verify same validation pipeline executes
   - Verify same log format
   - Verify same event structure emitted

**Test 4: Error Handling**
1. Temporarily break RPC endpoint
2. Verify token age check fails gracefully
3. Verify default behavior is "not new" (fail safe)
4. Verify bot continues running

---

## 5. File Change Map

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `helpers/token-validator.ts` | 1A | Token age validation logic |
| `types/detected-pool.ts` | 1A | Unified pool detection interface |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `helpers/constants.ts` | 1A | Add `MAX_TOKEN_AGE_SECONDS`, `ENABLE_TOKEN_AGE_CHECK` |
| `listeners/listeners.ts` | 1A-1C | Add token age validation to all handlers, unified event emission |
| `index.ts` | 1D | Replace 3 event handlers with 1 unified handler |
| `bot.ts` | 1B | Update `buy()` signature to accept `DetectedPool` (optional, can use adapter) |

### Files NOT Changed (Phase 1)

| File | Reason |
|------|--------|
| `filters/*.ts` | Filter system unchanged in Phase 1 |
| `transactions/*.ts` | Execution unchanged in Phase 1 |
| `persistence/*.ts` | Persistence unchanged in Phase 1 |
| `risk/*.ts` | Risk management unchanged in Phase 1 |

---

## 6. Configuration Reference

### New Environment Variables

```bash
# ═══════════════════════════════════════════════════════════════
# TOKEN AGE VALIDATION (Phase 1)
# ═══════════════════════════════════════════════════════════════

# Maximum age in seconds for a token to be considered "new"
# Tokens older than this will be rejected
# Default: 300 (5 minutes)
MAX_TOKEN_AGE_SECONDS=300

# Enable/disable token age checking
# Set to 'false' to disable (not recommended)
# Default: true
ENABLE_TOKEN_AGE_CHECK=true
```

### Configuration Recommendations

| Scenario | MAX_TOKEN_AGE_SECONDS | Rationale |
|----------|----------------------|-----------|
| Conservative | 120 (2 min) | Only catch the freshest launches |
| Standard | 300 (5 min) | Good balance of coverage and safety |
| Aggressive | 600 (10 min) | Catch more launches, higher risk |

---

## 7. Testing & Validation

### Manual Testing Checklist

#### Phase 1A (CPMM)
- [ ] Token age validator compiles without errors
- [ ] Constants added to `helpers/constants.ts`
- [ ] CPMM handler calls token age validator
- [ ] Log output shows token age for CPMM pools
- [ ] New token (< 5 min) triggers event emission
- [ ] Old token (> 5 min) does NOT trigger event emission
- [ ] RPC error results in fail-safe (no emission)

#### Phase 1B (AMMV4)
- [ ] AMMV4 handler refactored to handler-based filtering
- [ ] Token age validation added
- [ ] Log output matches CPMM format
- [ ] Buy functionality still works

#### Phase 1C (DLMM)
- [ ] DLMM handler includes token age validation
- [ ] Log output matches CPMM/AMMV4 format
- [ ] DLMM-specific checks still work (discriminator, activation)

#### Phase 1D (Unified Events)
- [ ] All pool types emit `'new-token-pool'` event
- [ ] Legacy events removed
- [ ] Unified event handler routes to correct buy function
- [ ] Stats show all pool types

### Log Output Examples

**Successful Detection (New Token):**
```
[2024-01-15 10:30:45] INFO  [CPMM] WebSocket event received
[2024-01-15 10:30:45] DEBUG [CPMM] ├─ Account: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
[2024-01-15 10:30:45] DEBUG [CPMM] ├─ Decode: Success (CpmmPoolInfoLayout)
[2024-01-15 10:30:45] DEBUG [CPMM] ├─ Quote token check: PASS (mintB = WSOL)
[2024-01-15 10:30:45] DEBUG [CPMM] ├─ Pool status check: PASS (swap enabled)
[2024-01-15 10:30:45] DEBUG [CPMM] ├─ Pool timing check: PASS (opened after bot start)
[2024-01-15 10:30:45] DEBUG [CPMM] ├─ Token age check: 47s (max: 300s) PASS
[2024-01-15 10:30:45] INFO  [CPMM] └─ EMITTING: New token pool detected
[2024-01-15 10:30:45] INFO  New token pool: type=CPMM mint=ABC123... age=47s
```

**Rejected Detection (Old Token):**
```
[2024-01-15 10:35:12] INFO  [AMMV4] WebSocket event received
[2024-01-15 10:35:12] DEBUG [AMMV4] ├─ Account: 9yZXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBsV
[2024-01-15 10:35:12] DEBUG [AMMV4] ├─ Decode: Success (LIQUIDITY_STATE_LAYOUT_V4)
[2024-01-15 10:35:12] DEBUG [AMMV4] ├─ Quote token check: PASS
[2024-01-15 10:35:12] DEBUG [AMMV4] ├─ Pool status check: PASS
[2024-01-15 10:35:12] DEBUG [AMMV4] ├─ Pool timing check: PASS
[2024-01-15 10:35:12] DEBUG [AMMV4] ├─ Token age check: 3847s (max: 300s) FAIL
[2024-01-15 10:35:12] INFO  [AMMV4] └─ REJECTED: Token too old (3847s > 300s)
```

**Periodic Stats Output:**
```
[2024-01-15 11:00:00] INFO  === Pool Detection Stats (last 60 minutes) ===
[2024-01-15 11:00:00] INFO  AMMV4:  events=1247 | emitted=3 | rejected: structure=0 quote=892 status=12 timing=298 tokenAge=42
[2024-01-15 11:00:00] INFO  CPMM:   events=456  | emitted=2 | rejected: structure=0 quote=312 status=8  timing=127 tokenAge=7
[2024-01-15 11:00:00] INFO  DLMM:   events=2341 | emitted=1 | rejected: structure=1892 quote=287 status=45 timing=98 tokenAge=18
[2024-01-15 11:00:00] INFO  TOTAL:  events=4044 | emitted=6 | tokenAge rejections=67
```

---

## Next Steps

After Phase 1 is complete, the following phases will address:

- **Phase 2:** Filter System Standardization (adapt filters for unified pool format)
- **Phase 3:** Trading Execution Standardization (unified buy/sell interface)
- **Phase 4:** Position Monitoring Standardization (unified TP/SL monitoring)

These phases will be documented in separate plan updates once Phase 1 is validated.

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2024-01-25 | 1.0 | Initial plan created |
