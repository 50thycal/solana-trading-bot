/**
 * Test script for PumpFunPositionMonitor.getStats()
 * Standalone test that doesn't trigger config validation
 *
 * Run with: npx ts-node scripts/test-pumpfun-stats.ts
 */

// Minimal mock of the PumpFunPosition interface and getStats logic
// This tests the logic without importing the full module chain

interface PumpFunPosition {
  tokenMint: string;
  bondingCurve: string;
  entryAmountSol: number;
  tokenAmount: number;
  entryTimestamp: number;
  buySignature: string;
  isToken2022?: boolean;
  lastCurrentValueSol?: number;
  lastCheckTimestamp?: number;
}

// Replicate the getStats logic exactly as implemented
function getStats(positions: Map<string, PumpFunPosition>, isRunning: boolean): {
  isRunning: boolean;
  positionCount: number;
  totalEntryValue: number;
  totalCurrentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
} {
  let totalEntryValue = 0;
  let totalCurrentValue = 0;

  for (const position of positions.values()) {
    totalEntryValue += position.entryAmountSol;
    // Use lastCurrentValueSol if available, otherwise fall back to entry value
    totalCurrentValue += position.lastCurrentValueSol ?? position.entryAmountSol;
  }

  const unrealizedPnl = totalCurrentValue - totalEntryValue;
  const unrealizedPnlPercent =
    totalEntryValue > 0 ? (unrealizedPnl / totalEntryValue) * 100 : 0;

  return {
    isRunning,
    positionCount: positions.size,
    totalEntryValue,
    totalCurrentValue,
    unrealizedPnl,
    unrealizedPnlPercent,
  };
}

// Test runner
const positions = new Map<string, PumpFunPosition>();
let allTestsPassed = true;

function test(name: string, fn: () => boolean) {
  const passed = fn();
  console.log(`${passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}: ${name}`);
  if (!passed) allTestsPassed = false;
}

console.log('\n=== Testing PumpFunPositionMonitor.getStats() Logic ===\n');

// Test 1: Empty positions
test('Empty positions returns zeros', () => {
  const stats = getStats(positions, false);
  return stats.positionCount === 0 &&
         stats.totalEntryValue === 0 &&
         stats.totalCurrentValue === 0 &&
         stats.unrealizedPnl === 0 &&
         stats.unrealizedPnlPercent === 0;
});

// Test 2: Position without lastCurrentValueSol (before first check)
test('Position without lastCurrentValueSol falls back to entry value', () => {
  positions.set('mint1', {
    tokenMint: 'mint1',
    bondingCurve: 'curve1',
    entryAmountSol: 0.1,
    tokenAmount: 1000000,
    entryTimestamp: Date.now(),
    buySignature: 'sig1',
    // No lastCurrentValueSol - simulates before first position check
  });
  const stats = getStats(positions, false);
  return stats.positionCount === 1 &&
         stats.totalEntryValue === 0.1 &&
         stats.totalCurrentValue === 0.1 && // Falls back to entry
         stats.unrealizedPnl === 0;
});

// Test 3: Position with profit
test('Position with profit calculates correctly', () => {
  positions.set('mint2', {
    tokenMint: 'mint2',
    bondingCurve: 'curve2',
    entryAmountSol: 0.2,
    tokenAmount: 2000000,
    entryTimestamp: Date.now(),
    buySignature: 'sig2',
    lastCurrentValueSol: 0.3, // 50% profit
    lastCheckTimestamp: Date.now(),
  });
  const stats = getStats(positions, false);
  // Entry: 0.1 + 0.2 = 0.3
  // Current: 0.1 (fallback) + 0.3 = 0.4
  // PnL: 0.4 - 0.3 = 0.1
  return stats.positionCount === 2 &&
         Math.abs(stats.totalEntryValue - 0.3) < 0.0001 &&
         Math.abs(stats.totalCurrentValue - 0.4) < 0.0001 &&
         Math.abs(stats.unrealizedPnl - 0.1) < 0.0001;
});

// Test 4: Position with loss
test('Position with loss calculates negative PnL', () => {
  positions.set('mint3', {
    tokenMint: 'mint3',
    bondingCurve: 'curve3',
    entryAmountSol: 0.5,
    tokenAmount: 5000000,
    entryTimestamp: Date.now(),
    buySignature: 'sig3',
    lastCurrentValueSol: 0.35, // 30% loss
    lastCheckTimestamp: Date.now(),
  });
  const stats = getStats(positions, false);
  // Entry: 0.1 + 0.2 + 0.5 = 0.8
  // Current: 0.1 + 0.3 + 0.35 = 0.75
  // PnL: 0.75 - 0.8 = -0.05
  return stats.positionCount === 3 &&
         Math.abs(stats.totalEntryValue - 0.8) < 0.0001 &&
         Math.abs(stats.totalCurrentValue - 0.75) < 0.0001 &&
         Math.abs(stats.unrealizedPnl - (-0.05)) < 0.0001;
});

// Test 5: Percentage calculation
test('Unrealized PnL percentage calculates correctly', () => {
  const stats = getStats(positions, false);
  // PnL: -0.05, Entry: 0.8
  // Percent: (-0.05 / 0.8) * 100 = -6.25%
  const expectedPercent = (-0.05 / 0.8) * 100;
  return Math.abs(stats.unrealizedPnlPercent - expectedPercent) < 0.0001;
});

// Test 6: isRunning flag
test('isRunning flag is passed through correctly', () => {
  const statsRunning = getStats(positions, true);
  const statsNotRunning = getStats(positions, false);
  return statsRunning.isRunning === true && statsNotRunning.isRunning === false;
});

// Test 7: Large positions
test('Handles larger SOL amounts correctly', () => {
  const largePositions = new Map<string, PumpFunPosition>();
  largePositions.set('big1', {
    tokenMint: 'big1',
    bondingCurve: 'curve',
    entryAmountSol: 10.5,
    tokenAmount: 100000000,
    entryTimestamp: Date.now(),
    buySignature: 'sig',
    lastCurrentValueSol: 15.75, // 50% profit
  });
  const stats = getStats(largePositions, false);
  return stats.totalEntryValue === 10.5 &&
         stats.totalCurrentValue === 15.75 &&
         Math.abs(stats.unrealizedPnl - 5.25) < 0.0001 &&
         Math.abs(stats.unrealizedPnlPercent - 50) < 0.0001;
});

console.log('\n=== Results ===');
console.log(allTestsPassed
  ? '\x1b[32mAll tests passed!\x1b[0m'
  : '\x1b[31mSome tests failed!\x1b[0m');
console.log('');

process.exit(allTestsPassed ? 0 : 1);
