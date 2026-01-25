/**
 * Type definitions for the Solana Trading Bot
 *
 * Primary exports:
 * - DetectedToken: Unified interface for all detected tokens (pump.fun, Raydium, Meteora)
 * - TokenSource: Platform identifier ('pumpfun' | 'raydium-ammv4' | 'raydium-cpmm' | 'meteora-dlmm')
 * - PoolState: Discriminated union of pool states for type-safe handling
 */

// ══════════════════════════════════════════════════════════════════════════════
// Unified Token Detection Types (Primary)
// ══════════════════════════════════════════════════════════════════════════════

export {
  // Core types
  TokenSource,
  VerificationSource,
  PoolState,
  PumpFunState,

  // Main interface
  DetectedToken,

  // Pipeline results
  BuyResult,
  VerificationResult,
  TokenPipelineResult,

  // Statistics
  PlatformStats,
  UnifiedDetectionStats,

  // Event definitions
  UnifiedTokenEvents,

  // Helper functions
  createEmptyPlatformStats,
  createEmptyUnifiedStats,
  isPumpFunToken,
  isDexPoolToken,
  getSourceDisplayName,
} from './detected-token';

// ══════════════════════════════════════════════════════════════════════════════
// Pool-Specific Types
// ══════════════════════════════════════════════════════════════════════════════

export {
  // Pool types
  PoolType,
  TokenAgeResult,

  // Helper functions
  sourceToPoolType,
  poolTypeToSource,

  // Legacy types (deprecated but kept for backwards compatibility)
  PoolTypeStats,
  DetectionStats,
  createEmptyPoolTypeStats,
  createEmptyDetectionStats,
} from './detected-pool';
