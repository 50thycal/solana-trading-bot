# Token-First Monitoring Implementation Plan

> **Status:** Planning
> **Objective:** Monitor for new token launches on pump.fun, Raydium, and Meteora
> **Approach:** Token-First (Option A) - Detect tokens, then fetch metadata to filter

---

## Executive Summary

This plan implements a **token-first monitoring system** that:
1. Detects new tokens via WebSocket events (real-time)
2. Fetches token metadata via API (for filtering decisions)
3. Executes buys based on configurable criteria

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

## The Token-First Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    STEP 1: DETECT NEW TOKEN                      │
│                                                                 │
│  WebSocket subscriptions to:                                    │
│  • pump.fun program (new bonding curves)                        │
│  • Raydium programs (new pools)                                 │
│  • Meteora DLMM program (new pools)                            │
│                                                                 │
│  Output: Token mint address + source (pump/raydium/meteora)    │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                 STEP 2: QUICK CACHE CHECK                        │
│                                                                 │
│  Is this token in our "recently detected" cache?                │
│  → YES: We detected the mint, this is likely new               │
│  → NO: Token might be old, need to verify                      │
│                                                                 │
│  (Already implemented in mint.cache.ts)                         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│               STEP 3: FETCH METADATA (API CALL)                  │
│                                                                 │
│  Call DexScreener/Birdeye API to get:                          │
│  • Token age (creation time)                                    │
│  • Volume (if any trading has happened)                        │
│  • Liquidity                                                    │
│  • Market cap                                                   │
│                                                                 │
│  Note: Very new tokens may not be indexed yet!                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  STEP 4: APPLY FILTERS                           │
│                                                                 │
│  Filter criteria (configurable):                                │
│  • Token age < MAX_TOKEN_AGE_SECONDS                           │
│  • Liquidity >= MIN_LIQUIDITY_SOL                              │
│  • Market cap in acceptable range (optional)                    │
│  • Creator not blacklisted                                      │
│  • Mint authority renounced (optional)                          │
│                                                                 │
│  Existing filters: burn, renounced, mutable, pool-size         │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     STEP 5: EXECUTE BUY                          │
│                                                                 │
│  If all filters pass:                                           │
│  → pump.fun: Buy on bonding curve                              │
│  → Raydium: Buy via pool (already implemented)                 │
│  → Meteora: Buy via DLMM (already implemented)                 │
└─────────────────────────────────────────────────────────────────┘
```

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

## Implementation Plan

### Phase 1: pump.fun Detection (NEW)

**Goal:** Detect new tokens launching on pump.fun bonding curves

**New file:** `listeners/pumpfun-listener.ts`

```typescript
// pump.fun Program ID
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

// Subscribe to logs for "create" instruction
connection.onLogs(PUMP_FUN_PROGRAM, (logs) => {
  if (logs.logs.some(log => log.includes('Instruction: Create'))) {
    // New token launched on pump.fun!
    // Parse transaction to get token details
  }
});
```

**Data available from pump.fun create:**
- Token mint address
- Bonding curve address
- Creator wallet
- Token name, symbol, uri

### Phase 2: Token Metadata Service (NEW)

**Goal:** Fetch and cache token metadata from APIs

**New file:** `services/token-metadata.ts`

```typescript
interface TokenMetadata {
  mint: string;
  age: number;              // Seconds since creation
  volume24h?: number;       // USD volume
  liquidity?: number;       // USD liquidity
  marketCap?: number;       // Fully diluted valuation
  holders?: number;         // Number of holders
  source: 'dexscreener' | 'birdeye' | 'helius' | 'cache';
}

async function getTokenMetadata(mint: string): Promise<TokenMetadata | null> {
  // 1. Check cache first
  // 2. Try DexScreener API
  // 3. Return null if not indexed (very new token)
}
```

### Phase 3: Unified Token Filter

**Goal:** Single filter that applies all criteria

**New file:** `filters/token-age.filter.ts`

```typescript
interface TokenFilterConfig {
  maxAgeSeconds: number;       // e.g., 300 (5 minutes)
  minLiquiditySol?: number;    // e.g., 1.0
  maxMarketCapUsd?: number;    // e.g., 100000
  requireApiVerification: boolean; // If true, reject if API returns null
}
```

### Phase 4: pump.fun Buy Execution (NEW)

**Goal:** Execute buys on pump.fun bonding curves

**New file:** `helpers/pumpfun.ts`

```typescript
// Buy on pump.fun bonding curve
async function buyOnPumpFun(
  connection: Connection,
  wallet: Keypair,
  tokenMint: PublicKey,
  bondingCurve: PublicKey,
  amountSol: number
): Promise<string> {
  // Build and send buy instruction
}
```

---

## Configuration

### New Environment Variables

```bash
# ═══════════════════════════════════════════════════════════════
# TOKEN-FIRST MONITORING
# ═══════════════════════════════════════════════════════════════

# Enable pump.fun detection
ENABLE_PUMPFUN_DETECTION=true

# Enable Raydium pool detection (already exists)
ENABLE_RAYDIUM_DETECTION=true

# Enable Meteora DLMM detection (already exists)
ENABLE_METEORA_DETECTION=true

# ═══════════════════════════════════════════════════════════════
# TOKEN FILTERS
# ═══════════════════════════════════════════════════════════════

# Maximum token age to consider (seconds)
MAX_TOKEN_AGE_SECONDS=300

# Minimum liquidity required (SOL)
MIN_LIQUIDITY_SOL=1.0

# Maximum market cap to buy (USD, 0 = no limit)
MAX_MARKET_CAP_USD=100000

# Require DexScreener verification before buying
# If true: Skip if token not yet indexed
# If false: Buy based on websocket data alone
REQUIRE_API_VERIFICATION=false

# ═══════════════════════════════════════════════════════════════
# API CONFIGURATION
# ═══════════════════════════════════════════════════════════════

# DexScreener API (no key needed)
DEXSCREENER_ENABLED=true
DEXSCREENER_RATE_LIMIT=200  # requests per minute

# Birdeye API (optional, needs key)
BIRDEYE_API_KEY=
BIRDEYE_ENABLED=false
```

---

## Summary: What's Already Done vs What's Needed

### Already Implemented (Phase 0)
- ✅ Helius mint detection (`listeners/mint-listener.ts`)
- ✅ Mint cache with TTL (`cache/mint.cache.ts`)
- ✅ Token age validation (`helpers/token-validator.ts`)
- ✅ Raydium AMMV4 pool detection
- ✅ Raydium CPMM pool detection
- ✅ Meteora DLMM pool detection
- ✅ Safety filters (burn, renounced, mutable, pool-size)

### Needs Implementation
- ❌ pump.fun listener (bonding curve detection)
- ❌ pump.fun buy execution
- ❌ DexScreener API integration (for metadata)
- ❌ Unified token metadata service
- ❌ Token age filter using API data

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

## Next Steps

1. **Decide on scope:**
   - pump.fun only?
   - All three platforms?
   - API verification required or optional?

2. **I can implement in this order:**
   - Phase 1: pump.fun detection (most requested)
   - Phase 2: Token metadata service (DexScreener)
   - Phase 3: Unified filtering
   - Phase 4: pump.fun buy execution

Let me know which direction you'd like to go!
