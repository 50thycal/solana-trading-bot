/**
 * AI Analysis Engine
 *
 * Computes structured analysis reports from the trading bot's SQLite data.
 * Outputs are optimized for pasting into Claude for AI-assisted improvement.
 *
 * @module helpers/ai-analysis
 */

import { getStateStore } from '../persistence';
import { RunJournalRecord, PositionRecord, TradeRecord, PoolDetectionRecord } from '../persistence/models';
import { getTradeAuditManager } from './trade-audit';
import { getPipelineStats } from '../pipeline';
import { getAggregatedMarketContext, MarketContext } from './market-context';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface AnalysisReport {
  generatedAt: number;
  session: SessionSummary | null;
  performance: PerformanceSummary;
  pipeline: PipelineSummary;
  exitAnalysis: ExitAnalysis;
  entryCorrelations: EntryCorrelation[];
  timeOfDay: TimeOfDayBucket[];
  crossRunComparison: CrossRunEntry[];
  marketContext: MarketContextSummary | null;
}

interface SessionSummary {
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  durationMinutes: number;
  hypothesis: string;
  botMode: string;
  quoteAmountSol: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxHoldDurationS: number;
  sniperGateEnabled: boolean;
  trailingStopEnabled: boolean;
  tags?: string;
}

interface PerformanceSummary {
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnlSol: number;
  avgWinSol: number;
  avgLossSol: number;
  expectancySol: number;
  bestTrade: TradeDetail | null;
  worstTrade: TradeDetail | null;
  holdDurations: { bucket: string; count: number }[];
}

interface TradeDetail {
  tokenMint: string;
  pnlSol: number;
  pnlPercent: number;
  holdDurationS: number;
  exitReason: string;
}

interface PipelineSummary {
  totalDetected: number;
  passedCheapGates: number;
  passedDeepFilters: number;
  passedGate: number;
  bought: number;
  buyRate: number;
  topRejections: { reason: string; count: number }[];
  profitableOfBought: number;
  profitableRate: number;
}

interface ExitAnalysis {
  byReason: { reason: string; count: number; avgPnlSol: number }[];
  totalExits: number;
}

interface EntryCorrelation {
  metric: string;
  buckets: { range: string; trades: number; winRate: number; avgPnlSol: number }[];
}

interface TimeOfDayBucket {
  hourUtc: number;
  trades: number;
  wins: number;
  winRate: number;
  pnlSol: number;
}

interface CrossRunEntry {
  sessionId: string;
  hypothesis: string;
  startedAt: number;
  trades: number;
  winRate: number;
  pnlSol: number;
  keyConfig: string;
}

interface MarketContextSummary {
  tokensDetected: number;
  tokensBought: number;
  tokensFiltered: number;
  buyRatePct: number;
  topRejection: string;
  // Research bot enrichment (when available)
  source: 'self' | 'research_bot';
  tokensCreatedMarket?: number;
  tokensWith2x?: number;
  hit2xRatePct?: number;
  avgPeakGainPct?: number;
  medianPeakGainPct?: number;
  avgBuyVelocity?: number;
  avgSellRatio?: number;
  // Derived comparison
  yourWinRateVsMarket?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// ANALYSIS ENGINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate a full analysis report for a specific session or the most recent one
 */
export function generateAnalysisReport(sessionId?: string): AnalysisReport {
  const store = getStateStore();
  if (!store) {
    return emptyReport();
  }

  // Get the session
  const journal = sessionId
    ? store.getJournalEntry(sessionId)
    : store.getLatestJournalEntry();

  const session = journal ? buildSessionSummary(journal) : null;

  // Get time range for queries
  const from = journal?.startedAt ?? 0;
  const to = journal?.endedAt ?? Date.now();

  // Get closed positions with trades
  const closedPositions = store.getClosedPositionsWithTrades();
  // Filter to session time range if available
  const sessionPositions = from > 0
    ? closedPositions.filter(p => p.position.entryTimestamp >= from && p.position.entryTimestamp <= to)
    : closedPositions;

  const performance = buildPerformance(sessionPositions);
  const pipeline = buildPipelineSummary(store, from, to, sessionPositions);
  const exitAnalysis = buildExitAnalysis(sessionPositions);
  const entryCorrelations = buildEntryCorrelations(store, sessionPositions);
  const timeOfDay = buildTimeOfDay(sessionPositions);
  const crossRunComparison = buildCrossRunComparison(store);
  const marketContext = buildMarketContext(store, from, to, performance.winRate);

  return {
    generatedAt: Date.now(),
    session,
    performance,
    pipeline,
    exitAnalysis,
    entryCorrelations,
    timeOfDay,
    crossRunComparison,
    marketContext,
  };
}

/**
 * Generate a compact text report optimized for pasting into Claude
 */
export function generateCompactReport(sessionId?: string, lastN?: number): string {
  const store = getStateStore();
  if (!store) return '# Trading Bot Analysis Report\n\nNo data available (state store not initialized).\n';

  const lines: string[] = [];
  lines.push('# Trading Bot Analysis Report');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  // If lastN is specified, generate reports for the last N sessions
  const journals = lastN
    ? store.getJournalEntries(lastN)
    : sessionId
      ? [store.getJournalEntry(sessionId)].filter(Boolean) as RunJournalRecord[]
      : [store.getLatestJournalEntry()].filter(Boolean) as RunJournalRecord[];

  if (journals.length === 0) {
    // No journal entries yet — still generate from raw trade data
    const report = generateAnalysisReport();
    lines.push('## No run journal entries found');
    lines.push('Generating report from all available trade data.');
    lines.push('');
    appendPerformanceSection(lines, report.performance);
    appendPipelineSection(lines, report.pipeline);
    appendExitSection(lines, report.exitAnalysis);
    appendTimeOfDaySection(lines, report.timeOfDay);
    return lines.join('\n');
  }

  for (const journal of journals) {
    const report = generateAnalysisReport(journal.sessionId);

    lines.push(`## Session: ${journal.sessionId}`);
    const startStr = new Date(journal.startedAt).toISOString().replace('T', ' ').substring(0, 19);
    const endStr = journal.endedAt
      ? new Date(journal.endedAt).toISOString().replace('T', ' ').substring(0, 19)
      : 'running';
    lines.push(`Period: ${startStr} → ${endStr} UTC`);
    if (journal.hypothesis) {
      lines.push(`Hypothesis: "${journal.hypothesis}"`);
    }
    lines.push('');

    // Key config params
    lines.push('### Config');
    lines.push(`QUOTE_AMOUNT=${journal.quoteAmountSol} SOL | TP=${journal.takeProfitPct}% | SL=${journal.stopLossPct}% | MAX_HOLD=${journal.maxHoldDurationS}s`);
    const gates = [];
    if (journal.sniperGateEnabled) gates.push('sniper_gate');
    if (journal.trailingStopEnabled) gates.push('trailing_stop');
    lines.push(`Gates: ${gates.length > 0 ? gates.join(', ') : 'none'}`);
    lines.push('');

    appendPerformanceSection(lines, report.performance);
    appendPipelineSection(lines, report.pipeline);
    appendExitSection(lines, report.exitAnalysis);
    appendEntryCorrelationSection(lines, report.entryCorrelations);
    appendTimeOfDaySection(lines, report.timeOfDay);

    if (report.marketContext) {
      lines.push('### Market Context (this session)');
      lines.push(`Source: ${report.marketContext.source}`);
      lines.push(`Tokens detected: ${report.marketContext.tokensDetected} | Bought: ${report.marketContext.tokensBought} | Filtered: ${report.marketContext.tokensFiltered}`);
      lines.push(`Buy rate: ${report.marketContext.buyRatePct.toFixed(1)}%`);
      if (report.marketContext.topRejection) {
        lines.push(`Top rejection: ${report.marketContext.topRejection}`);
      }
      // Research bot enrichment
      if (report.marketContext.source === 'research_bot') {
        lines.push('');
        lines.push('**Market-wide (from research bot):**');
        if (report.marketContext.tokensCreatedMarket != null) {
          lines.push(`Tokens created: ${report.marketContext.tokensCreatedMarket}`);
        }
        if (report.marketContext.tokensWith2x != null && report.marketContext.hit2xRatePct != null) {
          lines.push(`Hit 2x: ${report.marketContext.tokensWith2x} tokens (${report.marketContext.hit2xRatePct.toFixed(1)}%)`);
        }
        if (report.marketContext.avgPeakGainPct != null) {
          lines.push(`Avg peak gain: ${report.marketContext.avgPeakGainPct.toFixed(1)}% | Median: ${report.marketContext.medianPeakGainPct?.toFixed(1) ?? '?'}%`);
        }
        if (report.marketContext.avgBuyVelocity != null) {
          lines.push(`Avg buy velocity: ${report.marketContext.avgBuyVelocity.toFixed(2)} | Avg sell ratio: ${report.marketContext.avgSellRatio?.toFixed(2) ?? '?'}`);
        }
        if (report.marketContext.yourWinRateVsMarket) {
          lines.push(`**Comparison:** ${report.marketContext.yourWinRateVsMarket}`);
        }
      }
      lines.push('');
    }

    if (journal.outcomeNotes) {
      lines.push(`### Notes: ${journal.outcomeNotes}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  // Cross-run comparison
  if (journals.length > 1 || (lastN && lastN > 1)) {
    const allJournals = store.getJournalEntries(lastN || 10);
    if (allJournals.length > 1) {
      lines.push('## Cross-Run Comparison');
      for (const j of allJournals) {
        const pnlSign = j.realizedPnlSol >= 0 ? '+' : '';
        lines.push(
          `- ${j.sessionId.substring(0, 20)}: ${pnlSign}${j.realizedPnlSol.toFixed(4)} SOL | ` +
          `${j.totalTrades} trades | TP=${j.takeProfitPct}% SL=${j.stopLossPct}% | ` +
          `"${j.hypothesis || 'no hypothesis'}"`
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION BUILDERS
// ════════════════════════════════════════════════════════════════════════════

function appendPerformanceSection(lines: string[], perf: PerformanceSummary): void {
  lines.push('### Performance');
  lines.push(`Trades: ${perf.totalTrades} | Wins: ${perf.wins} | Losses: ${perf.losses} | Win Rate: ${(perf.winRate * 100).toFixed(1)}%`);

  const pnlSign = perf.totalPnlSol >= 0 ? '+' : '';
  lines.push(`P&L: ${pnlSign}${perf.totalPnlSol.toFixed(4)} SOL`);
  if (perf.totalTrades > 0) {
    lines.push(`Avg Win: +${perf.avgWinSol.toFixed(4)} SOL | Avg Loss: ${perf.avgLossSol.toFixed(4)} SOL`);
    const expSign = perf.expectancySol >= 0 ? '+' : '';
    lines.push(`Expectancy: ${expSign}${perf.expectancySol.toFixed(4)} SOL/trade`);
  }

  if (perf.bestTrade) {
    lines.push(`Best: ${perf.bestTrade.tokenMint.substring(0, 8)}... +${perf.bestTrade.pnlSol.toFixed(4)} SOL (${perf.bestTrade.holdDurationS}s hold, ${perf.bestTrade.exitReason})`);
  }
  if (perf.worstTrade) {
    lines.push(`Worst: ${perf.worstTrade.tokenMint.substring(0, 8)}... ${perf.worstTrade.pnlSol.toFixed(4)} SOL (${perf.worstTrade.holdDurationS}s hold, ${perf.worstTrade.exitReason})`);
  }

  if (perf.holdDurations.length > 0) {
    lines.push(`Hold durations: ${perf.holdDurations.map(d => `${d.bucket}: ${d.count}`).join(' | ')}`);
  }

  lines.push('');
}

function appendPipelineSection(lines: string[], pipeline: PipelineSummary): void {
  lines.push('### Pipeline');
  lines.push(`Detected: ${pipeline.totalDetected} → Bought: ${pipeline.bought} (${(pipeline.buyRate * 100).toFixed(1)}% buy rate)`);
  if (pipeline.profitableOfBought > 0 || pipeline.bought > 0) {
    lines.push(`Of bought tokens: ${pipeline.profitableOfBought}/${pipeline.bought} profitable (${(pipeline.profitableRate * 100).toFixed(1)}%)`);
  }
  if (pipeline.topRejections.length > 0) {
    lines.push(`Top rejections: ${pipeline.topRejections.slice(0, 5).map(r => `${r.reason} (${r.count})`).join(', ')}`);
  }
  lines.push('');
}

function appendExitSection(lines: string[], exits: ExitAnalysis): void {
  if (exits.totalExits === 0) return;
  lines.push('### Exit Analysis');
  for (const r of exits.byReason) {
    const avgSign = r.avgPnlSol >= 0 ? '+' : '';
    lines.push(`${r.reason}: ${r.count} exits, avg P&L: ${avgSign}${r.avgPnlSol.toFixed(4)} SOL`);
  }
  lines.push('');
}

function appendEntryCorrelationSection(lines: string[], correlations: EntryCorrelation[]): void {
  if (correlations.length === 0) return;
  lines.push('### Entry Condition Correlations');
  for (const corr of correlations) {
    lines.push(`**${corr.metric}:**`);
    for (const b of corr.buckets) {
      lines.push(`  ${b.range}: ${b.trades} trades, ${(b.winRate * 100).toFixed(0)}% win rate, avg ${b.avgPnlSol >= 0 ? '+' : ''}${b.avgPnlSol.toFixed(4)} SOL`);
    }
  }
  lines.push('');
}

function appendTimeOfDaySection(lines: string[], tod: TimeOfDayBucket[]): void {
  const active = tod.filter(t => t.trades > 0);
  if (active.length === 0) return;
  lines.push('### Time of Day (UTC)');
  for (const t of active) {
    const pnlSign = t.pnlSol >= 0 ? '+' : '';
    lines.push(`${String(t.hourUtc).padStart(2, '0')}:00 — ${t.trades} trades, ${(t.winRate * 100).toFixed(0)}% win rate, ${pnlSign}${t.pnlSol.toFixed(4)} SOL`);
  }
  lines.push('');
}

// ════════════════════════════════════════════════════════════════════════════
// DATA BUILDERS
// ════════════════════════════════════════════════════════════════════════════

type PositionWithTrades = {
  position: PositionRecord;
  buyTrade: TradeRecord | null;
  sellTrade: TradeRecord | null;
  detection: PoolDetectionRecord | null;
};

function buildSessionSummary(journal: RunJournalRecord): SessionSummary {
  const endedAt = journal.endedAt ?? Date.now();
  return {
    sessionId: journal.sessionId,
    startedAt: journal.startedAt,
    endedAt: journal.endedAt,
    durationMinutes: Math.round((endedAt - journal.startedAt) / 60000),
    hypothesis: journal.hypothesis,
    botMode: journal.botMode,
    quoteAmountSol: journal.quoteAmountSol,
    takeProfitPct: journal.takeProfitPct,
    stopLossPct: journal.stopLossPct,
    maxHoldDurationS: journal.maxHoldDurationS,
    sniperGateEnabled: journal.sniperGateEnabled,
    trailingStopEnabled: journal.trailingStopEnabled,
    tags: journal.tags,
  };
}

function buildPerformance(positions: PositionWithTrades[]): PerformanceSummary {
  const completed = positions.filter(p => p.buyTrade && p.sellTrade);

  const trades: TradeDetail[] = completed.map(p => {
    const entrySol = p.buyTrade!.amountSol;
    const exitSol = p.sellTrade!.amountSol;
    const pnlSol = exitSol - entrySol;
    const pnlPercent = entrySol > 0 ? (pnlSol / entrySol) * 100 : 0;
    const holdDurationS = Math.round(
      ((p.position.closedTimestamp || p.sellTrade!.timestamp) - p.position.entryTimestamp) / 1000
    );
    return {
      tokenMint: p.position.tokenMint,
      pnlSol,
      pnlPercent,
      holdDurationS,
      exitReason: p.position.closedReason || 'unknown',
    };
  });

  const wins = trades.filter(t => t.pnlSol > 0);
  const losses = trades.filter(t => t.pnlSol <= 0);
  const totalPnlSol = trades.reduce((sum, t) => sum + t.pnlSol, 0);
  const avgWinSol = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlSol, 0) / wins.length : 0;
  const avgLossSol = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlSol, 0) / losses.length : 0;

  // Hold duration buckets
  const buckets: Record<string, number> = { '<10s': 0, '10-30s': 0, '30-60s': 0, '>60s': 0 };
  for (const t of trades) {
    if (t.holdDurationS < 10) buckets['<10s']++;
    else if (t.holdDurationS < 30) buckets['10-30s']++;
    else if (t.holdDurationS < 60) buckets['30-60s']++;
    else buckets['>60s']++;
  }

  const bestTrade = trades.length > 0
    ? trades.reduce((best, t) => t.pnlSol > best.pnlSol ? t : best)
    : null;
  const worstTrade = trades.length > 0
    ? trades.reduce((worst, t) => t.pnlSol < worst.pnlSol ? t : worst)
    : null;

  return {
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnlSol,
    avgWinSol,
    avgLossSol,
    expectancySol: trades.length > 0 ? totalPnlSol / trades.length : 0,
    bestTrade,
    worstTrade,
    holdDurations: Object.entries(buckets)
      .filter(([, count]) => count > 0)
      .map(([bucket, count]) => ({ bucket, count })),
  };
}

function buildPipelineSummary(
  store: NonNullable<ReturnType<typeof getStateStore>>,
  from: number,
  to: number,
  sessionPositions: PositionWithTrades[],
): PipelineSummary {
  const rangeStats = store.getPoolDetectionStatsForRange(from, to);

  // Count profitable trades among bought tokens
  const profitableTrades = sessionPositions.filter(p => {
    if (!p.buyTrade || !p.sellTrade) return false;
    return p.sellTrade.amountSol > p.buyTrade.amountSol;
  });

  const topRejections = Object.entries(rangeStats.topRejections)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  return {
    totalDetected: rangeStats.total,
    passedCheapGates: 0, // not stored in DB per-stage; shown as 0
    passedDeepFilters: 0,
    passedGate: 0,
    bought: rangeStats.bought,
    buyRate: rangeStats.total > 0 ? rangeStats.bought / rangeStats.total : 0,
    topRejections,
    profitableOfBought: profitableTrades.length,
    profitableRate: rangeStats.bought > 0 ? profitableTrades.length / rangeStats.bought : 0,
  };
}

function buildExitAnalysis(positions: PositionWithTrades[]): ExitAnalysis {
  const completed = positions.filter(p => p.position.closedReason);

  const byReason: Record<string, { count: number; totalPnl: number }> = {};
  for (const p of completed) {
    const reason = p.position.closedReason || 'unknown';
    if (!byReason[reason]) byReason[reason] = { count: 0, totalPnl: 0 };
    byReason[reason].count++;
    if (p.buyTrade && p.sellTrade) {
      byReason[reason].totalPnl += p.sellTrade.amountSol - p.buyTrade.amountSol;
    }
  }

  return {
    totalExits: completed.length,
    byReason: Object.entries(byReason)
      .sort((a, b) => b[1].count - a[1].count)
      .map(([reason, data]) => ({
        reason,
        count: data.count,
        avgPnlSol: data.count > 0 ? data.totalPnl / data.count : 0,
      })),
  };
}

function buildEntryCorrelations(
  store: NonNullable<ReturnType<typeof getStateStore>>,
  positions: PositionWithTrades[],
): EntryCorrelation[] {
  const correlations: EntryCorrelation[] = [];
  const completed = positions.filter(p => p.buyTrade && p.sellTrade);
  if (completed.length < 3) return correlations; // Need minimum data

  // Correlation: SOL in curve at detection
  const withReserve = completed.filter(p => p.detection?.poolQuoteReserve != null);
  if (withReserve.length >= 3) {
    const reserveBuckets = bucketize(
      withReserve,
      p => p.detection!.poolQuoteReserve!,
      [
        { label: '0-10 SOL', min: 0, max: 10 },
        { label: '10-30 SOL', min: 10, max: 30 },
        { label: '30-80 SOL', min: 30, max: 80 },
        { label: '80+ SOL', min: 80, max: Infinity },
      ],
      p => ({
        pnl: p.sellTrade!.amountSol - p.buyTrade!.amountSol,
        win: p.sellTrade!.amountSol > p.buyTrade!.amountSol,
      }),
    );
    if (reserveBuckets.some(b => b.trades > 0)) {
      correlations.push({ metric: 'SOL in curve at detection', buckets: reserveBuckets });
    }
  }

  // Correlation: Pipeline duration (from detection record timestamps)
  // We don't have direct pipeline duration in DB, but we can approximate from
  // detection → buy trade timestamp

  return correlations;
}

function bucketize(
  items: PositionWithTrades[],
  getValue: (p: PositionWithTrades) => number,
  ranges: { label: string; min: number; max: number }[],
  getResult: (p: PositionWithTrades) => { pnl: number; win: boolean },
): { range: string; trades: number; winRate: number; avgPnlSol: number }[] {
  return ranges.map(range => {
    const bucket = items.filter(p => {
      const v = getValue(p);
      return v >= range.min && v < range.max;
    });
    const results = bucket.map(getResult);
    const wins = results.filter(r => r.win).length;
    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);

    return {
      range: range.label,
      trades: bucket.length,
      winRate: bucket.length > 0 ? wins / bucket.length : 0,
      avgPnlSol: bucket.length > 0 ? totalPnl / bucket.length : 0,
    };
  });
}

function buildTimeOfDay(positions: PositionWithTrades[]): TimeOfDayBucket[] {
  const hours = Array.from({ length: 24 }, (_, i): TimeOfDayBucket => ({
    hourUtc: i,
    trades: 0,
    wins: 0,
    winRate: 0,
    pnlSol: 0,
  }));

  for (const p of positions) {
    if (!p.buyTrade || !p.sellTrade) continue;
    const hour = new Date(p.position.entryTimestamp).getUTCHours();
    const pnl = p.sellTrade.amountSol - p.buyTrade.amountSol;
    const isWin = pnl > 0;

    hours[hour].trades++;
    hours[hour].pnlSol += pnl;
    if (isWin) hours[hour].wins++;
  }

  for (const h of hours) {
    h.winRate = h.trades > 0 ? h.wins / h.trades : 0;
  }

  return hours;
}

function buildCrossRunComparison(
  store: NonNullable<ReturnType<typeof getStateStore>>,
): CrossRunEntry[] {
  const journals = store.getJournalEntries(10);

  return journals.map(j => ({
    sessionId: j.sessionId,
    hypothesis: j.hypothesis || '',
    startedAt: j.startedAt,
    trades: j.totalTrades,
    winRate: j.totalTrades > 0 ? j.totalWins / j.totalTrades : 0,
    pnlSol: j.realizedPnlSol,
    keyConfig: `TP=${j.takeProfitPct}% SL=${j.stopLossPct}% HOLD=${j.maxHoldDurationS}s`,
  }));
}

function buildMarketContext(
  store: NonNullable<ReturnType<typeof getStateStore>>,
  from: number,
  to: number,
  winRate?: number,
): MarketContextSummary | null {
  if (from === 0) return null;

  const stats = store.getPoolDetectionStatsForRange(from, to);
  if (stats.total === 0) return null;

  const topRejection = Object.entries(stats.topRejections)
    .sort((a, b) => b[1] - a[1])[0];

  const summary: MarketContextSummary = {
    tokensDetected: stats.total,
    tokensBought: stats.bought,
    tokensFiltered: stats.filtered,
    buyRatePct: stats.total > 0 ? (stats.bought / stats.total) * 100 : 0,
    topRejection: topRejection ? `${topRejection[0]} (${topRejection[1]})` : '',
    source: 'self',
  };

  // Enrich with market snapshot data (from DB — includes research bot data)
  const aggregated = getAggregatedMarketContext(from, to);
  if (aggregated) {
    if (aggregated.source === 'research_bot') {
      summary.source = 'research_bot';
      summary.tokensCreatedMarket = aggregated.tokensCreatedMarket;
      summary.tokensWith2x = aggregated.tokensWith2x;
      summary.hit2xRatePct = aggregated.hit2xRatePct;
      summary.avgPeakGainPct = aggregated.avgPeakGainPct;
      summary.medianPeakGainPct = aggregated.medianPeakGainPct;
      summary.avgBuyVelocity = aggregated.avgBuyVelocity;
      summary.avgSellRatio = aggregated.avgSellRatio;

      // Compare your win rate vs market 2x rate
      if (winRate !== undefined && summary.hit2xRatePct !== undefined) {
        summary.yourWinRateVsMarket =
          `${(winRate * 100).toFixed(1)}% win rate vs ${summary.hit2xRatePct.toFixed(1)}% market 2x rate`;
      }
    }
  }

  return summary;
}

function emptyReport(): AnalysisReport {
  return {
    generatedAt: Date.now(),
    session: null,
    performance: {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnlSol: 0,
      avgWinSol: 0, avgLossSol: 0, expectancySol: 0,
      bestTrade: null, worstTrade: null, holdDurations: [],
    },
    pipeline: {
      totalDetected: 0, passedCheapGates: 0, passedDeepFilters: 0,
      passedGate: 0, bought: 0, buyRate: 0, topRejections: [],
      profitableOfBought: 0, profitableRate: 0,
    },
    exitAnalysis: { totalExits: 0, byReason: [] },
    entryCorrelations: [],
    timeOfDay: [],
    crossRunComparison: [],
    marketContext: null,
  };
}
