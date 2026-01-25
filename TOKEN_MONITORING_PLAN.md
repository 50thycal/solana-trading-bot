# Token-First Monitoring Implementation Plan

> **Status:** APPROVED - Ready for Implementation
> **Objective:** Monitor for new token launches on pump.fun, Raydium, and Meteora
> **Approach:** Token-First (Option A) - Detect tokens, use on-chain data for speed, API as fallback
> **Last Updated:** 2025-01-25

---

## Final Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Platforms** | All three: pump.fun, Raydium, Meteora | Maximum coverage |
| **Primary data source** | On-chain (RPC) | Instant, no indexing delay |
| **API usage** | Fallback only (non-blocking) | Speed is critical for sniping |
| **When to use API** | Token NOT in mint cache | Verify old tokens before buying |

---

## Executive Summary

This plan implements a **token-first monitoring system** that:
1. Detects new tokens via WebSocket events (real-time)
2. Uses **on-chain data** for instant buy decisions (age, liquidity, authorities)
3. Uses **API as fallback** only when token is not in mint cache (verification)
4. Executes buys on all three platforms: pump.fun, Raydium, Meteora

---

## Your Questions Answered

### Q: Can WebSockets provide token metadata (volume, market cap)?

**No. WebSockets only provide real-time events, not aggregated data.**

| Data Type | WebSocket | API Needed |
|-----------|-----------|------------|
| New token created | ✅ Yes | No |
| New pool created | ✅ Yes | No |
| Trade executed | ✅ Yes | No |
| Token age | ⚠️ Partial* | Optional |
| Volume | ❌ No | **Yes** |
| Market cap | ❌ No | **Yes** |
| Liquidity depth | ❌ No | **Yes** |
| Price | ❌ No | **Yes** |
| Holder count | ❌ No | **Yes** |

*Token age can be determined from mint timestamp in websocket event

### Q: How do WebSockets work for new token detection?

Each platform works differently:

| Platform | WebSocket Event | What You Get | When to Buy |
|----------|-----------------|--------------|-------------|
| **pump.fun** | `create` instruction | Token address, creator, name, symbol | Immediately (bonding curve) |
| **Raydium** | Pool account change | Token + pool address, initial liquidity | When pool is created |
| **Meteora** | DLMM account change | Token + pool address, bin config | When pool is created |

---

## Platform-by-Platform Breakdown

### 1. pump.fun (Bonding Curve)

**How it works:**
- Tokens launch on a bonding curve (no pool initially)
- Price increases as people buy
- At ~$69k market cap, token "graduates" to Raydium

**Detection method:**
```
WebSocket → pump.fun Program Logs
         → Filter for "create" instruction
         → Extract: token address, name, symbol, creator
```

**What you can get from WebSocket:**
- Token address
- Creator wallet
- Token name/symbol
- Creation timestamp

**What you need API for:**
- Current bonding curve progress
- Volume
- Holder count

**Relevant API:** pump.fun has a public API, or use DexScreener

---

### 2. Raydium (AMM Pools)

**How it works:**
- Token creator (or anyone) creates a liquidity pool
- Pool has initial liquidity (SOL + tokens)
- You can buy immediately when pool is created

**Detection method (already implemented):**
```
WebSocket → Raydium Program Account Changes
         → Decode pool state
         → Extract: token address, pool ID, initial liquidity
```

**What you can get from WebSocket:**
- Token address
- Pool address
- Initial liquidity amount
- Pool open time

**What you need API for:**
- Volume (aggregated trades)
- Market cap
- Whether token existed before this pool

---

### 3. Meteora (DLMM Pools)

**How it works:**
- Similar to Raydium but uses dynamic liquidity
- Pools can be created for new or existing tokens

**Detection method (already implemented):**
```
WebSocket → Meteora DLMM Program Account Changes
         → Decode pool state
         → Extract: token address, pool ID, activation status
```

---

## The Token-First Flow (Final Architecture)

```
┌─────────────────────────────────────────────────────────────────┐
│                    STEP 1: DETECT NEW TOKEN                      │
│                                                                 │
│  WebSocket subscriptions to:                                    │
│  • pump.fun program (new bonding curves)          [NEW]        │
│  • Raydium programs (new pools)                   [EXISTS]     │
│  • Meteora DLMM program (new pools)               [EXISTS]     │
│                                                                 │
│  Output: Token mint address + source (pump/raydium/meteora)    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 STEP 2: MINT CACHE CHECK                         │
│                                                                 │
│  Is this token in our "recently detected" cache?                │
│  → YES: High confidence new token → Go to Step 3               │
│  → NO: Need verification → Go to Step 2B (API fallback)        │
│                                                                 │
│  (Already implemented in mint.cache.ts)                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌─────────────────────────┐   ┌─────────────────────────────────┐
│  STEP 2A: CACHE HIT     │   │  STEP 2B: CACHE MISS (FALLBACK) │
│  (FAST PATH)            │   │                                 │
│                         │   │  Token not in cache - verify:   │
│  Token in mint cache    │   │  • Call DexScreener API         │
│  → Proceed immediately  │   │  • Check if token age > MAX     │
│  → No API call needed   │   │  • If old token → REJECT        │
│                         │   │  • If API fails → REJECT (safe) │
└───────────┬─────────────┘   └─────────────┬───────────────────┘
            │                               │
            └───────────────┬───────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│            STEP 3: ON-CHAIN FILTERS (INSTANT)                    │
│                                                                 │
│  All checks via RPC (no API delay):                            │
│  • Pool liquidity >= MIN_LIQUIDITY_SOL (check vault balance)   │
│  • Mint authority renounced                                     │
│  • Freeze authority disabled                                    │
│  • LP tokens burned                                             │
│  • Metadata immutable                                           │
│                                                                 │
│  (Already implemented in filters/)                              │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     STEP 4: EXECUTE BUY                          │
│                                                                 │
│  If all filters pass:                                           │
│  → pump.fun: Buy on bonding curve                 [NEW]        │
│  → Raydium: Buy via pool                          [EXISTS]     │
│  → Meteora: Buy via DLMM                          [EXISTS]     │
└─────────────────────────────────────────────────────────────────┘
```

### Speed Comparison

| Path | Latency | When Used |
|------|---------|-----------|
| **Cache Hit (Fast)** | ~100-200ms | Token detected by our mint listener |
| **Cache Miss (Fallback)** | ~500-1000ms | Token not in cache, need API verification |
| **API Not Indexed** | REJECT | Very new token not in DexScreener yet |

### Key Insight: Why This Architecture?

For **brand new tokens** (your target):
- Your mint listener detects them → they're in cache → instant buy decision
- No API delay because you already have ground truth

For **unknown tokens** (not in cache):
- These might be old tokens with new pools (rug risk)
- API verification is worth the delay to avoid buying old tokens
- If API returns nothing, safer to reject than risk it

---

## API Options for Token Metadata

### Option A: DexScreener API (Recommended)

**Endpoint:** `https://api.dexscreener.com/latest/dex/tokens/{tokenAddress}`

**Returns:**
```json
{
  "pairs": [{
    "pairCreatedAt": 1706123456789,  // Timestamp
    "priceUsd": "0.00001234",
    "volume": { "h24": 12345.67 },
    "liquidity": { "usd": 50000 },
    "fdv": 100000,
    "txns": { "h24": { "buys": 100, "sells": 50 } }
  }]
}
```

**Pros:**
- Free, no API key required
- Covers Raydium, Meteora, and pump.fun graduations
- Good reliability

**Cons:**
- Rate limited (300 requests/minute)
- May not index very new tokens immediately (30-60 second delay)

---

### Option B: Birdeye API

**Endpoint:** `https://public-api.birdeye.so/defi/token_overview?address={tokenAddress}`

**Returns:** Price, volume, market cap, holder count, etc.

**Pros:**
- More detailed data
- Faster indexing for new tokens

**Cons:**
- Requires API key
- Rate limits on free tier

---

### Option C: Helius DAS API

**Endpoint:** Helius `getAsset` method

**Returns:** Token metadata, authorities, supply

**Pros:**
- Already using Helius
- Very fast
- Good for metadata (name, symbol, authorities)

**Cons:**
- No volume/market cap data (need DexScreener for that)

---

### Recommended: Hybrid Approach

```
Token Detected via WebSocket
     │
     ├─→ Helius: Get token metadata (name, symbol, authorities)
     │           Fast, reliable, already integrated
     │
     └─→ DexScreener: Get trading data (if needed)
                      Volume, liquidity, market cap
                      Only call if you need these filters
```

---

## Implementation Plan (Approved)

### Implementation Order

| Phase | Component | Priority | Complexity |
|-------|-----------|----------|------------|
| **1** | pump.fun Detection | HIGH | Medium |
| **2** | DexScreener Fallback Service | HIGH | Low |
| **3** | pump.fun Buy Execution | HIGH | High |
| **4** | Unified Event System | MEDIUM | Medium |

---

### Phase 1: pump.fun Detection (NEW)

**Goal:** Detect new tokens launching on pump.fun bonding curves

**New file:** `listeners/pumpfun-listener.ts`

```typescript
import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { mintCache } from '../cache/mint.cache';
import { logger } from '../helpers/logger';

// pump.fun Program ID
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

export interface PumpFunToken {
  mint: PublicKey;
  bondingCurve: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  signature: string;
  detectedAt: number;
}

export class PumpFunListener extends EventEmitter {
  private connection: Connection;
  private subscriptionId: number | null = null;

  constructor(connection: Connection) {
    super();
    this.connection = connection;
  }

  async start(): Promise<void> {
    logger.info('Starting pump.fun listener');

    this.subscriptionId = this.connection.onLogs(
      PUMP_FUN_PROGRAM,
      async (logs) => {
        if (logs.err) return;

        // Look for "Create" instruction (new token launch)
        const isCreate = logs.logs.some(log =>
          log.includes('Program log: Instruction: Create')
        );

        if (isCreate) {
          await this.processCreateTransaction(logs.signature);
        }
      },
      'confirmed'
    );

    logger.info({ subscriptionId: this.subscriptionId }, 'pump.fun listener active');
  }

  private async processCreateTransaction(signature: string): Promise<void> {
    try {
      const tx = await this.connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });

      if (!tx?.meta || tx.meta.err) return;

      // Extract token details from transaction
      // pump.fun create instruction has specific account layout
      const token = this.parseCreateInstruction(tx, signature);

      if (token) {
        // Add to mint cache (high confidence - we detected the creation)
        mintCache.add(token.mint, 'helius', signature);

        logger.info({
          mint: token.mint.toString(),
          name: token.name,
          symbol: token.symbol,
          creator: token.creator.toString()
        }, 'New pump.fun token detected');

        this.emit('token-created', token);
      }
    } catch (error) {
      logger.error({ signature, error }, 'Failed to process pump.fun create');
    }
  }

  private parseCreateInstruction(tx: any, signature: string): PumpFunToken | null {
    // Implementation: Parse the create instruction accounts
    // Account layout for pump.fun create:
    // 0: mint
    // 1: mintAuthority
    // 2: bondingCurve
    // 3: associatedBondingCurve
    // 4: global
    // 5: mplTokenMetadata
    // 6: metadata
    // 7: user (creator)
    // ... etc

    // TODO: Implement full parsing
    return null;
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      await this.connection.removeOnLogsListener(this.subscriptionId);
      this.subscriptionId = null;
    }
    logger.info('pump.fun listener stopped');
  }
}
```

**Data available from pump.fun create:**
- Token mint address
- Bonding curve address
- Creator wallet
- Token name, symbol, uri

---

### Phase 2: DexScreener Fallback Service (NEW)

**Goal:** Verify token age for cache misses only (non-blocking for cache hits)

**New file:** `services/dexscreener.ts`

```typescript
import { logger } from '../helpers/logger';

interface DexScreenerPair {
  pairCreatedAt: number;
  priceUsd: string;
  volume: { h24: number };
  liquidity: { usd: number };
  fdv: number;
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

interface TokenVerification {
  isVerified: boolean;
  ageSeconds: number | null;
  source: 'dexscreener' | 'not_indexed' | 'error';
  reason?: string;
}

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';

/**
 * Verify token age via DexScreener API.
 *
 * ONLY called for cache misses (tokens we didn't detect via mint listener).
 * For cache hits, this function is NOT called - we trust our detection.
 */
export async function verifyTokenAge(
  mintAddress: string,
  maxAgeSeconds: number
): Promise<TokenVerification> {
  try {
    const response = await fetch(`${DEXSCREENER_BASE_URL}/${mintAddress}`);

    if (!response.ok) {
      logger.warn({ mintAddress, status: response.status }, 'DexScreener API error');
      return {
        isVerified: false,
        ageSeconds: null,
        source: 'error',
        reason: `API returned ${response.status}`
      };
    }

    const data: DexScreenerResponse = await response.json();

    // Token not indexed yet (very new or unknown)
    if (!data.pairs || data.pairs.length === 0) {
      return {
        isVerified: false,
        ageSeconds: null,
        source: 'not_indexed',
        reason: 'Token not found in DexScreener'
      };
    }

    // Get oldest pair creation time
    const oldestPair = data.pairs.reduce((oldest, pair) =>
      pair.pairCreatedAt < oldest.pairCreatedAt ? pair : oldest
    );

    const ageSeconds = Math.floor((Date.now() - oldestPair.pairCreatedAt) / 1000);
    const isNew = ageSeconds <= maxAgeSeconds;

    return {
      isVerified: isNew,
      ageSeconds,
      source: 'dexscreener',
      reason: isNew ? undefined : `Token is ${ageSeconds}s old (max: ${maxAgeSeconds}s)`
    };

  } catch (error) {
    logger.error({ mintAddress, error }, 'DexScreener verification failed');
    return {
      isVerified: false,
      ageSeconds: null,
      source: 'error',
      reason: String(error)
    };
  }
}
```

**Usage pattern:**
```typescript
// In pool detection handler:
if (mintCache.has(baseMint)) {
  // Cache hit - trust our detection, proceed immediately
  await executeBuy(pool);
} else {
  // Cache miss - verify via API before buying
  const verification = await verifyTokenAge(baseMint.toString(), MAX_TOKEN_AGE_SECONDS);
  if (verification.isVerified) {
    await executeBuy(pool);
  } else {
    logger.info({ mint: baseMint.toString(), reason: verification.reason }, 'Rejected: failed verification');
  }
}
```

---

### Phase 3: pump.fun Buy Execution (NEW)

**Goal:** Execute buys on pump.fun bonding curves

**New file:** `helpers/pumpfun.ts`

```typescript
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { logger } from './logger';

const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

interface BuyParams {
  connection: Connection;
  wallet: Keypair;
  mint: PublicKey;
  bondingCurve: PublicKey;
  amountSol: number;
  slippageBps: number;  // e.g., 500 = 5%
}

/**
 * Buy tokens on pump.fun bonding curve.
 *
 * The bonding curve uses a constant product formula.
 * Price increases as more tokens are bought.
 */
export async function buyOnPumpFun(params: BuyParams): Promise<string> {
  const { connection, wallet, mint, bondingCurve, amountSol, slippageBps } = params;

  // TODO: Implement pump.fun buy instruction
  // 1. Get bonding curve state (current reserves)
  // 2. Calculate expected tokens out
  // 3. Apply slippage
  // 4. Build buy instruction
  // 5. Send transaction

  throw new Error('pump.fun buy not yet implemented');
}

/**
 * Sell tokens back to pump.fun bonding curve.
 */
export async function sellOnPumpFun(params: {
  connection: Connection;
  wallet: Keypair;
  mint: PublicKey;
  bondingCurve: PublicKey;
  tokenAmount: number;
  slippageBps: number;
}): Promise<string> {
  // TODO: Implement pump.fun sell instruction
  throw new Error('pump.fun sell not yet implemented');
}
```

**Note:** pump.fun buy/sell requires understanding their specific instruction format. Will need to research or reverse-engineer the exact account layout and instruction data.

---

### Phase 4: Unified Event System

**Goal:** Single event handler for all platforms

**Changes to:** `index.ts`

```typescript
// Unified token detection event
interface DetectedToken {
  source: 'pumpfun' | 'raydium-ammv4' | 'raydium-cpmm' | 'meteora-dlmm';
  mint: PublicKey;

  // Platform-specific data
  poolId?: PublicKey;        // Raydium/Meteora only
  bondingCurve?: PublicKey;  // pump.fun only

  // Common data
  detectedAt: number;
  inMintCache: boolean;

  // Optional (from API verification)
  verified?: boolean;
  ageSeconds?: number;
}

// Single handler for all platforms
async function handleDetectedToken(token: DetectedToken): Promise<void> {
  // 1. Check mint cache
  // 2. If not in cache, verify via API
  // 3. Run on-chain filters
  // 4. Execute buy based on source
}
```

---

## Configuration

### New Environment Variables

```bash
# ═══════════════════════════════════════════════════════════════
# TOKEN-FIRST MONITORING (Platform Toggles)
# ═══════════════════════════════════════════════════════════════

# Enable pump.fun bonding curve detection [NEW]
ENABLE_PUMPFUN_DETECTION=true

# Enable Raydium pool detection (AMMV4 + CPMM) [EXISTS]
ENABLE_RAYDIUM_DETECTION=true

# Enable Meteora DLMM detection [EXISTS]
ENABLE_METEORA_DETECTION=true

# ═══════════════════════════════════════════════════════════════
# TOKEN FILTERS (On-Chain Checks)
# ═══════════════════════════════════════════════════════════════

# Maximum token age to consider (seconds)
# Used for mint cache TTL and fallback verification
MAX_TOKEN_AGE_SECONDS=300

# Minimum liquidity required (SOL) - checked on-chain
MIN_POOL_LIQUIDITY_SOL=1.0

# ═══════════════════════════════════════════════════════════════
# DEXSCREENER FALLBACK (For Cache Misses Only)
# ═══════════════════════════════════════════════════════════════

# Enable DexScreener as fallback for tokens not in mint cache
# When true: Cache misses are verified via API before buying
# When false: Cache misses are rejected (safest, fastest)
DEXSCREENER_FALLBACK_ENABLED=true

# Rate limit for DexScreener API (requests per minute)
DEXSCREENER_RATE_LIMIT=200
```

### Configuration Logic

```
Token Detected
     │
     ├─ In mint cache? ─── YES ──→ Use on-chain filters only (instant)
     │                             No API call, no delay
     │
     └─ NO ─────────────────────→ Check DEXSCREENER_FALLBACK_ENABLED
                                       │
                           ┌───────────┴───────────┐
                           │                       │
                        ENABLED                 DISABLED
                           │                       │
                           ▼                       ▼
                    Call DexScreener         REJECT immediately
                    to verify age            (safest option)
                           │
                    ┌──────┴──────┐
                    │             │
                 VERIFIED      NOT VERIFIED
                    │             │
                    ▼             ▼
              Proceed to      REJECT
              on-chain       (old token or
              filters        not indexed)
```

---

## Summary: What's Already Done vs What's Needed

### Already Implemented
| Component | File | Status |
|-----------|------|--------|
| Helius mint detection | `listeners/mint-listener.ts` | ✅ Done |
| Mint cache with TTL | `cache/mint.cache.ts` | ✅ Done |
| Token age validation | `helpers/token-validator.ts` | ✅ Done |
| Raydium AMMV4 detection | `listeners/listeners.ts` | ✅ Done |
| Raydium CPMM detection | `listeners/listeners.ts` | ✅ Done |
| Meteora DLMM detection | `listeners/listeners.ts` | ✅ Done |
| Burn filter | `filters/burn.filter.ts` | ✅ Done |
| Renounced filter | `filters/renounced.filter.ts` | ✅ Done |
| Mutable filter | `filters/mutable.filter.ts` | ✅ Done |
| Pool size filter | `filters/pool-size.filter.ts` | ✅ Done |
| Raydium buy/sell | `bot.ts` | ✅ Done |

### Needs Implementation
| Component | File | Priority |
|-----------|------|----------|
| pump.fun listener | `listeners/pumpfun-listener.ts` | 🔴 HIGH |
| DexScreener fallback | `services/dexscreener.ts` | 🔴 HIGH |
| pump.fun buy/sell | `helpers/pumpfun.ts` | 🔴 HIGH |
| Unified event system | `index.ts` | 🟡 MEDIUM |

---

## Answering Your Core Question

**"I don't really see the need for the pools if we can just look up the metadata"**

You're partially right! Here's the nuance:

| Scenario | Do You Need Pool Detection? |
|----------|----------------------------|
| **pump.fun** | ❌ No - tokens trade on bonding curve, no pool needed |
| **Raydium/Meteora** | ✅ Yes - you need a pool to buy. Pool detection tells you *when* you can buy |

**For pump.fun:** You can buy immediately when the token is created (via bonding curve).

**For Raydium/Meteora:** The token might exist, but you can't buy until someone creates a pool with liquidity. So pool detection is still valuable - it tells you "now you can buy this token."

**The Token-First approach means:**
1. Detect the token/pool creation (via websocket)
2. Use API to verify it's actually new (not an old token getting a new pool)
3. Apply your filters
4. Buy

---

## Implementation Checklist

### Phase 1: pump.fun Detection
- [ ] Create `listeners/pumpfun-listener.ts`
- [ ] Parse pump.fun create instruction (account layout)
- [ ] Add to mint cache on detection
- [ ] Emit 'token-created' event
- [ ] Add to index.ts initialization
- [ ] Add `ENABLE_PUMPFUN_DETECTION` config

### Phase 2: DexScreener Fallback
- [ ] Create `services/dexscreener.ts`
- [ ] Implement `verifyTokenAge()` function
- [ ] Integrate into pool detection handlers (cache miss path)
- [ ] Add rate limiting (300 req/min)
- [ ] Add `DEXSCREENER_ENABLED` config

### Phase 3: pump.fun Buy Execution
- [ ] Create `helpers/pumpfun.ts`
- [ ] Research pump.fun instruction format
- [ ] Implement `buyOnPumpFun()` function
- [ ] Implement `sellOnPumpFun()` function
- [ ] Integrate with bot.ts

### Phase 4: Unified Event System
- [ ] Define `DetectedToken` interface
- [ ] Create unified handler in index.ts
- [ ] Migrate existing pool handlers to emit unified events
- [ ] Add comprehensive statistics

---

## Handoff Notes for Next Session

**What's been decided:**
1. Monitor ALL THREE platforms: pump.fun, Raydium, Meteora
2. Use ON-CHAIN data for instant decisions (no API delay for cache hits)
3. Use DexScreener API as FALLBACK only (for cache misses)

**What's already implemented:**
- Helius mint detection (cache populated on mint events)
- Raydium AMMV4 + CPMM pool detection
- Meteora DLMM pool detection
- On-chain filters (burn, renounced, mutable, pool-size)

**What needs to be built (in order):**
1. `listeners/pumpfun-listener.ts` - Detect new pump.fun tokens
2. `services/dexscreener.ts` - Fallback verification for cache misses
3. `helpers/pumpfun.ts` - Buy/sell on pump.fun bonding curves
4. Unified event system in `index.ts`

**Key architecture insight:**
- Cache hit (we detected mint) → instant buy, no API call
- Cache miss (unknown token) → verify via DexScreener first
- This gives you speed when it matters (new tokens) and safety when needed (unknown tokens)
