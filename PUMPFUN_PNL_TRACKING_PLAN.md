# pump.fun PnL Tracking Fix - Implementation Plan

> **Status:** APPROVED - Ready for Implementation
> **Objective:** Fix PnL tracking for pump.fun live trading to use actual verified values instead of calculated/assumed values
> **Scope:** pump.fun trading only (not Raydium/Meteora)
> **Last Updated:** 2025-02-02

---

## Problem Summary

| Mode | Token Amounts | SOL Amounts | Dashboard PnL |
|------|---------------|-------------|---------------|
| **Dry Run** | Calculated from bonding curve | Calculated from bonding curve | Works correctly |
| **Live** | **EXPECTED** (never verified) | **CALCULATED** (never verified) | Missing pump.fun unrealized |

### Root Cause

The live trading mode records **expected/calculated** amounts rather than **actual verified** amounts:

- **Buy**: `tokensReceived` is calculated from bonding curve math, never verified against wallet
- **Sell**: `solReceived` is calculated from bonding curve math, never verified against wallet
- **Dashboard**: `/api/pnl` only includes Raydium unrealized PnL, not pump.fun

---

## Problem Locations

| Issue | File | Line | Problem |
|-------|------|------|---------|
| Buy returns expected tokens | `helpers/pumpfun.ts` | ~646-650 | Returns `expectedTokens.toNumber()` |
| Sell returns expected SOL | `helpers/pumpfun.ts` | ~774-778 | Returns `expectedSol.toNumber()` |
| Buy recorded without verification | `index.ts` | ~1113-1119 | Records `buyResult.tokensReceived` as-is |
| Sell recorded with calculated SOL | `risk/pumpfun-position-monitor.ts` | ~417-423 | Records `exitValueSol` which is calculated |
| Dashboard missing pump.fun | `dashboard/server.ts` | ~558-581 | Only calls `getPositionMonitor()` (Raydium) |

---

## Implementation Phases

### Phase 1: Add `getStats()` to PumpFunPositionMonitor

**Priority:** HIGH (enables dashboard improvements)
**Complexity:** Low
**File:** `/home/user/solana-trading-bot/risk/pumpfun-position-monitor.ts`

#### 1.1 Update `PumpFunPosition` Interface

Add fields to track current value for unrealized PnL:

```typescript
export interface PumpFunPosition {
  tokenMint: string;
  bondingCurve: string;
  entryAmountSol: number;
  tokenAmount: number;
  entryTimestamp: number;
  buySignature: string;
  isToken2022?: boolean;
  // NEW: For unrealized PnL tracking
  lastCurrentValueSol?: number;
  lastCheckTimestamp?: number;
}
```

#### 1.2 Update `checkPosition()` Method

Store current value after each position check (around line ~245):

```typescript
// After calculating currentValueSol
position.lastCurrentValueSol = currentValueSol;
position.lastCheckTimestamp = Date.now();
```

#### 1.3 Add `getStats()` Method

Add after line ~445:

```typescript
/**
 * Get monitor statistics including unrealized P&L
 */
getStats(): {
  isRunning: boolean;
  positionCount: number;
  totalEntryValue: number;
  totalCurrentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
} {
  let totalEntryValue = 0;
  let totalCurrentValue = 0;

  for (const position of this.positions.values()) {
    totalEntryValue += position.entryAmountSol;
    totalCurrentValue += position.lastCurrentValueSol ?? position.entryAmountSol;
  }

  const unrealizedPnl = totalCurrentValue - totalEntryValue;
  const unrealizedPnlPercent =
    totalEntryValue > 0 ? (unrealizedPnl / totalEntryValue) * 100 : 0;

  return {
    isRunning: this.isRunning,
    positionCount: this.positions.size,
    totalEntryValue,
    totalCurrentValue,
    unrealizedPnl,
    unrealizedPnlPercent,
  };
}
```

---

### Phase 2: Update Dashboard API for pump.fun Unrealized PnL

**Priority:** HIGH (immediate visibility improvement)
**Complexity:** Low
**File:** `/home/user/solana-trading-bot/dashboard/server.ts`

#### 2.1 Update `/api/pnl` Endpoint

Location: `getApiPnl()` method, lines ~558-581

```typescript
private getApiPnl() {
  const pnlTracker = getPnlTracker();
  const stateStore = getStateStore();
  const positionMonitor = getPositionMonitor();      // Raydium
  const pumpFunMonitor = getPumpFunPositionMonitor(); // ADD THIS

  if (!pnlTracker) {
    return { error: 'P&L tracker not initialized' };
  }

  const summary = pnlTracker.getSessionSummary();
  const tradeStats = stateStore?.getTradeStats();

  // Get Raydium unrealized PnL
  const raydiumMonitorStats = positionMonitor?.getStats();
  const raydiumUnrealizedPnl = raydiumMonitorStats?.unrealizedPnl || 0;

  // Get pump.fun unrealized PnL (ADD THIS)
  const pumpFunMonitorStats = pumpFunMonitor?.getStats();
  const pumpFunUnrealizedPnl = pumpFunMonitorStats?.unrealizedPnl || 0;

  // Combined unrealized PnL
  const totalUnrealizedPnl = raydiumUnrealizedPnl + pumpFunUnrealizedPnl;

  return {
    realized: summary.realizedPnlSol,
    unrealized: totalUnrealizedPnl,  // Now includes pump.fun!
    total: summary.realizedPnlSol + totalUnrealizedPnl,
    winRate: summary.winRate,
    totalTrades: summary.totalTrades,
    dbStats: tradeStats,
    // NEW: Breakdown by source
    breakdown: {
      raydium: {
        unrealized: raydiumUnrealizedPnl,
        positions: raydiumMonitorStats?.positionCount || 0,
      },
      pumpfun: {
        unrealized: pumpFunUnrealizedPnl,
        positions: pumpFunMonitorStats?.positionCount || 0,
      },
    },
  };
}
```

#### 2.2 Update `/api/status` Endpoint

Similarly update `getApiStatus()` (lines ~410-458):

```typescript
// Add pumpFunMonitor stats
const pumpFunMonitor = getPumpFunPositionMonitor();
const pumpFunMonitorStats = pumpFunMonitor?.getStats();

// Update pnl section to include pump.fun:
pnl: pnlSummary
  ? {
      realized: pnlSummary.realizedPnlSol,
      unrealized: (monitorStats?.unrealizedPnl || 0) + (pumpFunMonitorStats?.unrealizedPnl || 0),
      total: pnlSummary.realizedPnlSol +
             (monitorStats?.unrealizedPnl || 0) +
             (pumpFunMonitorStats?.unrealizedPnl || 0),
    }
  : null,
```

---

### Phase 3: Create Transaction Verification Utility

**Priority:** HIGH (foundation for accurate PnL)
**Complexity:** Medium
**File to Create:** `/home/user/solana-trading-bot/helpers/tx-verifier.ts`

#### 3.1 Define Interface

```typescript
export interface TxVerificationResult {
  success: boolean;
  signature: string;
  // For buys
  actualTokensReceived?: number;
  expectedTokens?: number;
  tokenSlippagePercent?: number;
  // For sells
  actualSolReceived?: number;
  expectedSol?: number;
  solSlippagePercent?: number;
  // Metadata
  verificationMethod: 'tx_parsing' | 'balance_check' | 'expected_only';
  error?: string;
}
```

#### 3.2 Implement `verifyBuyTransaction()`

**Strategy:** Pre/Post balance comparison (most reliable)

```typescript
export async function verifyBuyTransaction(params: {
  connection: Connection;
  signature: string;
  wallet: PublicKey;
  mint: PublicKey;
  expectedTokens: number;
  tokenProgramId: PublicKey;
  preBalance: number;
}): Promise<TxVerificationResult> {
  // 1. Fetch current token balance
  // 2. Calculate actual = currentBalance - preBalance
  // 3. Compare to expected, calculate slippage
  // 4. Return verification result
}
```

#### 3.3 Implement `verifySellTransaction()`

```typescript
export async function verifySellTransaction(params: {
  connection: Connection;
  signature: string;
  wallet: PublicKey;
  expectedSol: number;
  preBalance: number;
}): Promise<TxVerificationResult> {
  // 1. Fetch current SOL balance
  // 2. Calculate actual = currentBalance - preBalance
  // 3. Compare to expected, calculate slippage
  // 4. Return verification result
}
```

#### 3.4 Fallback: Transaction Parsing

If pre-balance wasn't captured, parse transaction:

```typescript
async function parseTransactionBalances(
  connection: Connection,
  signature: string,
  wallet: PublicKey
): Promise<{ solChange: number; tokenChanges: Map<string, number> }> {
  // Use getParsedTransaction() to get pre/post balances
  // Extract from meta.preBalances/postBalances and meta.preTokenBalances/postTokenBalances
}
```

---

### Phase 4: Modify pumpfun.ts Buy/Sell Functions

**Priority:** HIGH (core fix)
**Complexity:** Medium
**File:** `/home/user/solana-trading-bot/helpers/pumpfun.ts`

#### 4.1 Update `PumpFunTxResult` Interface

Add fields for verification data:

```typescript
export interface PumpFunTxResult {
  success: boolean;
  signature?: string;
  error?: string;
  tokensReceived?: number;      // Actual verified (or expected as fallback)
  solReceived?: number;         // Actual verified (or expected as fallback)
  // NEW FIELDS
  expectedTokens?: number;      // Always the calculated expected amount
  expectedSol?: number;         // Always the calculated expected amount
  actualVerified: boolean;      // Whether the amount was verified post-tx
  verificationMethod?: 'tx_parsing' | 'balance_check' | 'expected_only';
  slippagePercent?: number;     // Actual slippage vs expected
}
```

#### 4.2 Modify `buyOnPumpFun()` (Lines ~496-658)

1. Capture pre-tx token balance (if ATA exists)
2. After tx confirmation, verify actual tokens received
3. Return both expected AND actual amounts

```typescript
// Before sendRawTransaction (around line 625)
let preTokenBalance = 0;
try {
  const tokenAccount = await getAccount(connection, userTokenAccount, 'confirmed', tokenProgramId);
  preTokenBalance = Number(tokenAccount.amount);
} catch {
  // Account doesn't exist yet, balance is 0
}

// After confirmTransaction (around line 635)
const verification = await verifyBuyTransaction({
  connection,
  signature,
  wallet: wallet.publicKey,
  mint,
  expectedTokens: expectedTokens.toNumber(),
  tokenProgramId,
  preBalance: preTokenBalance,
});

return {
  success: true,
  signature,
  tokensReceived: verification.actualTokensReceived ?? expectedTokens.toNumber(),
  expectedTokens: expectedTokens.toNumber(),
  actualVerified: verification.success,
  verificationMethod: verification.verificationMethod,
  slippagePercent: verification.tokenSlippagePercent,
};
```

#### 4.3 Modify `sellOnPumpFun()` (Lines ~666-786)

1. Capture pre-tx SOL balance
2. After tx confirmation, verify actual SOL received
3. Return both expected AND actual amounts

```typescript
// Before sendRawTransaction (around line 753)
const preSolBalance = await connection.getBalance(wallet.publicKey);

// After confirmTransaction
const verification = await verifySellTransaction({
  connection,
  signature,
  wallet: wallet.publicKey,
  expectedSol: expectedSol.toNumber(),
  preBalance: preSolBalance,
});

return {
  success: true,
  signature,
  solReceived: verification.actualSolReceived ?? expectedSol.toNumber() / LAMPORTS_PER_SOL,
  expectedSol: expectedSol.toNumber() / LAMPORTS_PER_SOL,
  actualVerified: verification.success,
  verificationMethod: verification.verificationMethod,
  slippagePercent: verification.solSlippagePercent,
};
```

---

### Phase 5: Update Callers to Use Verified Amounts

**Priority:** HIGH (completes the fix)
**Complexity:** Low

#### 5.1 Update `index.ts` Buy Recording (Lines ~1113-1167)

```typescript
// After buyOnPumpFun succeeds
const actualTokens = buyResult.tokensReceived || 0;
const expectedTokens = buyResult.expectedTokens || actualTokens;

// Log slippage if verification succeeded
if (buyResult.actualVerified && buyResult.slippagePercent !== undefined) {
  logger.info({
    mint: baseMintStr,
    expectedTokens,
    actualTokens,
    slippagePercent: buyResult.slippagePercent.toFixed(2),
    verificationMethod: buyResult.verificationMethod,
  }, '[pump.fun] Trade verification complete');
}

// Record with ACTUAL tokens
pnlTracker.recordBuy({
  tokenMint: baseMintStr,
  amountSol: tradeAmount,
  amountToken: actualTokens,  // Now verified!
  txSignature: buyResult.signature || '',
  poolId: bondingCurveStr,
});
```

#### 5.2 Update `pumpfun-position-monitor.ts` Sell Recording (Lines ~399-450)

```typescript
// In executeSell() method
if (sellResult.success) {
  const actualSolReceived = sellResult.solReceived ?? currentValueSol;
  const expectedSol = sellResult.expectedSol ?? currentValueSol;

  if (sellResult.actualVerified && sellResult.slippagePercent !== undefined) {
    logger.info({
      mint: position.tokenMint,
      expectedSol,
      actualSol: actualSolReceived,
      slippagePercent: sellResult.slippagePercent.toFixed(2),
    }, '[pump.fun] Sell verification complete');
  }

  // Use actual SOL received for PnL
  this.finalizeSell(position, sellResult.signature || '', actualSolReceived, pnlPercent, reason);
}
```

---

### Phase 6: (Optional) Database Schema for Slippage Tracking

**Priority:** LOW (nice-to-have)
**Complexity:** Low

#### 6.1 Update TradeRecord Interface

**File:** `/home/user/solana-trading-bot/persistence/models.ts`

```typescript
export interface TradeRecord {
  // ... existing fields ...

  // NEW: Slippage tracking
  expectedAmountSol?: number;
  expectedAmountToken?: number;
  actualSlippagePercent?: number;
  verificationMethod?: 'tx_parsing' | 'balance_check' | 'expected_only';
}
```

#### 6.2 Database Migration

**File:** `/home/user/solana-trading-bot/persistence/state-store.ts`

```typescript
private migrateToV4(): void {
  this.db.exec(`
    ALTER TABLE trades ADD COLUMN expected_amount_sol REAL;
    ALTER TABLE trades ADD COLUMN expected_amount_token REAL;
    ALTER TABLE trades ADD COLUMN actual_slippage_percent REAL;
    ALTER TABLE trades ADD COLUMN verification_method TEXT;

    INSERT INTO schema_version (version, applied_at) VALUES (4, ${Date.now()});
  `);
  logger.info('Applied migration v4: Added slippage tracking columns');
}
```

---

## Edge Cases to Handle

| Edge Case | Handling |
|-----------|----------|
| **Transaction Not Found** | Retry with exponential backoff (max 3 attempts: 500ms, 1s, 2s) |
| **ATA Created During Buy** | Pre-balance is 0, handle gracefully |
| **Significant Slippage (>10%)** | Log warning for investigation |
| **RPC Rate Limits** | Only verify in live mode, consider batching |
| **Failed Transactions** | Don't record trade (current behavior is correct) |
| **Backwards Compatibility** | Handle `undefined` for new fields in existing records |

---

## Testing Strategy

1. **Unit Tests for tx-verifier.ts**:
   - Mock transaction responses
   - Test balance diff calculation
   - Test fallback to expected values

2. **Integration Tests**:
   - Execute small buy on devnet
   - Compare expected vs actual amounts

3. **Manual Verification**:
   - Execute small buy on live system
   - Compare logged amounts with Solscan transaction details

---

## Implementation Checklist

### Phase 1: PumpFunPositionMonitor.getStats()
- [ ] Add `lastCurrentValueSol` and `lastCheckTimestamp` to `PumpFunPosition` interface
- [ ] Update `checkPosition()` to store `lastCurrentValueSol` after each check
- [ ] Add `getStats()` method returning unrealized PnL stats

### Phase 2: Dashboard API Updates
- [ ] Import `getPumpFunPositionMonitor` in dashboard/server.ts
- [ ] Update `getApiPnl()` to include pump.fun unrealized PnL
- [ ] Update `getApiStatus()` to include pump.fun unrealized PnL
- [ ] Add breakdown by source (raydium vs pumpfun)

### Phase 3: Transaction Verification Utility
- [ ] Create `helpers/tx-verifier.ts`
- [ ] Implement `verifyBuyTransaction()` with balance check
- [ ] Implement `verifySellTransaction()` with balance check
- [ ] Add fallback transaction parsing method
- [ ] Add retry logic with exponential backoff

### Phase 4: pumpfun.ts Modifications
- [ ] Update `PumpFunTxResult` interface with new fields
- [ ] Modify `buyOnPumpFun()` to capture pre-balance and verify post-tx
- [ ] Modify `sellOnPumpFun()` to capture pre-balance and verify post-tx
- [ ] Return both expected and actual amounts

### Phase 5: Caller Updates
- [ ] Update `index.ts` buy recording to use verified tokens
- [ ] Update `pumpfun-position-monitor.ts` sell recording to use verified SOL
- [ ] Add slippage logging when verification succeeds

### Phase 6: (Optional) Database Schema
- [ ] Add new columns to TradeRecord interface
- [ ] Add database migration for slippage tracking columns
- [ ] Update trade recording to include new fields

---

## Files Summary

| File | Action | Phase |
|------|--------|-------|
| `risk/pumpfun-position-monitor.ts` | Modify | 1 |
| `dashboard/server.ts` | Modify | 2 |
| `helpers/tx-verifier.ts` | **Create** | 3 |
| `helpers/pumpfun.ts` | Modify | 4 |
| `index.ts` | Modify | 5 |
| `persistence/models.ts` | Modify | 6 (optional) |
| `persistence/state-store.ts` | Modify | 6 (optional) |

---

## Handoff Notes for Next Session

**Reference this document as:** `PUMPFUN_PNL_TRACKING_PLAN.md`

**What's been analyzed:**
- Dry run mode works correctly using `paper-trade-tracker.ts`
- Live mode uses calculated values instead of verified actual values
- Dashboard missing pump.fun unrealized PnL

**Implementation order rationale:**
1. Phases 1-2 provide immediate dashboard visibility with low risk
2. Phase 3 builds the verification foundation
3. Phases 4-5 integrate verification into trading flow
4. Phase 6 is optional enhancement for historical tracking

**Key insight:**
The bonding curve math is accurate for *expected* values, but slippage and network conditions can cause *actual* values to differ. Verification ensures PnL reflects reality.
