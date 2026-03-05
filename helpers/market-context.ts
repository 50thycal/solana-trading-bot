/**
 * Market Context Provider
 *
 * Fetches market-wide context from:
 * 1. Research bot API (if RESEARCH_BOT_URL is configured) — rich data with 2x rates, peak gains
 * 2. Self-derived fallback from own pool_detections — always available
 *
 * Runs on a background interval, stores snapshots in the market_snapshots table.
 *
 * @module helpers/market-context
 */

import axios from 'axios';
import { logger } from '../helpers';
import { getConfig } from './config-validator';
import { getStateStore } from '../persistence';
import { MarketSnapshotRecord } from '../persistence/models';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

/** Response shape from the research bot's /api/market-summary endpoint */
export interface ResearchBotMarketSummary {
  period: { from: number; to: number };
  tokens_created: number;
  tokens_with_2x: number;
  hit_2x_rate_pct: number;
  avg_initial_price_sol?: number;
  avg_peak_gain_pct: number;
  median_peak_gain_pct: number;
  avg_buy_velocity: number;
  avg_sell_ratio: number;
  total_snapshots?: number;
  coverage_pct?: number;
}

/** Unified market context used by the analysis engine */
export interface MarketContext {
  capturedAt: number;
  periodFrom: number;
  periodTo: number;
  source: 'research_bot' | 'self';
  // Self-derived (always available)
  tokensDetected: number;
  tokensBought: number;
  tokensFiltered: number;
  buyRatePct: number;
  avgSolInCurve?: number;
  topRejection?: string;
  // Research bot (only when source = 'research_bot')
  tokensCreatedMarket?: number;
  tokensWith2x?: number;
  hit2xRatePct?: number;
  avgPeakGainPct?: number;
  medianPeakGainPct?: number;
  avgBuyVelocity?: number;
  avgSellRatio?: number;
}

// ════════════════════════════════════════════════════════════════════════════
// MODULE STATE
// ════════════════════════════════════════════════════════════════════════════

const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let latestContext: MarketContext | null = null;

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Start the background market context fetcher.
 * Takes an immediate snapshot, then runs every 5 minutes.
 */
export function startMarketContextFetcher(): void {
  if (intervalHandle) return; // already running

  logger.info('Starting market context fetcher (interval: 5 min)');

  // Take an immediate snapshot
  captureMarketSnapshot().catch(err =>
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Initial market snapshot failed')
  );

  intervalHandle = setInterval(() => {
    captureMarketSnapshot().catch(err =>
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Market snapshot capture failed')
    );
  }, SNAPSHOT_INTERVAL_MS);
}

/**
 * Stop the background fetcher (call during graceful shutdown)
 */
export function stopMarketContextFetcher(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    logger.info('Market context fetcher stopped');
  }
}

/**
 * Get the most recently captured market context (from memory cache)
 */
export function getLatestMarketContext(): MarketContext | null {
  return latestContext;
}

/**
 * Get market context for a specific time range from the database.
 * Returns the most recent snapshot that overlaps the given range.
 */
export function getMarketContextForRange(from: number, to: number): MarketContext | null {
  const store = getStateStore();
  if (!store) return null;

  const snapshots = store.getMarketSnapshots(from, to);
  if (snapshots.length === 0) return null;

  // Prefer research_bot snapshots over self-derived
  const researchSnapshot = snapshots.find(s => s.source === 'research_bot');
  const snapshot = researchSnapshot || snapshots[snapshots.length - 1];

  return snapshotToContext(snapshot);
}

/**
 * Get all market snapshots for a time range, aggregated into a single summary.
 * Useful for the AI analysis report.
 */
export function getAggregatedMarketContext(from: number, to: number): MarketContext | null {
  const store = getStateStore();
  if (!store) return null;

  const snapshots = store.getMarketSnapshots(from, to);
  if (snapshots.length === 0) return null;

  // Separate by source
  const researchSnapshots = snapshots.filter(s => s.source === 'research_bot');
  const selfSnapshots = snapshots.filter(s => s.source === 'self');

  // Aggregate self-derived data
  const totalDetected = selfSnapshots.reduce((s, r) => s + r.tokensCreated, 0);
  const totalBought = selfSnapshots.reduce((s, r) => s + r.tokensBought, 0);
  const totalFiltered = selfSnapshots.reduce((s, r) => s + r.tokensFiltered, 0);

  const context: MarketContext = {
    capturedAt: Date.now(),
    periodFrom: from,
    periodTo: to,
    source: researchSnapshots.length > 0 ? 'research_bot' : 'self',
    tokensDetected: totalDetected,
    tokensBought: totalBought,
    tokensFiltered: totalFiltered,
    buyRatePct: totalDetected > 0 ? (totalBought / totalDetected) * 100 : 0,
  };

  // Aggregate self-derived averages
  const withCurve = selfSnapshots.filter(s => s.avgSolInCurve != null);
  if (withCurve.length > 0) {
    context.avgSolInCurve = withCurve.reduce((s, r) => s + r.avgSolInCurve!, 0) / withCurve.length;
  }

  // Find most common rejection reason
  const rejectionCounts: Record<string, number> = {};
  for (const s of selfSnapshots) {
    if (s.topRejectionReason) {
      rejectionCounts[s.topRejectionReason] = (rejectionCounts[s.topRejectionReason] || 0) + 1;
    }
  }
  const topRejectionEntry = Object.entries(rejectionCounts).sort((a, b) => b[1] - a[1])[0];
  if (topRejectionEntry) {
    context.topRejection = topRejectionEntry[0];
  }

  // Aggregate research bot data
  if (researchSnapshots.length > 0) {
    const avg = (field: keyof MarketSnapshotRecord) => {
      const vals = researchSnapshots.filter(s => s[field] != null).map(s => s[field] as number);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
    };

    context.tokensCreatedMarket = researchSnapshots.reduce((s, r) => s + r.tokensCreated, 0);
    context.tokensWith2x = researchSnapshots.reduce((s, r) => s + (r.tokensWith2x || 0), 0);
    context.hit2xRatePct = avg('hit2xRatePct');
    context.avgPeakGainPct = avg('avgPeakGainPct');
    context.medianPeakGainPct = avg('medianPeakGainPct');
    context.avgBuyVelocity = avg('avgBuyVelocity');
    context.avgSellRatio = avg('avgSellRatio');
  }

  return context;
}

// ════════════════════════════════════════════════════════════════════════════
// INTERNAL — SNAPSHOT CAPTURE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Capture a market snapshot from both sources and persist to DB
 */
async function captureMarketSnapshot(): Promise<void> {
  const store = getStateStore();
  if (!store) return;

  const now = Date.now();
  const periodFrom = now - SNAPSHOT_INTERVAL_MS;
  const periodTo = now;

  // Always capture self-derived snapshot from pool detections
  captureSelfSnapshot(store, periodFrom, periodTo);

  // Attempt research bot fetch if configured
  const config = getConfig();
  if (config.researchBotUrl) {
    await captureResearchBotSnapshot(store, config.researchBotUrl, periodFrom, periodTo);
  }
}

/**
 * Derive a market snapshot from the bot's own pool_detections table
 */
function captureSelfSnapshot(
  store: NonNullable<ReturnType<typeof getStateStore>>,
  from: number,
  to: number,
): void {
  const stats = store.getPoolDetectionStatsForRange(from, to);
  if (stats.total === 0) return; // No detections in this window

  const topRejection = Object.entries(stats.topRejections)
    .sort((a, b) => b[1] - a[1])[0];

  const snapshot: Omit<MarketSnapshotRecord, 'id'> = {
    capturedAt: Date.now(),
    periodFrom: from,
    periodTo: to,
    tokensCreated: stats.total,
    tokensBought: stats.bought,
    tokensFiltered: stats.filtered,
    avgSolInCurve: stats.avgQuoteReserve ?? undefined,
    topRejectionReason: topRejection ? topRejection[0] : undefined,
    source: 'self',
  };

  store.recordMarketSnapshot(snapshot);

  // Update in-memory cache
  latestContext = {
    capturedAt: snapshot.capturedAt,
    periodFrom: from,
    periodTo: to,
    source: 'self',
    tokensDetected: stats.total,
    tokensBought: stats.bought,
    tokensFiltered: stats.filtered,
    buyRatePct: stats.total > 0 ? (stats.bought / stats.total) * 100 : 0,
    avgSolInCurve: stats.avgQuoteReserve ?? undefined,
    topRejection: topRejection ? topRejection[0] : undefined,
  };

  logger.trace(
    { detected: stats.total, bought: stats.bought, filtered: stats.filtered },
    'Self-derived market snapshot captured',
  );
}

/**
 * Fetch market summary from the research bot API and persist
 */
async function captureResearchBotSnapshot(
  store: NonNullable<ReturnType<typeof getStateStore>>,
  baseUrl: string,
  from: number,
  to: number,
): Promise<void> {
  try {
    const url = `${baseUrl.replace(/\/$/, '')}/api/market-summary`;
    const response = await axios.get<ResearchBotMarketSummary>(url, {
      params: {
        from: Math.floor(from / 1000), // research bot may expect seconds
        to: Math.floor(to / 1000),
      },
      timeout: 10000, // 10s timeout
    });

    const data = response.data;
    if (!data || typeof data.tokens_created !== 'number') {
      logger.warn('Research bot returned unexpected data format');
      return;
    }

    const snapshot: Omit<MarketSnapshotRecord, 'id'> = {
      capturedAt: Date.now(),
      periodFrom: data.period?.from ? data.period.from * 1000 : from,
      periodTo: data.period?.to ? data.period.to * 1000 : to,
      tokensCreated: data.tokens_created,
      tokensBought: 0,  // research bot doesn't track our buys
      tokensFiltered: 0,
      source: 'research_bot',
      tokensWith2x: data.tokens_with_2x,
      hit2xRatePct: data.hit_2x_rate_pct,
      avgPeakGainPct: data.avg_peak_gain_pct,
      medianPeakGainPct: data.median_peak_gain_pct,
      avgBuyVelocity: data.avg_buy_velocity,
      avgSellRatio: data.avg_sell_ratio,
    };

    store.recordMarketSnapshot(snapshot);

    // Update in-memory cache with research bot data merged
    if (latestContext) {
      latestContext.source = 'research_bot';
      latestContext.tokensCreatedMarket = data.tokens_created;
      latestContext.tokensWith2x = data.tokens_with_2x;
      latestContext.hit2xRatePct = data.hit_2x_rate_pct;
      latestContext.avgPeakGainPct = data.avg_peak_gain_pct;
      latestContext.medianPeakGainPct = data.median_peak_gain_pct;
      latestContext.avgBuyVelocity = data.avg_buy_velocity;
      latestContext.avgSellRatio = data.avg_sell_ratio;
    }

    logger.info(
      {
        tokensCreated: data.tokens_created,
        hit2xRate: data.hit_2x_rate_pct,
        avgPeakGain: data.avg_peak_gain_pct,
      },
      'Research bot market snapshot captured',
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.response) {
        logger.warn(
          { status: err.response.status, url: baseUrl },
          'Research bot API returned error',
        );
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        logger.debug({ url: baseUrl }, 'Research bot not reachable (will retry next interval)');
      } else {
        logger.warn({ code: err.code, url: baseUrl }, 'Research bot fetch failed');
      }
    } else {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Research bot fetch error',
      );
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

function snapshotToContext(snapshot: MarketSnapshotRecord): MarketContext {
  return {
    capturedAt: snapshot.capturedAt,
    periodFrom: snapshot.periodFrom,
    periodTo: snapshot.periodTo,
    source: snapshot.source as 'research_bot' | 'self',
    tokensDetected: snapshot.tokensCreated,
    tokensBought: snapshot.tokensBought,
    tokensFiltered: snapshot.tokensFiltered,
    buyRatePct: snapshot.tokensCreated > 0
      ? (snapshot.tokensBought / snapshot.tokensCreated) * 100
      : 0,
    avgSolInCurve: snapshot.avgSolInCurve,
    topRejection: snapshot.topRejectionReason,
    tokensCreatedMarket: snapshot.source === 'research_bot' ? snapshot.tokensCreated : undefined,
    tokensWith2x: snapshot.tokensWith2x,
    hit2xRatePct: snapshot.hit2xRatePct,
    avgPeakGainPct: snapshot.avgPeakGainPct,
    medianPeakGainPct: snapshot.medianPeakGainPct,
    avgBuyVelocity: snapshot.avgBuyVelocity,
    avgSellRatio: snapshot.avgSellRatio,
  };
}
