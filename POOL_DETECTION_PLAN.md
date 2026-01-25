# Pool Detection Standardization Plan

> **Status:** Phase 0 - Not Started
> **Objective:** Detect genuinely NEW token launches across all pool types
> **Pool Types:** AMMV4, CPMM, DLMM
> **Last Updated:** 2025-01-25 (v2.0 - Mint-First Architecture)

---

## Executive Summary

This document outlines the plan to standardize WebSocket-based pool detection across all three supported pool types (Raydium AMMV4, Raydium CPMM, Meteora DLMM). The primary goal is to ensure the bot detects **newly launched tokens**, not just new pools for existing tokens.

**Key Problem Being Solved:**
The current system detects "new pools" but doesn't verify if the underlying token is actually new. An existing token (e.g., a meme coin from weeks ago) could create a new liquidity pool and trigger the bot, leading to trades on tokens that are not fresh launches.

**Solution (v2.0 - Mint-First Architecture):**
1. **Primary:** Detect newly minted tokens via Helius (mint events) → cache them
2. **Secondary:** When pool detected, only promote if mint is in "recently minted" cache
3. **Fallback:** Use Helius `getTransactionsForAddress` with `sortOrder: "asc"` for edge cases
4. **Scoring:** Use launch confidence score instead of binary yes/no
5. **Pre-filter:** Require minimum liquidity before promoting to full filter pipeline

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Target Architecture](#2-target-architecture)
3. [Implementation Phases](#3-implementation-phases)
   - [Phase 0: Helius Mint Detection (Primary Truth)](#phase-0-helius-mint-detection-primary-truth)
   - [Phase 1A: CPMM Reference Implementation](#phase-1a-cpmm-reference-implementation)
   - [Phase 1B: Apply Pattern to AMMV4](#phase-1b-apply-pattern-to-ammv4)
   - [Phase 1C: Apply Pattern to DLMM](#phase-1c-apply-pattern-to-dlmm)
   - [Phase 1D: Unified Event System](#phase-1d-unified-event-system)
4. [Launch Confidence Scoring](#4-launch-confidence-scoring)
5. [Passing Criteria](#5-passing-criteria)
6. [File Change Map](#6-file-change-map)
7. [Configuration Reference](#7-configuration-reference)
8. [Testing & Validation](#8-testing--validation)

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

### Critical Gaps Identified

| Gap | Problem | Impact |
|-----|---------|--------|
| **No token mint detection** | Only detects pools, not when token was created | Old tokens with new pools trigger bot |
| **Signature order bug** | `getSignaturesForAddress` returns newest first, not oldest | Would get wrong "creation time" |
| **Binary detection** | Simple yes/no instead of confidence scoring | Edge cases slip through |
| **No liquidity pre-filter** | Any pool triggers, even with 0.001 SOL | Noise from junk pools |

---

## 2. Target Architecture

### Mint-First Detection Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 HELIUS MINT DETECTION (PRIMARY)                  │
│                                                                 │
│  WebSocket/Webhook monitoring Token Program for:                │
│  • InitializeMint / InitializeMint2 instructions               │
│  • pump.fun program mint events                                 │
│                                                                 │
│  On new mint detected:                                          │
│  → Add to RECENTLY_MINTED_CACHE with timestamp                 │
│  → TTL: MAX_TOKEN_AGE_SECONDS (default 300s)                   │
│                                                                 │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    POOL DETECTION (SECONDARY)                    │
│                                                                 │
│  Existing WebSocket subscriptions for:                          │
│  • AMMV4 pools                                                  │
│  • CPMM pools                                                   │
│  • DLMM pools                                                   │
│                                                                 │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  LAUNCH CONFIDENCE SCORING                       │
│                                                                 │
│  +2  Mint in RECENTLY_MINTED_CACHE (Helius detected)           │
│  +1  Pool created within time window                            │
│  +1  Token metadata appears quickly (optional)                  │
│  -2  Mint has activity far before window (fallback check)       │
│                                                                 │
│  REQUIRE: score >= 2 to proceed                                 │
│                                                                 │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              MEANINGFUL POOL PRE-FILTER                          │
│                                                                 │
│  Before full filter pipeline, require:                          │
│  • Quote is WSOL (or configured quote token)                   │
│  • Pool is enabled/active                                       │
│  • Liquidity >= MIN_POOL_LIQUIDITY_SOL (default: 1 SOL)        │
│                                                                 │
│  This is DETECTION filtering, not full safety filters          │
│                                                                 │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              UNIFIED EVENT EMISSION                              │
│                                                                 │
│  emit('new-token-pool', {                                       │
│    poolType: 'AMMV4' | 'CPMM' | 'DLMM',                        │
│    poolId,                                                      │
│    baseMint,                                                    │
│    quoteMint,                                                   │
│    launchScore,         // Confidence score                    │
│    mintDetectedVia,     // 'helius' | 'fallback'               │
│    tokenAge,            // Seconds since mint                  │
│    initialLiquidity,    // SOL in pool                         │
│    ...poolSpecificData                                          │
│  })                                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

**Why Mint-First?**
- The mint event IS the token creation - this is ground truth
- Pool detection alone can't distinguish new token vs new pool for old token
- Helius explicitly supports mint event monitoring ([source](https://www.helius.dev/blog/how-to-fetch-newly-minted-tokens-with-helius))
- Reduces expensive RPC calls for token age validation

**Why Confidence Scoring?**
- Binary yes/no has edge cases (migrations, re-listings, pool spam)
- Scoring allows tuning sensitivity
- Can add/remove scoring factors without rewriting logic

**Why Minimum Liquidity Pre-Filter?**
- Prevents noise from junk pools with tiny liquidity
- Still "detection" not "safety filter"
- Cheap check before expensive filter pipeline

---

## 3. Implementation Phases

### Phase 0: Helius Mint Detection (Primary Truth)

**Goal:** Establish mint detection as the canonical source for "new token" events.

**Why This Phase First:**
- Provides ground truth for token creation time
- Eliminates the signature order bug problem
- Reduces RPC budget for fallback checks
- Foundation for confidence scoring

#### Tasks

**0.1: Create Mint Detection Cache**

**New File:** `cache/mint.cache.ts`

```typescript
import { PublicKey } from '@solana/web3.js';
import { logger } from '../helpers/logger';

interface MintCacheEntry {
  mint: PublicKey;
  detectedAt: number;        // Unix timestamp when we saw the mint
  source: 'helius' | 'fallback';
  signature?: string;        // First tx signature if available
}

class MintCache {
  private cache: Map<string, MintCacheEntry> = new Map();
  private ttlMs: number;

  constructor(ttlSeconds: number = 300) {
    this.ttlMs = ttlSeconds * 1000;
    // Cleanup expired entries every 60 seconds
    setInterval(() => this.cleanup(), 60000);
  }

  add(mint: PublicKey, source: 'helius' | 'fallback', signature?: string): void {
    const key = mint.toString();
    if (!this.cache.has(key)) {
      this.cache.set(key, {
        mint,
        detectedAt: Date.now(),
        source,
        signature
      });
      logger.debug({ mint: key, source }, 'Added mint to recently minted cache');
    }
  }

  get(mint: PublicKey): MintCacheEntry | undefined {
    const key = mint.toString();
    const entry = this.cache.get(key);
    if (entry && this.isValid(entry)) {
      return entry;
    }
    return undefined;
  }

  has(mint: PublicKey): boolean {
    return this.get(mint) !== undefined;
  }

  getAge(mint: PublicKey): number | undefined {
    const entry = this.get(mint);
    if (entry) {
      return Math.floor((Date.now() - entry.detectedAt) / 1000);
    }
    return undefined;
  }

  private isValid(entry: MintCacheEntry): boolean {
    return Date.now() - entry.detectedAt < this.ttlMs;
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.detectedAt >= this.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ removed, remaining: this.cache.size }, 'Mint cache cleanup');
    }
  }

  getStats(): { size: number; oldestAge: number } {
    let oldestAge = 0;
    const now = Date.now();
    for (const entry of this.cache.values()) {
      const age = Math.floor((now - entry.detectedAt) / 1000);
      if (age > oldestAge) oldestAge = age;
    }
    return { size: this.cache.size, oldestAge };
  }
}

export const mintCache = new MintCache();
```

**0.2: Create Helius Mint Listener**

**New File:** `listeners/mint-listener.ts`

Two approaches (implement one, document both):

**Approach A: Geyser Enhanced WebSocket (Recommended)**

Monitor Token Program for InitializeMint instructions:

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { mintCache } from '../cache/mint.cache';
import { logger } from '../helpers/logger';

// Token Program ID
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
// Token 2022 Program ID
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

export class MintListener {
  private connection: Connection;
  private subscriptionIds: number[] = [];

  constructor(connection: Connection) {
    this.connection = connection;
  }

  async start(): Promise<void> {
    logger.info('Starting Helius mint detection listener');

    // Subscribe to Token Program logs
    const tokenSubId = this.connection.onLogs(
      TOKEN_PROGRAM_ID,
      (logs) => this.handleLogs(logs, 'token-program'),
      'confirmed'
    );
    this.subscriptionIds.push(tokenSubId);

    // Subscribe to Token 2022 Program logs
    const token2022SubId = this.connection.onLogs(
      TOKEN_2022_PROGRAM_ID,
      (logs) => this.handleLogs(logs, 'token-2022'),
      'confirmed'
    );
    this.subscriptionIds.push(token2022SubId);

    logger.info({ subscriptions: this.subscriptionIds.length }, 'Mint detection subscriptions active');
  }

  private handleLogs(logs: any, source: string): void {
    // Look for InitializeMint or InitializeMint2 instructions
    const logMessages = logs.logs || [];

    for (const log of logMessages) {
      if (log.includes('Instruction: InitializeMint') ||
          log.includes('Instruction: InitializeMint2')) {

        // Extract mint address from the transaction
        // The mint is typically in the account keys
        const signature = logs.signature;

        // We need to fetch the transaction to get the mint address
        this.processMintTransaction(signature, source);
        break;
      }
    }
  }

  private async processMintTransaction(signature: string, source: string): Promise<void> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });

      if (!tx?.meta || tx.meta.err) return;

      // Find the mint account from the transaction
      // Look for the account that was initialized as a mint
      const instructions = tx.transaction.message.instructions;

      for (const ix of instructions) {
        if ('parsed' in ix && ix.parsed?.type === 'initializeMint') {
          const mintAddress = new PublicKey(ix.parsed.info.mint);
          mintCache.add(mintAddress, 'helius', signature);

          logger.info({
            mint: mintAddress.toString(),
            signature,
            source
          }, 'New token mint detected via Helius');
        }
      }
    } catch (error) {
      logger.error({ signature, error }, 'Failed to process mint transaction');
    }
  }

  async stop(): Promise<void> {
    for (const subId of this.subscriptionIds) {
      await this.connection.removeOnLogsListener(subId);
    }
    this.subscriptionIds = [];
    logger.info('Mint detection listener stopped');
  }
}
```

**Approach B: Helius Webhook (Alternative)**

Configure a webhook in Helius dashboard to POST to your endpoint when mint events occur.

```typescript
// Express endpoint for Helius webhook
app.post('/webhook/mint', (req, res) => {
  const { type, events } = req.body;

  for (const event of events) {
    if (event.type === 'TOKEN_MINT') {
      const mintAddress = new PublicKey(event.tokenMint);
      mintCache.add(mintAddress, 'helius', event.signature);
    }
  }

  res.status(200).send('OK');
});
```

**0.3: Create Fallback Token Age Validator**

**New File:** `helpers/token-validator.ts`

Uses Helius `getTransactionsForAddress` with `sortOrder: "asc"` for correct oldest-first ordering.

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { mintCache } from '../cache/mint.cache';
import { logger } from './logger';

export interface TokenAgeResult {
  ageSeconds: number;
  firstTxTime: number;
  firstTxSignature: string;
  isNew: boolean;
  source: 'cache' | 'helius-history' | 'error';
}

/**
 * Get token age with proper ordering.
 *
 * IMPORTANT: Standard getSignaturesForAddress returns NEWEST first (descending).
 * We use Helius getTransactionsForAddress with sortOrder: "asc" for OLDEST first.
 *
 * Reference: https://www.helius.dev/docs/rpc/gettransactionsforaddress
 */
export async function getTokenAge(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<TokenAgeResult> {
  const currentTime = Math.floor(Date.now() / 1000);

  // First check cache (fastest path)
  const cachedAge = mintCache.getAge(mintAddress);
  if (cachedAge !== undefined) {
    const cached = mintCache.get(mintAddress)!;
    return {
      ageSeconds: cachedAge,
      firstTxTime: Math.floor(cached.detectedAt / 1000),
      firstTxSignature: cached.signature || '',
      isNew: cachedAge <= maxAgeSeconds,
      source: 'cache'
    };
  }

  // Fallback: Use Helius getTransactionsForAddress with sortOrder: "asc"
  try {
    // This is a Helius-specific RPC method
    // @ts-ignore - Custom Helius method
    const response = await connection._rpcRequest('getTransactionsForAddress', [
      mintAddress.toString(),
      {
        limit: 1,
        sortOrder: 'asc',  // CRITICAL: Oldest first
        transactionDetails: 'signatures'
      }
    ]);

    if (response.result && response.result.length > 0) {
      const firstTx = response.result[0];
      const firstTxTime = firstTx.blockTime ?? currentTime;
      const ageSeconds = currentTime - firstTxTime;

      // Add to cache for future lookups
      mintCache.add(mintAddress, 'fallback', firstTx.signature);

      return {
        ageSeconds,
        firstTxTime,
        firstTxSignature: firstTx.signature,
        isNew: ageSeconds <= maxAgeSeconds,
        source: 'helius-history'
      };
    }

    // No history found - likely brand new
    logger.debug({ mint: mintAddress.toString() }, 'Token has no transaction history');
    return {
      ageSeconds: 0,
      firstTxTime: currentTime,
      firstTxSignature: '',
      isNew: true,
      source: 'helius-history'
    };

  } catch (error) {
    logger.error({ mint: mintAddress.toString(), error }, 'Failed to get token age via Helius');

    // FAIL SAFE: On error, assume NOT new
    return {
      ageSeconds: Infinity,
      firstTxTime: 0,
      firstTxSignature: '',
      isNew: false,
      source: 'error'
    };
  }
}

/**
 * Standard Solana RPC fallback (less reliable for "oldest first")
 *
 * WARNING: getSignaturesForAddress returns signatures in REVERSE chronological
 * order (newest first). This makes finding the "first" transaction expensive
 * as you'd need to paginate through ALL signatures.
 *
 * Only use this if Helius getTransactionsForAddress is unavailable.
 */
export async function getTokenAgeStandardRpc(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<TokenAgeResult> {
  const currentTime = Math.floor(Date.now() / 1000);

  try {
    // Get recent signatures (newest first - this is a limitation)
    const signatures = await connection.getSignaturesForAddress(
      mintAddress,
      { limit: 1000 },  // Get many to increase chance of finding oldest
      'confirmed'
    );

    if (signatures.length === 0) {
      return {
        ageSeconds: 0,
        firstTxTime: currentTime,
        firstTxSignature: '',
        isNew: true,
        source: 'helius-history'
      };
    }

    // Last in array is oldest (within our limit)
    // WARNING: This may not be the TRUE oldest if token has >1000 txs
    const oldestInBatch = signatures[signatures.length - 1];
    const oldestTime = oldestInBatch.blockTime ?? currentTime;
    const ageSeconds = currentTime - oldestTime;

    // If oldest in batch is already too old, token is definitely old
    if (ageSeconds > maxAgeSeconds) {
      return {
        ageSeconds,
        firstTxTime: oldestTime,
        firstTxSignature: oldestInBatch.signature,
        isNew: false,
        source: 'helius-history'
      };
    }

    // If we got fewer than limit, we have all signatures
    if (signatures.length < 1000) {
      mintCache.add(mintAddress, 'fallback', oldestInBatch.signature);
      return {
        ageSeconds,
        firstTxTime: oldestTime,
        firstTxSignature: oldestInBatch.signature,
        isNew: true,
        source: 'helius-history'
      };
    }

    // Got exactly 1000 - there may be more, oldest is unknown
    // Be conservative: treat as old
    logger.warn({
      mint: mintAddress.toString(),
      signaturesFound: signatures.length
    }, 'Token has many signatures, cannot determine true age - treating as old');

    return {
      ageSeconds: Infinity,
      firstTxTime: 0,
      firstTxSignature: '',
      isNew: false,
      source: 'helius-history'
    };

  } catch (error) {
    logger.error({ mint: mintAddress.toString(), error }, 'Failed to get token age');
    return {
      ageSeconds: Infinity,
      firstTxTime: 0,
      firstTxSignature: '',
      isNew: false,
      source: 'error'
    };
  }
}
```

#### Passing Criteria for Phase 0

| Criterion | Validation Method |
|-----------|-------------------|
| Mint cache created | Cache stores mints with TTL |
| Helius mint listener active | Logs show "New token mint detected" on real mints |
| Cache populated | Stats show cache size > 0 during active period |
| Fallback uses correct order | Uses `sortOrder: "asc"` not default descending |
| TTL cleanup works | Old entries removed after MAX_TOKEN_AGE_SECONDS |

---

### Phase 1A: CPMM Reference Implementation

**Goal:** Implement the standardized detection pattern on CPMM first, integrating with Phase 0 mint cache.

#### Tasks

**1A.1: Create Launch Confidence Scorer**

**New File:** `helpers/launch-scorer.ts`

```typescript
import { PublicKey } from '@solana/web3.js';
import { mintCache } from '../cache/mint.cache';
import { getTokenAge, TokenAgeResult } from './token-validator';
import { Connection } from '@solana/web3.js';
import { logger } from './logger';

export interface LaunchScore {
  score: number;
  breakdown: {
    mintInCache: number;        // +2 if in recently minted cache
    poolTiming: number;         // +1 if pool created within window
    metadataPresent: number;    // +1 if metadata exists (optional)
    oldActivityPenalty: number; // -2 if activity before window (fallback)
  };
  tokenAge: TokenAgeResult;
  isLaunch: boolean;           // score >= threshold
}

const SCORE_MINT_IN_CACHE = 2;
const SCORE_POOL_TIMING = 1;
const SCORE_METADATA = 1;
const PENALTY_OLD_ACTIVITY = -2;
const LAUNCH_THRESHOLD = 2;

export async function calculateLaunchScore(
  connection: Connection,
  baseMint: PublicKey,
  poolCreationTime: number,
  runTimestamp: number,
  maxTokenAgeSeconds: number
): Promise<LaunchScore> {
  const breakdown = {
    mintInCache: 0,
    poolTiming: 0,
    metadataPresent: 0,
    oldActivityPenalty: 0
  };

  // Check 1: Is mint in our recently-minted cache? (best signal)
  if (mintCache.has(baseMint)) {
    breakdown.mintInCache = SCORE_MINT_IN_CACHE;
    logger.debug({ mint: baseMint.toString() }, 'Mint found in cache (+2)');
  }

  // Check 2: Was pool created after bot started?
  if (poolCreationTime > runTimestamp) {
    breakdown.poolTiming = SCORE_POOL_TIMING;
    logger.debug({
      mint: baseMint.toString(),
      poolTime: poolCreationTime,
      botStart: runTimestamp
    }, 'Pool created after bot start (+1)');
  }

  // Get token age (from cache or fallback)
  const tokenAge = await getTokenAge(connection, baseMint, maxTokenAgeSeconds);

  // Check 3: Penalty if token has old activity (fallback detected old token)
  if (tokenAge.source === 'helius-history' && !tokenAge.isNew) {
    breakdown.oldActivityPenalty = PENALTY_OLD_ACTIVITY;
    logger.debug({
      mint: baseMint.toString(),
      age: tokenAge.ageSeconds
    }, 'Token has old activity, applying penalty (-2)');
  }

  // Calculate total score
  const score = breakdown.mintInCache +
                breakdown.poolTiming +
                breakdown.metadataPresent +
                breakdown.oldActivityPenalty;

  const isLaunch = score >= LAUNCH_THRESHOLD;

  logger.info({
    mint: baseMint.toString(),
    score,
    threshold: LAUNCH_THRESHOLD,
    isLaunch,
    breakdown,
    tokenAge: tokenAge.ageSeconds,
    tokenAgeSource: tokenAge.source
  }, isLaunch ? 'LAUNCH DETECTED' : 'Not a new launch');

  return {
    score,
    breakdown,
    tokenAge,
    isLaunch
  };
}
```

**1A.2: Create Meaningful Pool Pre-Filter**

**New File:** `helpers/pool-prefilter.ts`

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { logger } from './logger';

export interface PreFilterResult {
  passed: boolean;
  reason?: string;
  liquidity?: number;
}

/**
 * Pre-filter to reject junk pools before expensive filter pipeline.
 * This is DETECTION filtering, not safety filtering.
 */
export async function preFilterPool(
  connection: Connection,
  quoteVault: PublicKey,
  expectedQuoteMint: PublicKey,
  actualQuoteMint: PublicKey,
  minLiquiditySol: number
): Promise<PreFilterResult> {

  // Check 1: Quote token is expected (WSOL)
  if (!actualQuoteMint.equals(expectedQuoteMint)) {
    return {
      passed: false,
      reason: `Wrong quote token: expected ${expectedQuoteMint.toString()}, got ${actualQuoteMint.toString()}`
    };
  }

  // Check 2: Minimum liquidity
  try {
    const vaultBalance = await connection.getTokenAccountBalance(quoteVault);
    const liquiditySol = (vaultBalance.value.uiAmount || 0);

    if (liquiditySol < minLiquiditySol) {
      return {
        passed: false,
        reason: `Insufficient liquidity: ${liquiditySol.toFixed(4)} SOL < ${minLiquiditySol} SOL`,
        liquidity: liquiditySol
      };
    }

    return {
      passed: true,
      liquidity: liquiditySol
    };

  } catch (error) {
    logger.warn({ quoteVault: quoteVault.toString(), error }, 'Failed to check vault balance');
    // On error, let it through to full filters (fail open for pre-filter)
    return {
      passed: true,
      reason: 'Vault balance check failed, proceeding anyway'
    };
  }
}
```

**1A.3: Update CPMM Handler in Listeners**

**File:** `listeners/listeners.ts`

Integrate launch scoring and pre-filtering:

```typescript
// In CPMM handler, after basic validation:

// Pre-filter: Check minimum liquidity
const preFilter = await preFilterPool(
  this.connection,
  cpmmState.vaultB,  // Quote vault (WSOL side)
  this.quoteToken,
  cpmmState.mintB,
  MIN_POOL_LIQUIDITY_SOL
);

if (!preFilter.passed) {
  stats.cpmm.preFilterRejected++;
  logger.debug({
    pool: accountId.toString(),
    reason: preFilter.reason
  }, '[CPMM] Pre-filter rejected');
  return;
}

// Calculate launch confidence score
const launchScore = await calculateLaunchScore(
  this.connection,
  baseMint,
  poolOpenTime,
  this.runTimestamp,
  MAX_TOKEN_AGE_SECONDS
);

if (!launchScore.isLaunch) {
  stats.cpmm.launchScoreRejected++;
  logger.info({
    pool: accountId.toString(),
    mint: baseMint.toString(),
    score: launchScore.score,
    breakdown: launchScore.breakdown
  }, '[CPMM] Not a new token launch');
  return;
}

// Emit with full context
this.emit('new-token-pool', {
  poolType: 'CPMM',
  poolId: accountId,
  baseMint,
  quoteMint,
  launchScore: launchScore.score,
  tokenAge: launchScore.tokenAge.ageSeconds,
  mintDetectedVia: launchScore.tokenAge.source,
  initialLiquidity: preFilter.liquidity,
  rawState: cpmmState
});
```

**1A.4: Add Diagnostic Logging**

Enhanced logging format:

```
[CPMM] WebSocket event received (account: Abc123...)
[CPMM] ├─ Decode: Success
[CPMM] ├─ Quote token (WSOL): PASS
[CPMM] ├─ Pool status (swap enabled): PASS
[CPMM] ├─ Pre-filter liquidity: 5.2 SOL (min: 1.0) PASS
[CPMM] ├─ Launch score calculation:
[CPMM] │   ├─ Mint in cache: +2 (detected via Helius 23s ago)
[CPMM] │   ├─ Pool timing: +1 (created after bot start)
[CPMM] │   ├─ Old activity penalty: 0
[CPMM] │   └─ TOTAL: 3 (threshold: 2) PASS
[CPMM] └─ EMITTING: New token launch detected
```

#### Passing Criteria for Phase 1A

| Criterion | Validation Method |
|-----------|-------------------|
| Launch scoring executes | Log shows score breakdown for each pool |
| Mint cache integration | Pools with cached mints get +2 score |
| Pre-filter active | Low liquidity pools rejected before scoring |
| Score threshold enforced | Only score >= 2 emits event |
| Fallback works | Pools not in cache still checked via history |
| No false positives | Old tokens with new pools rejected |

---

### Phase 1B: Apply Pattern to AMMV4

**Goal:** Apply the same standardized pattern to AMMV4 pool detection.

#### Tasks

**1B.1: Refactor AMMV4 Handler**

- Keep dataSize filter (efficient)
- Move other checks to handler
- Add launch scoring
- Add pre-filtering

**1B.2: Update Event Emission**

Use unified `'new-token-pool'` event with same structure as CPMM.

#### Passing Criteria for Phase 1B

| Criterion | Validation Method |
|-----------|-------------------|
| Same validation pipeline as CPMM | Logs show identical steps |
| Launch scoring active | Score breakdown logged |
| No regression | Existing functionality preserved |

---

### Phase 1C: Apply Pattern to DLMM

**Goal:** Apply the standardized pattern to DLMM pool detection.

#### Tasks

**1C.1: Standardize DLMM Handler**

- Add launch scoring
- Add pre-filtering
- Preserve DLMM-specific checks (discriminator, activation)

**1C.2: Update Event Emission**

Use unified event format.

#### Passing Criteria for Phase 1C

| Criterion | Validation Method |
|-----------|-------------------|
| Launch scoring active | Score breakdown logged |
| DLMM-specific checks preserved | Discriminator, activation still work |
| Unified event format | Same structure as AMMV4/CPMM |

---

### Phase 1D: Unified Event System

**Goal:** Consolidate all pool detection into a single event type.

#### Tasks

**1D.1: Create Unified Event Handler**

```typescript
listener.on('new-token-pool', async (pool: DetectedPool) => {
  logger.info({
    poolType: pool.poolType,
    poolId: pool.poolId.toString(),
    baseMint: pool.baseMint.toString(),
    launchScore: pool.launchScore,
    tokenAge: pool.tokenAge,
    liquidity: pool.initialLiquidity
  }, 'New token launch detected - proceeding to filters');

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

**1D.2: Remove Legacy Events**

Remove `'pool'`, `'cpmm-pool'`, `'dlmm-pool'` handlers.

**1D.3: Unified Statistics**

```typescript
interface DetectionStats {
  ammv4: PoolTypeStats;
  cpmm: PoolTypeStats;
  dlmm: PoolTypeStats;
  mintCache: { size: number; heliusDetected: number; fallbackDetected: number };
}

interface PoolTypeStats {
  events: number;
  invalidStructure: number;
  wrongQuoteToken: number;
  poolNotEnabled: number;
  preFilterRejected: number;
  launchScoreRejected: number;
  emitted: number;
}
```

#### Passing Criteria for Phase 1D

| Criterion | Validation Method |
|-----------|-------------------|
| Single event type | All pools use 'new-token-pool' |
| Legacy removed | No old event handlers |
| Stats unified | Single output shows all types + mint cache |

---

## 4. Launch Confidence Scoring

### Scoring Rules

| Factor | Points | Condition |
|--------|--------|-----------|
| Mint in cache | **+2** | Token mint detected via Helius within TTL |
| Pool timing | **+1** | Pool created after bot start time |
| Metadata present | **+1** | Token has metadata (optional, future) |
| Old activity penalty | **-2** | Fallback check found activity before window |

### Score Interpretation

| Score | Interpretation | Action |
|-------|---------------|--------|
| 3+ | High confidence new launch | Proceed to filters |
| 2 | Likely new launch | Proceed to filters |
| 1 | Uncertain | Reject (below threshold) |
| 0 or negative | Not a new launch | Reject |

### Configuration

```bash
# Scoring thresholds
LAUNCH_SCORE_THRESHOLD=2          # Minimum score to proceed
LAUNCH_SCORE_MINT_CACHE=2         # Points for mint in cache
LAUNCH_SCORE_POOL_TIMING=1        # Points for pool after bot start
LAUNCH_PENALTY_OLD_ACTIVITY=-2    # Penalty for old token activity
```

---

## 5. Passing Criteria

### Overall Success Criteria

| # | Criterion | How to Verify |
|---|-----------|---------------|
| 1 | **Helius mint detection works** | Mint cache populated during operation |
| 2 | **New launches detected** | Score >= 2 for genuinely new tokens |
| 3 | **Old tokens rejected** | Score < 2 for tokens with old activity |
| 4 | **Low liquidity filtered** | Junk pools rejected before scoring |
| 5 | **All pool types unified** | Same event structure for all |
| 6 | **Signature order correct** | Uses `sortOrder: "asc"` in fallback |
| 7 | **Fail-safe behavior** | Errors default to rejection |
| 8 | **Stats comprehensive** | Shows cache + per-type rejection reasons |

### Concrete Test Suites

#### Test Suite A: Known Launch Replay

Capture 10 real recent token launches with:
- Mint transaction signature
- First pool transaction signature
- Timestamps for both

Replay detection logic against these signatures. **Must emit within window for all 10.**

| Token | Mint Sig | Pool Sig | Expected |
|-------|----------|----------|----------|
| Token1 | abc123... | def456... | EMIT (score 3) |
| Token2 | ghi789... | jkl012... | EMIT (score 2) |
| ... | ... | ... | ... |

#### Test Suite B: False Positive Prevention

Capture 10 older tokens that created new pools recently:
- Token at least 1 hour old
- New pool created today

**Must NOT emit for any of these.**

| Token | Token Age | New Pool | Expected |
|-------|-----------|----------|----------|
| OldToken1 | 2 hours | Yes | REJECT (score -1) |
| OldToken2 | 1 day | Yes | REJECT (score -1) |
| ... | ... | ... | ... |

---

## 6. File Change Map

### New Files

| File | Phase | Purpose |
|------|-------|---------|
| `cache/mint.cache.ts` | 0 | Recently minted token cache |
| `listeners/mint-listener.ts` | 0 | Helius mint event detection |
| `helpers/token-validator.ts` | 0 | Token age validation with correct ordering |
| `helpers/launch-scorer.ts` | 1A | Confidence scoring logic |
| `helpers/pool-prefilter.ts` | 1A | Minimum liquidity pre-filter |
| `types/detected-pool.ts` | 1A | Unified detection interface |

### Modified Files

| File | Phase | Changes |
|------|-------|---------|
| `helpers/constants.ts` | 0 | Add all new configuration constants |
| `listeners/listeners.ts` | 1A-1C | Integrate scoring, pre-filter, unified events |
| `index.ts` | 0, 1D | Start mint listener, unified event handler |
| `bot.ts` | 1B | Accept DetectedPool interface |

---

## 7. Configuration Reference

### New Environment Variables

```bash
# ═══════════════════════════════════════════════════════════════
# MINT DETECTION (Phase 0)
# ═══════════════════════════════════════════════════════════════

# Maximum age in seconds for a token to be considered "new"
# Also used as TTL for mint cache
# Default: 300 (5 minutes)
MAX_TOKEN_AGE_SECONDS=300

# Enable Helius mint detection (primary truth)
# Default: true
ENABLE_HELIUS_MINT_DETECTION=true

# ═══════════════════════════════════════════════════════════════
# LAUNCH SCORING (Phase 1)
# ═══════════════════════════════════════════════════════════════

# Minimum score required to consider a pool a "new launch"
# Default: 2
LAUNCH_SCORE_THRESHOLD=2

# Minimum liquidity (in SOL) for pool to pass pre-filter
# Default: 1.0
MIN_POOL_LIQUIDITY_SOL=1.0

# Enable/disable token age checking entirely
# Default: true
ENABLE_TOKEN_AGE_CHECK=true
```

---

## 8. Testing & Validation

### Manual Testing Checklist

#### Phase 0
- [ ] Mint cache compiles and runs
- [ ] Mint listener subscribes successfully
- [ ] New mints appear in cache
- [ ] Cache TTL cleanup works
- [ ] Fallback uses `sortOrder: "asc"`

#### Phase 1A (CPMM)
- [ ] Launch scorer calculates correctly
- [ ] Pre-filter rejects low liquidity
- [ ] Score >= 2 emits event
- [ ] Score < 2 does not emit
- [ ] Mint cache hits give +2

#### Phase 1B-1D
- [ ] AMMV4 same behavior as CPMM
- [ ] DLMM same behavior as CPMM
- [ ] Unified event works
- [ ] Legacy events removed

### Log Output Examples

**Successful New Launch Detection:**
```
[MINT] New token mint detected via Helius
       mint=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
       signature=5Uj...

[CPMM] WebSocket event received
[CPMM] ├─ Account: 9yZXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgBsV
[CPMM] ├─ Decode: Success
[CPMM] ├─ Quote token: PASS
[CPMM] ├─ Pool status: PASS
[CPMM] ├─ Pre-filter: PASS (5.2 SOL >= 1.0 SOL)
[CPMM] ├─ Launch Score:
[CPMM] │   ├─ Mint in cache: +2 (detected 23s ago)
[CPMM] │   ├─ Pool timing: +1
[CPMM] │   ├─ Old activity: 0
[CPMM] │   └─ TOTAL: 3 >= 2 PASS
[CPMM] └─ EMITTING: New token launch
```

**Rejected (Old Token):**
```
[AMMV4] WebSocket event received
[AMMV4] ├─ Account: Abc123...
[AMMV4] ├─ Decode: Success
[AMMV4] ├─ Quote token: PASS
[AMMV4] ├─ Pool status: PASS
[AMMV4] ├─ Pre-filter: PASS (12.5 SOL)
[AMMV4] ├─ Launch Score:
[AMMV4] │   ├─ Mint in cache: 0 (not found)
[AMMV4] │   ├─ Pool timing: +1
[AMMV4] │   ├─ Old activity: -2 (token age: 3847s)
[AMMV4] │   └─ TOTAL: -1 < 2 FAIL
[AMMV4] └─ REJECTED: Not a new token launch
```

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2025-01-25 | 1.0 | Initial plan created |
| 2025-01-25 | 2.0 | Major revision: mint-first architecture, confidence scoring, pre-filtering, fixed signature order bug |

---

## References

- [Helius: How to Fetch Newly Minted Tokens](https://www.helius.dev/blog/how-to-fetch-newly-minted-tokens-with-helius)
- [Helius: getTransactionsForAddress](https://www.helius.dev/docs/rpc/gettransactionsforaddress) - Supports `sortOrder: "asc"` for oldest-first
- [Solana: getSignaturesForAddress](https://solana.com/docs/rpc/http/getsignaturesforaddress) - Returns newest first (descending)
- [Helius: Geyser Enhanced WebSockets](https://www.helius.dev/blog/how-to-monitor-solana-transactions-using-geyser-enhanced-websockets)
- [Helius: Webhooks Documentation](https://www.helius.dev/docs/webhooks)
