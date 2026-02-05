/**
 * Type definitions for the Solana Trading Bot
 *
 * Primary exports:
 * - DetectedToken: Unified interface for detected pump.fun tokens
 * - TokenSource: Platform identifier ('pumpfun')
 * - PoolState: Bonding curve state for type-safe handling
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
  getSourceDisplayName,
} from './detected-token';

// ══════════════════════════════════════════════════════════════════════════════
// Pool-Specific Types
// ══════════════════════════════════════════════════════════════════════════════

export {
  TokenAgeResult,
} from './detected-pool';
