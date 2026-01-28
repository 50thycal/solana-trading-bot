/**
 * Cheap Gates Stage
 *
 * Stage 2 of the pipeline - fast pass/fail checks with minimal RPC calls.
 *
 * Rules:
 * - Free gates: No RPC calls (use local state only)
 * - Single RPC gate: One getMint() call for mint info
 * - Hard pass/fail only (no scoring)
 * - Every rejection logged with clear reason
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import {
  DetectionEvent,
  StageResult,
  CheapGatesData,
  PipelineContext,
  PipelineStage,
  RejectionReasons,
} from './types';
import { getBlacklist, getExposureManager } from '../risk';
import { getStateStore } from '../persistence';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// JUNK PATTERN DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Patterns that indicate obvious junk/scam tokens.
 * Only hard-reject the most obvious cases.
 */
const JUNK_NAME_PATTERNS = [
  /^test$/i,
  /^scam$/i,
  /^rug$/i,
  /^rugpull$/i,
  /^fake$/i,
  /^honeypot$/i,
  /^aaa+$/i, // "AAA", "AAAA", etc.
  /^xxx+$/i, // "XXX", "XXXX", etc.
  /^asdf/i, // keyboard mash
  /^qwerty/i,
];

const JUNK_SYMBOL_PATTERNS = [
  /^test$/i,
  /^scam$/i,
  /^rug$/i,
  /^xxx+$/i,
  /^aaa+$/i,
];

/**
 * Check if name/symbol matches junk patterns.
 * Returns { passed: true } if OK, { passed: false, reason } if junk.
 */
function checkNameSymbolPatterns(
  name: string | undefined,
  symbol: string | undefined
): { passed: boolean; reason?: string } {
  // Missing metadata is NOT a hard fail - handle gracefully
  if (!name && !symbol) {
    return { passed: true };
  }

  // Check name against junk patterns
  if (name) {
    const trimmedName = name.trim();

    // Empty or single character names are suspicious
    if (trimmedName.length === 0) {
      return { passed: false, reason: 'Empty token name' };
    }

    // Check against known junk patterns
    for (const pattern of JUNK_NAME_PATTERNS) {
      if (pattern.test(trimmedName)) {
        return { passed: false, reason: `Name matches junk pattern: "${trimmedName}"` };
      }
    }

    // Excessive special characters (more than 50% non-alphanumeric)
    const alphanumeric = trimmedName.replace(/[^a-zA-Z0-9]/g, '');
    if (trimmedName.length > 3 && alphanumeric.length < trimmedName.length * 0.5) {
      return { passed: false, reason: `Name has excessive special characters: "${trimmedName}"` };
    }
  }

  // Check symbol against junk patterns
  if (symbol) {
    const trimmedSymbol = symbol.trim();

    // Empty symbols are suspicious
    if (trimmedSymbol.length === 0) {
      return { passed: false, reason: 'Empty token symbol' };
    }

    // Check against known junk patterns
    for (const pattern of JUNK_SYMBOL_PATTERNS) {
      if (pattern.test(trimmedSymbol)) {
        return { passed: false, reason: `Symbol matches junk pattern: "${trimmedSymbol}"` };
      }
    }
  }

  return { passed: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHEAP GATES STAGE
// ═══════════════════════════════════════════════════════════════════════════════

export interface CheapGatesConfig {
  /** Trade amount in SOL for exposure check */
  tradeAmountSol: number;

  /** Allow Token-2022 tokens? (default: false for safety) */
  allowToken2022: boolean;

  /** Skip mint info check? (for testing only) */
  skipMintInfoCheck: boolean;
}

const DEFAULT_CONFIG: CheapGatesConfig = {
  tradeAmountSol: 0.01,
  allowToken2022: false,
  skipMintInfoCheck: false,
};

/**
 * CheapGatesStage - Fast pass/fail checks with minimal RPC
 *
 * Order of checks (cheapest first):
 * 1. Dedupe (signature/mint already seen?) - FREE
 * 2. Blacklist (creator/mint blacklisted?) - FREE
 * 3. Exposure check (can we afford this trade?) - FREE
 * 4. Name/symbol pattern check - FREE
 * 5. Mint info check (authority, freeze) - 1 RPC CALL
 */
export class CheapGatesStage implements PipelineStage<PipelineContext, CheapGatesData> {
  name = 'cheap-gates';

  private connection: Connection;
  private config: CheapGatesConfig;

  constructor(connection: Connection, config: Partial<CheapGatesConfig> = {}) {
    this.connection = connection;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async execute(context: PipelineContext): Promise<StageResult<CheapGatesData>> {
    const startTime = Date.now();
    const { detection } = context;
    const mintStr = detection.mint.toString();
    const creatorStr = detection.creator?.toString();

    // ═══════════════════════════════════════════════════════════════════════════
    // FREE GATE 1: Dedupe Check
    // ═══════════════════════════════════════════════════════════════════════════
    const stateStore = getStateStore();
    if (stateStore) {
      // Check if signature already processed
      const bondingCurveStr = detection.bondingCurve.toString();

      if (stateStore.hasSeenPool(bondingCurveStr)) {
        return this.reject(
          RejectionReasons.ALREADY_PROCESSED,
          startTime,
          { mint: mintStr, bondingCurve: bondingCurveStr }
        );
      }

      // Check if we already have an open position
      if (stateStore.hasOpenPosition(mintStr)) {
        return this.reject(
          RejectionReasons.ALREADY_OWNED,
          startTime,
          { mint: mintStr }
        );
      }

      // Check for pending trade
      const pendingTrade = stateStore.getPendingTradeForToken(mintStr, 'buy');
      if (pendingTrade) {
        return this.reject(
          RejectionReasons.PENDING_TRADE,
          startTime,
          { mint: mintStr, tradeId: pendingTrade.id }
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FREE GATE 2: Blacklist Check
    // ═══════════════════════════════════════════════════════════════════════════
    const blacklist = getBlacklist();

    if (blacklist.isTokenBlacklisted(mintStr)) {
      return this.reject(
        RejectionReasons.MINT_BLACKLISTED,
        startTime,
        { mint: mintStr }
      );
    }

    if (creatorStr && blacklist.isCreatorBlacklisted(creatorStr)) {
      return this.reject(
        RejectionReasons.CREATOR_BLACKLISTED,
        startTime,
        { mint: mintStr, creator: creatorStr }
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FREE GATE 3: Exposure Check
    // ═══════════════════════════════════════════════════════════════════════════
    const exposureManager = getExposureManager();
    if (exposureManager) {
      const exposureCheck = await exposureManager.canTrade(this.config.tradeAmountSol);

      if (!exposureCheck.allowed) {
        const reason = exposureCheck.reason || 'Exposure limit exceeded';

        // Map to specific rejection reason
        if (reason.includes('exposure')) {
          return this.reject(RejectionReasons.EXPOSURE_LIMIT, startTime, { mint: mintStr, reason });
        } else if (reason.includes('trades per hour')) {
          return this.reject(RejectionReasons.TRADES_PER_HOUR, startTime, { mint: mintStr, reason });
        } else if (reason.includes('balance') || reason.includes('buffer')) {
          return this.reject(RejectionReasons.INSUFFICIENT_BALANCE, startTime, { mint: mintStr, reason });
        }

        return this.reject(reason, startTime, { mint: mintStr });
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // FREE GATE 4: Name/Symbol Pattern Check
    // ═══════════════════════════════════════════════════════════════════════════
    const patternCheck = checkNameSymbolPatterns(detection.name, detection.symbol);

    if (!patternCheck.passed) {
      return this.reject(
        patternCheck.reason || RejectionReasons.JUNK_NAME,
        startTime,
        { mint: mintStr, name: detection.name, symbol: detection.symbol }
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RPC GATE: Mint Info Check (single getMint() call)
    // ═══════════════════════════════════════════════════════════════════════════
    let mintInfo: CheapGatesData['mintInfo'];

    if (!this.config.skipMintInfoCheck) {
      try {
        // Try SPL Token first
        let mint;
        let isToken2022 = false;

        try {
          mint = await getMint(this.connection, detection.mint, 'confirmed', TOKEN_PROGRAM_ID);
        } catch {
          // Try Token-2022
          try {
            mint = await getMint(this.connection, detection.mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
            isToken2022 = true;
          } catch (e) {
            return this.reject(
              'Failed to fetch mint info',
              startTime,
              { mint: mintStr, error: String(e) }
            );
          }
        }

        // Check Token-2022 policy
        if (isToken2022 && !this.config.allowToken2022) {
          return this.reject(
            RejectionReasons.TOKEN_2022_UNSUPPORTED,
            startTime,
            { mint: mintStr }
          );
        }

        // Check mint authority (must be null = renounced)
        if (mint.mintAuthority !== null) {
          return this.reject(
            RejectionReasons.MINT_NOT_RENOUNCED,
            startTime,
            { mint: mintStr, mintAuthority: mint.mintAuthority.toString() }
          );
        }

        // Check freeze authority (must be null = no freeze)
        if (mint.freezeAuthority !== null) {
          return this.reject(
            RejectionReasons.HAS_FREEZE_AUTHORITY,
            startTime,
            { mint: mintStr, freezeAuthority: mint.freezeAuthority.toString() }
          );
        }

        // Sanity check: decimals should be reasonable (0-18)
        if (mint.decimals > 18) {
          return this.reject(
            RejectionReasons.INVALID_DECIMALS,
            startTime,
            { mint: mintStr, decimals: mint.decimals }
          );
        }

        mintInfo = {
          mintAuthority: mint.mintAuthority,
          freezeAuthority: mint.freezeAuthority,
          decimals: mint.decimals,
          supply: mint.supply,
          isToken2022,
        };
      } catch (error) {
        return this.reject(
          `Mint info check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          startTime,
          { mint: mintStr }
        );
      }
    } else {
      // Skip mint info check (testing mode)
      mintInfo = {
        mintAuthority: null,
        freezeAuthority: null,
        decimals: 6,
        supply: BigInt(0),
        isToken2022: false,
      };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // ALL GATES PASSED
    // ═══════════════════════════════════════════════════════════════════════════
    const duration = Date.now() - startTime;

    logger.debug(
      {
        stage: this.name,
        mint: mintStr,
        durationMs: duration,
        mintAuthority: mintInfo.mintAuthority?.toString() || 'null',
        freezeAuthority: mintInfo.freezeAuthority?.toString() || 'null',
        decimals: mintInfo.decimals,
        isToken2022: mintInfo.isToken2022,
      },
      '[pipeline] Cheap gates passed'
    );

    return {
      pass: true,
      reason: 'All cheap gates passed',
      stage: this.name,
      data: {
        mintInfo,
        patternCheck,
      },
      durationMs: duration,
    };
  }

  /**
   * Helper to create rejection result with consistent logging
   */
  private reject(
    reason: string,
    startTime: number,
    logData: Record<string, unknown> = {}
  ): StageResult<CheapGatesData> {
    const duration = Date.now() - startTime;

    logger.info(
      {
        stage: this.name,
        reason,
        durationMs: duration,
        ...logData,
      },
      `[pipeline] Rejected: ${reason}`
    );

    return {
      pass: false,
      reason,
      stage: this.name,
      durationMs: duration,
    };
  }
}
