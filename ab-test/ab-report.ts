/**
 * A/B Test Report Generator
 *
 * Generates side-by-side comparison reports from ABTestStore data.
 * Primary metric: realized PNL in SOL.
 */

import { ABTestStore } from './ab-store';
import {
  ABTestReport,
  ABVariantSummary,
  ABVariantConfig,
  ABTradeResult,
  ABPipelineDecision,
} from './types';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// REPORT GENERATOR
// ═══════════════════════════════════════════════════════════════════════════════

export class ABReportGenerator {
  constructor(private store: ABTestStore) {}

  /**
   * Generate a full comparison report for a session.
   */
  generate(sessionId: string): ABTestReport {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const tradesA = this.store.getSessionTrades(sessionId, 'A');
    const tradesB = this.store.getSessionTrades(sessionId, 'B');
    const decisionsA = this.store.getPipelineDecisions(sessionId, 'A');
    const decisionsB = this.store.getPipelineDecisions(sessionId, 'B');

    const summaryA = this.buildVariantSummary('A', session.configA, tradesA, decisionsA);
    const summaryB = this.buildVariantSummary('B', session.configB, tradesB, decisionsB);

    const winner =
      summaryA.realizedPnlSol > summaryB.realizedPnlSol ? 'A' :
      summaryB.realizedPnlSol > summaryA.realizedPnlSol ? 'B' : 'tie';

    return {
      sessionId,
      config: {
        sessionId,
        durationMs: session.durationMs,
        variantA: session.configA,
        variantB: session.configB,
        startedAt: session.startedAt,
        description: session.description,
      },
      startedAt: session.startedAt,
      completedAt: session.completedAt || Date.now(),
      durationMs: (session.completedAt || Date.now()) - session.startedAt,
      totalTokensDetected: session.totalTokensDetected,
      variantA: summaryA,
      variantB: summaryB,
      winner,
      pnlDifferenceSol: Math.abs(summaryA.realizedPnlSol - summaryB.realizedPnlSol),
    };
  }

  /**
   * Print the report to the console in a formatted table.
   */
  printReport(report: ABTestReport): void {
    const durationMin = (report.durationMs / 60000).toFixed(0);
    const durationHrs = (report.durationMs / 3600000).toFixed(1);

    const lines: string[] = [];
    const W = 68;

    lines.push('');
    lines.push('='.repeat(W));
    lines.push(`  A/B TEST REPORT -- Session: ${report.sessionId}`);
    lines.push('='.repeat(W));
    lines.push(`  Duration:       ${durationHrs}h (${durationMin}m)`);
    lines.push(`  Tokens Seen:    ${report.totalTokensDetected}`);
    lines.push('');

    // Config comparison
    lines.push(this.tableRow('Metric', 'Config A', 'Config B', true));
    lines.push('-'.repeat(W));

    const cA = report.variantA.config;
    const cB = report.variantB.config;
    lines.push(this.tableRow('Take Profit', `${cA.takeProfit}%`, `${cB.takeProfit}%`));
    lines.push(this.tableRow('Stop Loss', `${cA.stopLoss}%`, `${cB.stopLoss}%`));
    lines.push(this.tableRow('Max Hold Duration', `${(cA.maxHoldDurationMs / 60000).toFixed(4)} min`, `${(cB.maxHoldDurationMs / 60000).toFixed(4)} min`));
    lines.push(this.tableRow('Price Check Interval', `${(cA.priceCheckIntervalMs / 60000).toFixed(4)} min`, `${(cB.priceCheckIntervalMs / 60000).toFixed(4)} min`));
    lines.push(this.tableRow('Min Buys (Momentum)', String(cA.momentumMinTotalBuys), String(cB.momentumMinTotalBuys)));
    lines.push(this.tableRow('Min SOL in Curve', String(cA.pumpfunMinSolInCurve), String(cB.pumpfunMinSolInCurve)));
    lines.push(this.tableRow('Max SOL in Curve', String(cA.pumpfunMaxSolInCurve), String(cB.pumpfunMaxSolInCurve)));
    lines.push(this.tableRow('Max Token Age', `${cA.maxTokenAgeSeconds}s`, `${cB.maxTokenAgeSeconds}s`));
    lines.push(this.tableRow('Mom. Initial Delay', `${(cA.momentumInitialDelayMs / 60000).toFixed(4)} min`, `${(cB.momentumInitialDelayMs / 60000).toFixed(4)} min`));
    lines.push(this.tableRow('Mom. Recheck Interval', `${(cA.momentumRecheckIntervalMs / 60000).toFixed(4)} min`, `${(cB.momentumRecheckIntervalMs / 60000).toFixed(4)} min`));
    lines.push(this.tableRow('Mom. Max Checks', String(cA.momentumMaxChecks), String(cB.momentumMaxChecks)));
    lines.push(this.tableRow('Buy Slippage', `${cA.buySlippage}%`, `${cB.buySlippage}%`));
    lines.push(this.tableRow('Sell Slippage', `${cA.sellSlippage}%`, `${cB.sellSlippage}%`));
    lines.push(this.tableRow('Quote Amount', `${cA.quoteAmount} SOL`, `${cB.quoteAmount} SOL`));
    lines.push(this.tableRow('Max Trades/Hour', String(cA.maxTradesPerHour), String(cB.maxTradesPerHour)));
    lines.push('-'.repeat(W));

    // Results comparison
    const sA = report.variantA;
    const sB = report.variantB;
    lines.push(this.tableRow('Pipeline Passed', String(sA.totalPipelinePassed), String(sB.totalPipelinePassed)));
    lines.push(this.tableRow('Pipeline Rejected', String(sA.totalPipelineRejected), String(sB.totalPipelineRejected)));

    // Rejection breakdown by stage
    const allStages = new Set([...Object.keys(sA.rejectionBreakdown), ...Object.keys(sB.rejectionBreakdown)]);
    if (allStages.size > 0) {
      for (const stage of allStages) {
        const countA = sA.rejectionBreakdown[stage] || 0;
        const countB = sB.rejectionBreakdown[stage] || 0;
        lines.push(this.tableRow(`  Rej: ${stage}`, String(countA), String(countB)));
      }
    }

    lines.push(this.tableRow('Trades Entered', String(sA.totalTradesEntered), String(sB.totalTradesEntered)));
    lines.push(this.tableRow('Trades Closed', String(sA.totalTradesClosed), String(sB.totalTradesClosed)));
    lines.push(this.tableRow('Trades Active', String(sA.totalTradesActive), String(sB.totalTradesActive)));
    lines.push(this.tableRow('Win Rate', `${sA.winRate.toFixed(1)}%`, `${sB.winRate.toFixed(1)}%`));
    lines.push(this.tableRow('Avg Hold Time', `${(sA.avgHoldDurationMs / 1000).toFixed(1)}s`, `${(sB.avgHoldDurationMs / 1000).toFixed(1)}s`));
    lines.push('-'.repeat(W));

    // P&L
    lines.push(this.tableRow('Total SOL Deployed', sA.totalSolDeployed.toFixed(4), sB.totalSolDeployed.toFixed(4)));
    lines.push(this.tableRow('Total SOL Returned', sA.totalSolReturned.toFixed(4), sB.totalSolReturned.toFixed(4)));
    lines.push(this.tableRow('Realized PnL (SOL)', this.colorPnl(sA.realizedPnlSol), this.colorPnl(sB.realizedPnlSol)));
    lines.push(this.tableRow('Realized PnL (%)', this.colorPnlPct(sA.realizedPnlPercent), this.colorPnlPct(sB.realizedPnlPercent)));
    lines.push('-'.repeat(W));

    // Win/Loss breakdown
    lines.push(this.tableRow('Wins', String(sA.winCount), String(sB.winCount)));
    lines.push(this.tableRow('Losses', String(sA.lossCount), String(sB.lossCount)));
    lines.push(this.tableRow('Avg Win PnL', `${sA.avgWinPnlPercent.toFixed(1)}%`, `${sB.avgWinPnlPercent.toFixed(1)}%`));
    lines.push(this.tableRow('Avg Loss PnL', `${sA.avgLossPnlPercent.toFixed(1)}%`, `${sB.avgLossPnlPercent.toFixed(1)}%`));
    lines.push(this.tableRow('Best Trade', `${sA.bestTradePnlPercent.toFixed(1)}%`, `${sB.bestTradePnlPercent.toFixed(1)}%`));
    lines.push(this.tableRow('Worst Trade', `${sA.worstTradePnlPercent.toFixed(1)}%`, `${sB.worstTradePnlPercent.toFixed(1)}%`));
    lines.push('-'.repeat(W));

    // Exit breakdown
    lines.push(this.tableRow('Exit: Take Profit', String(sA.takeProfitCount), String(sB.takeProfitCount)));
    lines.push(this.tableRow('Exit: Stop Loss', String(sA.stopLossCount), String(sB.stopLossCount)));
    lines.push(this.tableRow('Exit: Time Exit', String(sA.timeExitCount), String(sB.timeExitCount)));
    lines.push(this.tableRow('Exit: Graduated', String(sA.graduatedCount), String(sB.graduatedCount)));
    lines.push('='.repeat(W));

    // Winner
    if (report.winner === 'tie') {
      lines.push(`  RESULT: TIE (both variants equal PnL)`);
    } else {
      const winnerSummary = report.winner === 'A' ? sA : sB;
      const loserSummary = report.winner === 'A' ? sB : sA;
      lines.push(`  WINNER: Config ${report.winner} (PnL: ${winnerSummary.realizedPnlSol.toFixed(4)} SOL vs ${loserSummary.realizedPnlSol.toFixed(4)} SOL)`);
      lines.push(`  PnL Difference: ${report.pnlDifferenceSol.toFixed(4)} SOL`);
    }

    lines.push('='.repeat(W));
    lines.push('');

    // Print all at once
    logger.info(lines.join('\n'), '[ab-report] A/B Test Results');
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private buildVariantSummary(
    variant: 'A' | 'B',
    config: ABVariantConfig,
    trades: ABTradeResult[],
    decisions: ABPipelineDecision[],
  ): ABVariantSummary {
    const closedTrades = trades.filter(t => t.status === 'closed');
    const activeTrades = trades.filter(t => t.status === 'active');
    const passedDecisions = decisions.filter(d => d.passed);
    const rejectedDecisions = decisions.filter(d => !d.passed);

    // Build rejection breakdown by stage
    const rejectionBreakdown: Record<string, number> = {};
    for (const d of rejectedDecisions) {
      const stage = d.rejectionStage || 'unknown';
      rejectionBreakdown[stage] = (rejectionBreakdown[stage] || 0) + 1;
    }

    // P&L
    const totalSolDeployed = closedTrades.reduce((sum, t) => sum + t.hypotheticalSolSpent, 0);
    const totalSolReturned = closedTrades.reduce((sum, t) => sum + (t.exitSolReceived || 0), 0);
    const realizedPnlSol = totalSolReturned - totalSolDeployed;
    const realizedPnlPercent = totalSolDeployed > 0 ? (realizedPnlSol / totalSolDeployed) * 100 : 0;

    // Win/Loss
    const wins = closedTrades.filter(t => (t.realizedPnlSol || 0) > 0);
    const losses = closedTrades.filter(t => (t.realizedPnlSol || 0) <= 0);
    const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;

    const avgWinPnl = wins.length > 0
      ? wins.reduce((sum, t) => sum + (t.realizedPnlPercent || 0), 0) / wins.length : 0;
    const avgLossPnl = losses.length > 0
      ? losses.reduce((sum, t) => sum + (t.realizedPnlPercent || 0), 0) / losses.length : 0;

    const allPnlPercents = closedTrades.map(t => t.realizedPnlPercent || 0);
    const bestTrade = allPnlPercents.length > 0 ? Math.max(...allPnlPercents) : 0;
    const worstTrade = allPnlPercents.length > 0 ? Math.min(...allPnlPercents) : 0;

    // Hold duration
    const holdDurations = closedTrades
      .filter(t => t.holdDurationMs !== undefined)
      .map(t => t.holdDurationMs!);
    const avgHoldDuration = holdDurations.length > 0
      ? holdDurations.reduce((a, b) => a + b, 0) / holdDurations.length : 0;

    // Exit breakdown
    const takeProfitCount = closedTrades.filter(t => t.exitReason === 'take_profit').length;
    const stopLossCount = closedTrades.filter(t => t.exitReason === 'stop_loss').length;
    const timeExitCount = closedTrades.filter(t => t.exitReason === 'time_exit').length;
    const graduatedCount = closedTrades.filter(t => t.exitReason === 'graduated').length;

    return {
      variant,
      config,
      totalTokensSeen: decisions.length,
      totalPipelinePassed: passedDecisions.length,
      totalPipelineRejected: rejectedDecisions.length,
      rejectionBreakdown,
      totalTradesEntered: trades.length,
      totalTradesClosed: closedTrades.length,
      totalTradesActive: activeTrades.length,
      totalSolDeployed,
      totalSolReturned,
      realizedPnlSol,
      realizedPnlPercent,
      winCount: wins.length,
      lossCount: losses.length,
      winRate,
      avgWinPnlPercent: avgWinPnl,
      avgLossPnlPercent: avgLossPnl,
      bestTradePnlPercent: bestTrade,
      worstTradePnlPercent: worstTrade,
      avgHoldDurationMs: avgHoldDuration,
      takeProfitCount,
      stopLossCount,
      timeExitCount,
      graduatedCount,
    };
  }

  private tableRow(label: string, a: string, b: string, _isHeader = false): string {
    const labelWidth = 28;
    const colWidth = 18;
    const l = (label + ' '.repeat(labelWidth)).slice(0, labelWidth);
    const av = (' '.repeat(colWidth) + a).slice(-colWidth);
    const bv = (' '.repeat(colWidth) + b).slice(-colWidth);
    return `  ${l} ${av}  ${bv}`;
  }

  private colorPnl(value: number): string {
    const str = value.toFixed(4);
    return value >= 0 ? `+${str}` : str;
  }

  private colorPnlPct(value: number): string {
    const str = value.toFixed(1) + '%';
    return value >= 0 ? `+${str}` : str;
  }
}
