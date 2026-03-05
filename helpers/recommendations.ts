/**
 * Recommendations Engine
 *
 * Rule-based analysis that examines trade history and produces
 * specific parameter change suggestions. Not AI — just pattern matching
 * on the accumulated data.
 *
 * @module helpers/recommendations
 */

import { AnalysisReport } from './ai-analysis';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface Recommendation {
  id: string;
  severity: 'info' | 'warning' | 'action';
  category: string;
  title: string;
  detail: string;
  suggestion?: string;
}

// Minimum trades needed before generating most recommendations
const MIN_TRADES = 3;

// ════════════════════════════════════════════════════════════════════════════
// ENGINE
// ════════════════════════════════════════════════════════════════════════════

/**
 * Generate recommendations from an analysis report
 */
export function generateRecommendations(report: AnalysisReport): Recommendation[] {
  const recs: Recommendation[] = [];
  const perf = report.performance;

  if (perf.totalTrades < MIN_TRADES) {
    recs.push({
      id: 'insufficient-data',
      severity: 'info',
      category: 'data',
      title: 'Insufficient data',
      detail: `Only ${perf.totalTrades} completed trades. Most recommendations require at least ${MIN_TRADES} trades.`,
      suggestion: 'Continue running the bot to accumulate more trade data.',
    });
    return recs;
  }

  // ── Take Profit analysis ──
  checkTakeProfit(report, recs);

  // ── Stop Loss analysis ──
  checkStopLoss(report, recs);

  // ── Max Hold Duration ──
  checkMaxHold(report, recs);

  // ── Win Rate ──
  checkWinRate(report, recs);

  // ── Pipeline efficiency ──
  checkPipeline(report, recs);

  // ── Time of day ──
  checkTimeOfDay(report, recs);

  // ── Cost analysis ──
  checkCosts(report, recs);

  return recs;
}

/**
 * Format recommendations as plain text for Claude
 */
export function formatRecommendations(recs: Recommendation[]): string {
  if (recs.length === 0) return '';

  const lines: string[] = ['### Computed Recommendations'];
  for (const rec of recs) {
    const icon = rec.severity === 'action' ? '[ACTION]' : rec.severity === 'warning' ? '[WARN]' : '[INFO]';
    lines.push(`${icon} **${rec.title}**`);
    lines.push(`  ${rec.detail}`);
    if (rec.suggestion) {
      lines.push(`  → ${rec.suggestion}`);
    }
  }
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// INDIVIDUAL CHECKS
// ════════════════════════════════════════════════════════════════════════════

function checkTakeProfit(report: AnalysisReport, recs: Recommendation[]): void {
  const exits = report.exitAnalysis;
  const tpExits = exits.byReason.find(r =>
    r.reason.includes('take_profit') || r.reason.includes('tp')
  );
  const totalExits = exits.totalExits;

  if (totalExits > 0 && !tpExits) {
    // TP never triggered
    recs.push({
      id: 'tp-never-hits',
      severity: 'warning',
      category: 'exit',
      title: 'Take profit never triggers',
      detail: `Out of ${totalExits} exits, take profit was never reached. Winners may be reversing before hitting TP.`,
      suggestion: report.session
        ? `Consider reducing TAKE_PROFIT from ${report.session.takeProfitPct}% to a lower value.`
        : 'Consider reducing TAKE_PROFIT.',
    });
  }
}

function checkStopLoss(report: AnalysisReport, recs: Recommendation[]): void {
  const exits = report.exitAnalysis;
  const slExits = exits.byReason.find(r =>
    r.reason.includes('stop_loss') || r.reason.includes('sl')
  );
  const totalExits = exits.totalExits;

  if (slExits && totalExits > 0) {
    const slRate = slExits.count / totalExits;
    if (slRate > 0.7) {
      recs.push({
        id: 'sl-too-tight',
        severity: 'action',
        category: 'exit',
        title: 'Stop loss triggers too often',
        detail: `${(slRate * 100).toFixed(0)}% of exits are stop losses (${slExits.count}/${totalExits}). SL may be too tight.`,
        suggestion: report.session
          ? `Consider widening STOP_LOSS from ${report.session.stopLossPct}% or reviewing entry timing.`
          : 'Consider widening STOP_LOSS.',
      });
    }
  }
}

function checkMaxHold(report: AnalysisReport, recs: Recommendation[]): void {
  const exits = report.exitAnalysis;
  const timeoutExits = exits.byReason.find(r =>
    r.reason.includes('max_hold') || r.reason.includes('timeout') || r.reason.includes('time_exit')
  );

  if (timeoutExits && timeoutExits.count >= 2) {
    if (timeoutExits.avgPnlSol > 0) {
      recs.push({
        id: 'max-hold-cutting-winners',
        severity: 'warning',
        category: 'exit',
        title: 'Max hold may be cutting winners short',
        detail: `${timeoutExits.count} timeout exits had avg P&L of +${timeoutExits.avgPnlSol.toFixed(4)} SOL. These were still profitable when forced to exit.`,
        suggestion: 'Consider increasing MAX_HOLD_DURATION_SECONDS to let winners run longer.',
      });
    } else if (timeoutExits.avgPnlSol < 0) {
      recs.push({
        id: 'max-hold-too-long',
        severity: 'info',
        category: 'exit',
        title: 'Timeout exits are losing money',
        detail: `${timeoutExits.count} timeout exits had avg P&L of ${timeoutExits.avgPnlSol.toFixed(4)} SOL. Holding to timeout means neither TP nor SL triggered.`,
        suggestion: 'Consider reducing MAX_HOLD_DURATION_SECONDS to cut losers faster.',
      });
    }
  }
}

function checkWinRate(report: AnalysisReport, recs: Recommendation[]): void {
  const perf = report.performance;

  if (perf.winRate < 0.3 && perf.totalTrades >= 5) {
    recs.push({
      id: 'low-win-rate',
      severity: 'action',
      category: 'strategy',
      title: 'Very low win rate',
      detail: `Win rate is ${(perf.winRate * 100).toFixed(1)}% (${perf.wins}/${perf.totalTrades}). This is unsustainable unless avg win >> avg loss.`,
      suggestion: 'Focus on improving entry quality: tighter filters, higher organic buyer thresholds, or adding a time-of-day filter.',
    });
  }

  if (perf.expectancySol < 0 && perf.totalTrades >= 5) {
    recs.push({
      id: 'negative-expectancy',
      severity: 'action',
      category: 'strategy',
      title: 'Negative expectancy',
      detail: `Expected value per trade is ${perf.expectancySol.toFixed(4)} SOL. Each trade loses money on average.`,
      suggestion: 'Review both entry criteria and exit parameters. The current configuration is losing money systematically.',
    });
  }
}

function checkPipeline(report: AnalysisReport, recs: Recommendation[]): void {
  const pipeline = report.pipeline;

  if (pipeline.totalDetected > 0 && pipeline.buyRate < 0.01) {
    recs.push({
      id: 'pipeline-too-restrictive',
      severity: 'warning',
      category: 'pipeline',
      title: 'Pipeline may be too restrictive',
      detail: `Only ${(pipeline.buyRate * 100).toFixed(2)}% of detected tokens pass the pipeline (${pipeline.bought}/${pipeline.totalDetected}).`,
      suggestion: pipeline.topRejections.length > 0
        ? `Top rejection: "${pipeline.topRejections[0].reason}" (${pipeline.topRejections[0].count} times). Consider relaxing this filter.`
        : 'Review filter thresholds.',
    });
  }

  if (pipeline.bought >= 3 && pipeline.profitableRate < 0.2) {
    recs.push({
      id: 'pipeline-low-quality',
      severity: 'warning',
      category: 'pipeline',
      title: 'Pipeline passes low-quality tokens',
      detail: `Only ${(pipeline.profitableRate * 100).toFixed(0)}% of bought tokens were profitable (${pipeline.profitableOfBought}/${pipeline.bought}).`,
      suggestion: 'Add stricter entry criteria or gate conditions to filter out losing tokens before buying.',
    });
  }
}

function checkTimeOfDay(report: AnalysisReport, recs: Recommendation[]): void {
  const active = report.timeOfDay.filter(t => t.trades >= 2);
  if (active.length < 2) return;

  const profitable = active.filter(t => t.pnlSol > 0);
  const unprofitable = active.filter(t => t.pnlSol < 0);

  if (profitable.length > 0 && unprofitable.length > 0) {
    const profHours = profitable.map(t => `${t.hourUtc}:00`).join(', ');
    const unprofHours = unprofitable.map(t => `${t.hourUtc}:00`).join(', ');

    recs.push({
      id: 'time-of-day-pattern',
      severity: 'info',
      category: 'timing',
      title: 'Time-of-day pattern detected',
      detail: `Profitable hours (UTC): ${profHours}. Unprofitable hours: ${unprofHours}.`,
      suggestion: 'Consider restricting trading to profitable hours via a time-of-day filter.',
    });
  }
}

function checkCosts(report: AnalysisReport, recs: Recommendation[]): void {
  const perf = report.performance;

  // If average loss is very small (close to tx costs), fees are eating P&L
  if (perf.totalTrades >= 3 && perf.avgLossSol !== 0 && Math.abs(perf.avgLossSol) < 0.003) {
    recs.push({
      id: 'fee-impact',
      severity: 'info',
      category: 'costs',
      title: 'Transaction costs may be significant',
      detail: `Average loss is ${perf.avgLossSol.toFixed(4)} SOL, which is close to typical transaction fees (~0.002 SOL).`,
      suggestion: 'Consider increasing QUOTE_AMOUNT to make fees a smaller percentage of each trade.',
    });
  }
}
