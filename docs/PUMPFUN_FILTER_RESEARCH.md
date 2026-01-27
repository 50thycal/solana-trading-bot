# pump.fun Filter Research: Finding Gems vs Rugs

This document outlines potential filter criteria for identifying quality pump.fun tokens.
Research compiled from on-chain analysis and industry best practices.

## The Challenge

- **98.7%** of tokens on pump.fun exhibit rug pull or pump-and-dump characteristics
- Only **~1.4%** of tokens retain liquidity above $1,000
- The "Rug Republic" - just 12 wallet clusters - created ~20% of all tokens and executed 82% of liquidity drains
- **93%** of top trading wallets are bots
- Over **50%** of tokens are sniped in the genesis block (same-block sniping)

## Currently Implemented Filters

| Filter | Status | Description |
|--------|--------|-------------|
| `minSolInCurve` | Done | Minimum SOL deposited (default: 5 SOL) |
| `maxSolInCurve` | Done | Maximum SOL before graduation (default: 300 SOL) |
| Deduplication | Done | Skip already-processed tokens |
| Blacklist | Done | Skip blacklisted tokens/creators |
| Exposure Limits | Done | Cap total SOL deployed |
| Graduation Check | Done | Skip tokens that already graduated |

## Potential Future Filters (Prioritized)

### HIGH PRIORITY - On-Chain Data Available

#### 1. Holder Distribution Analysis
**Rationale**: Concentrated holdings signal rug risk

| Metric | Threshold | Action |
|--------|-----------|--------|
| Top 10 holders % | > 60% | Reject |
| Dev wallet % | > 30% | Reject |
| Unique holders | < 10 | Reject |
| Holder growth rate | < 5/min | Lower score |

**Implementation**: Requires fetching token accounts for the mint

#### 2. Same-Block Sniper Detection
**Rationale**: Same-block sniping often indicates insider/coordinated activity

| Metric | Detection |
|--------|-----------|
| Genesis block buyers | > 3 wallets buying in mint block = suspicious |
| SOL transfers to snipers | Deployer funded snipers pre-launch = likely rug |

**Implementation**: Analyze transaction history for mint's first block

#### 3. Trading Velocity Analysis
**Rationale**: Organic growth vs manufactured volume

| Metric | Good Sign | Bad Sign |
|--------|-----------|----------|
| Unique traders | Growing steadily | Same wallets trading back/forth |
| Time to 100 holders | < 2 minutes | > 10 minutes or never |
| Volume pattern | Organic spread | Concentrated bursts |

**Implementation**: Track transactions over short window

#### 4. Creator Wallet Analysis
**Rationale**: Repeat ruggers follow patterns

| Metric | Red Flag |
|--------|----------|
| Prior tokens created | > 5 with no survivors |
| Wallet age | < 24 hours |
| Funding source | From known rug wallets |
| Pattern | Creates → buys → dumps repeatedly |

**Implementation**: Historical analysis of creator wallet

### MEDIUM PRIORITY - Metadata Analysis

#### 5. Token Metadata Quality
**Rationale**: Low-effort rugs have low-effort metadata

| Check | Pass | Fail |
|-------|------|------|
| Name length | 3-32 chars | Too short/long |
| Symbol | 2-10 chars, alphanumeric | Special chars, very long |
| URI exists | Valid IPFS/Arweave | Empty or invalid |
| Image | Loads successfully | 404 or placeholder |

**Implementation**: Fetch and validate metadata URI

#### 6. Social Presence Verification
**Rationale**: Projects with community less likely to rug (but can be faked)

| Check | Source |
|-------|--------|
| Twitter link | Metadata URI |
| Telegram | Metadata URI |
| Website | Metadata URI |
| Active community | External API needed |

**Implementation**: Parse metadata, optionally verify links are active

### LOWER PRIORITY - External Data Required

#### 7. Community Sentiment
- Twitter mention volume
- Telegram group size/activity
- Discord presence

**Requires**: Social APIs, not real-time

#### 8. Contract Analysis
- Token-2022 extensions used
- Unusual instructions
- Delegate authorities

**Requires**: Deep instruction parsing

## Scoring System Design

Instead of just pass/fail, assign scores for nuanced decisions:

```
Score Range: 0-100

BLOCKING (Must Pass):
- Min SOL in curve: Pass = continue, Fail = reject
- Max SOL in curve: Pass = continue, Fail = reject
- Not graduated: Pass = continue, Fail = reject

SCORING (Affects Ranking):
- Holder distribution: 0-20 points
- Trading velocity: 0-15 points
- Creator history: 0-15 points
- Metadata quality: 0-10 points
- Social presence: 0-10 points
- Early entry bonus: 0-15 points (based on curve progress)
- Volume/momentum: 0-15 points

Minimum Score to Buy: Configurable (default: 0 = buy if blocking passes)
```

## Implementation Approach

### Phase 1 (Current)
- Min/Max SOL in curve filters

### Phase 2 (Next)
- Holder distribution analysis
- Creator wallet history check
- Metadata quality validation

### Phase 3 (Future)
- Same-block sniper detection
- Trading velocity analysis
- Social verification

## Data Sources

| Data | Source | Availability |
|------|--------|--------------|
| Bonding curve state | On-chain | Real-time |
| Token accounts | On-chain | Real-time (requires RPC calls) |
| Transaction history | On-chain | Real-time (requires Helius/getSignatures) |
| Token metadata | Metaplex | Cached, may need fetch |
| Creator history | On-chain | Requires historical queries |
| Social links | External | Async verification |

## References

- [Solidus Labs: Solana Rug Pulls Report](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance)
- [Bitquery: pump.fun Token Lifecycle APIs](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/pump-fun-to-pump-swap/)
- [Chainstack: Creating a pump.fun Trading Bot](https://docs.chainstack.com/docs/solana-creating-a-pumpfun-bot)
- [Banana Gun: Sniping pump.fun Tokens](https://blog.bananagun.io/blog/how-to-snipe-pump-fun-tokens-before-they-migrate-to-raydium)

---

*Last updated: 2026-01-27*
