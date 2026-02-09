/**
 * A/B Test Pipeline
 *
 * Reuses the SAME production classes (PumpFunFilters, MomentumGateStage,
 * getBondingCurveState) but instantiated per-variant rather than via singletons.
 *
 * Stage flow matches production:
 *   1. Per-variant dedupe (in-memory set)
 *   2. Token age check
 *   3. Rate limit check
 *   4. Name/symbol pattern check (stateless, same logic as cheap-gates)
 *   5. Bonding curve fetch + filters (same as deep-filters)
 *   6. Momentum gate (same as production)
 *
 * Skipped from production cheap-gates (not relevant for paper trading):
 *   - Wallet balance / exposure checks (virtual capital)
 *   - Blacklist (same for both variants, no value in testing)
 *   - Mint info RPC check (authority/freeze - same for both)
 *   - StateStore dedupe (each variant tracks its own)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { ABVariantConfig, ABPipelineResult } from './types';
import { PumpFunFilters, PumpFunFilterContext } from '../filters/pumpfun-filters';
import { MomentumGateStage } from '../pipeline/momentum-gate';
import { DetectionEvent, PipelineContext } from '../pipeline/types';
import { getBondingCurveState, BondingCurveState } from '../helpers/pumpfun';
import { logger } from '../helpers';

// Name/symbol junk patterns (copied from cheap-gates.ts for stateless reuse)
const JUNK_NAME_PATTERNS = [
  /^test$/i, /^scam$/i, /^rug$/i, /^rugpull$/i, /^fake$/i,
  /^honeypot$/i, /^aaa+$/i, /^xxx+$/i, /^asdf/i, /^qwerty/i,
];

const JUNK_SYMBOL_PATTERNS = [
  /^test$/i, /^scam$/i, /^rug$/i, /^xxx+$/i, /^aaa+$/i,
];

const SUSPICIOUS_INSTRUCTION_PATTERNS = ['InitializeMayhemState'];

function checkNameSymbol(name?: string, symbol?: string): string | null {
  if (name) {
    const trimmed = name.trim();
    if (trimmed.length === 0) return 'Empty token name';
    for (const p of JUNK_NAME_PATTERNS) {
      if (p.test(trimmed)) return `Name matches junk pattern: "${trimmed}"`;
    }
    const alpha = trimmed.replace(/[^a-zA-Z0-9]/g, '');
    if (trimmed.length > 3 && alpha.length < trimmed.length * 0.5) {
      return `Name has excessive special characters: "${trimmed}"`;
    }
  }
  if (symbol) {
    const trimmed = symbol.trim();
    if (trimmed.length === 0) return 'Empty token symbol';
    for (const p of JUNK_SYMBOL_PATTERNS) {
      if (p.test(trimmed)) return `Symbol matches junk pattern: "${trimmed}"`;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AB PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

const MAX_SEEN_MINTS = 50000;
const EVICTION_RATIO = 0.2;

export class ABPipeline {
  readonly variant: string;
  readonly config: ABVariantConfig;

  private connection: Connection;
  private seenMints: Set<string> = new Set();
  private filters: PumpFunFilters;
  private momentumGate: MomentumGateStage;
  private tradeTimestamps: number[] = [];

  constructor(variant: string, connection: Connection, config: ABVariantConfig) {
    this.variant = variant;
    this.connection = connection;
    this.config = config;

    // Instantiate production filter classes directly (no singletons)
    this.filters = new PumpFunFilters({
      minSolInCurve: config.pumpfunMinSolInCurve,
      maxSolInCurve: config.pumpfunMaxSolInCurve,
      enableMinSolFilter: true,
      enableMaxSolFilter: true,
      minScoreRequired: 0,
    });

    this.momentumGate = new MomentumGateStage(connection, {
      enabled: true,
      minTotalBuys: config.momentumMinTotalBuys,
      initialDelayMs: config.momentumInitialDelayMs,
      recheckIntervalMs: config.momentumRecheckIntervalMs,
      maxChecks: config.momentumMaxChecks,
    });

    logger.info(
      { variant, config: { tp: config.takeProfit, sl: config.stopLoss, minBuys: config.momentumMinTotalBuys } },
      `[ab-pipeline-${variant}] Initialized`
    );
  }

  /**
   * Process a detected token through this variant's pipeline.
   * Optionally accepts a pre-fetched bonding curve state to avoid duplicate RPC.
   */
  async process(
    detection: DetectionEvent,
    prefetchedState?: BondingCurveState | null,
  ): Promise<ABPipelineResult> {
    const start = Date.now();
    const mintStr = detection.mint.toString();

    // ── Gate 1: Per-variant dedupe ──────────────────────────────────────────
    if (this.seenMints.has(mintStr)) {
      return { passed: false, rejectionStage: 'dedupe', rejectionReason: 'Already seen', pipelineDurationMs: Date.now() - start };
    }
    this.seenMints.add(mintStr);
    this.evictOldMints();

    // ── Gate 2: Token age ───────────────────────────────────────────────────
    if (this.config.maxTokenAgeSeconds > 0 && detection.detectedAt) {
      const ageSeconds = (Date.now() - detection.detectedAt) / 1000;
      if (ageSeconds > this.config.maxTokenAgeSeconds) {
        return { passed: false, rejectionStage: 'token-age', rejectionReason: `Token age ${ageSeconds.toFixed(0)}s > max ${this.config.maxTokenAgeSeconds}s`, pipelineDurationMs: Date.now() - start };
      }
    }

    // ── Gate 3: Rate limit ──────────────────────────────────────────────────
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    this.tradeTimestamps = this.tradeTimestamps.filter(t => t > oneHourAgo);
    if (this.tradeTimestamps.length >= this.config.maxTradesPerHour) {
      return { passed: false, rejectionStage: 'rate-limit', rejectionReason: `Rate limit: ${this.tradeTimestamps.length} trades in last hour`, pipelineDurationMs: Date.now() - start };
    }

    // ── Gate 4: Name/symbol pattern check ───────────────────────────────────
    const patternFail = checkNameSymbol(detection.name, detection.symbol);
    if (patternFail) {
      return { passed: false, rejectionStage: 'pattern-check', rejectionReason: patternFail, pipelineDurationMs: Date.now() - start };
    }

    // ── Gate 4.5: Suspicious instruction check ──────────────────────────────
    if (detection.rawLogs && detection.rawLogs.length > 0) {
      for (const logLine of detection.rawLogs) {
        for (const pattern of SUSPICIOUS_INSTRUCTION_PATTERNS) {
          if (logLine.includes(pattern)) {
            return { passed: false, rejectionStage: 'suspicious-instruction', rejectionReason: `Suspicious: ${pattern}`, pipelineDurationMs: Date.now() - start };
          }
        }
      }
    }

    // ── Gate 5: Bonding curve + filters (deep-filters equivalent) ───────────
    let bondingCurveState = prefetchedState;
    if (bondingCurveState === undefined) {
      // No prefetched state - fetch ourselves
      try {
        bondingCurveState = await getBondingCurveState(this.connection, detection.bondingCurve);
      } catch (error) {
        return { passed: false, rejectionStage: 'deep-filters', rejectionReason: `Failed to fetch bonding curve: ${error}`, pipelineDurationMs: Date.now() - start };
      }
    }

    if (!bondingCurveState) {
      return { passed: false, rejectionStage: 'deep-filters', rejectionReason: 'Bonding curve not found', pipelineDurationMs: Date.now() - start };
    }

    if (bondingCurveState.complete) {
      return { passed: false, rejectionStage: 'deep-filters', rejectionReason: 'Already graduated', pipelineDurationMs: Date.now() - start };
    }

    // Run production PumpFunFilters
    const filterContext: PumpFunFilterContext = {
      mint: detection.mint,
      bondingCurve: detection.bondingCurve,
      bondingCurveState,
      creator: detection.creator || undefined,
      name: detection.name,
      symbol: detection.symbol,
      detectedAt: detection.detectedAt,
    };

    const filterResults = await this.filters.execute(filterContext);
    if (!filterResults.allPassed) {
      return { passed: false, rejectionStage: 'deep-filters', rejectionReason: `Filter failed: ${filterResults.summary}`, pipelineDurationMs: Date.now() - start };
    }

    // ── Gate 6: Momentum gate ───────────────────────────────────────────────
    // Build a minimal PipelineContext for the momentum gate
    const pipelineContext: PipelineContext = {
      detection,
    };

    const momentumResult = await this.momentumGate.execute(pipelineContext);
    if (!momentumResult.pass) {
      return { passed: false, rejectionStage: 'momentum-gate', rejectionReason: momentumResult.reason, pipelineDurationMs: Date.now() - start };
    }

    // ── ALL STAGES PASSED ───────────────────────────────────────────────────
    this.tradeTimestamps.push(Date.now());

    return {
      passed: true,
      bondingCurveState,
      bondingCurve: detection.bondingCurve,
      pipelineDurationMs: Date.now() - start,
    };
  }

  private evictOldMints(): void {
    if (this.seenMints.size > MAX_SEEN_MINTS) {
      const toRemove = Math.floor(MAX_SEEN_MINTS * EVICTION_RATIO);
      const iterator = this.seenMints.values();
      for (let i = 0; i < toRemove; i++) {
        const next = iterator.next();
        if (next.done) break;
        this.seenMints.delete(next.value);
      }
    }
  }
}
