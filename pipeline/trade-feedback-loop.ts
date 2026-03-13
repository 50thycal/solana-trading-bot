/**
 * Trade Feedback Loop
 *
 * After a smoke test completes a full buy+sell cycle, sends trade performance
 * data back to the research bot so it can learn which scores/features predict
 * profitable trades.
 *
 * Design:
 * - Captures research score snapshot at buy time (stored on smoke test state)
 * - Collects trade outcome after sell completes
 * - POSTs to research bot's /api/feedback/trade endpoint
 * - Non-fatal: errors never affect the smoke test result
 * - Research bot owns the analysis; we just send raw data
 */

import { logger } from '../helpers';
import { TokenFeatureVector, ResearchScoreGateData } from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete trade outcome report sent to the research bot.
 */
export interface TradeOutcomeReport {
  // Token identification
  tokenMint: string;
  tokenSymbol: string;

  // Research score snapshot (captured at buy time)
  researchScore: {
    score: number;
    signal: string;
    features: TokenFeatureVector;
    featureScores: Array<{ name: string; score: number; raw: number }>;
    scoreThreshold: number;
    modelSampleCount: number;
  };

  // Trade outcome
  trade: {
    entryAmountSol: number;
    exitAmountSol: number;
    pnlSol: number;
    pnlPercent: number;
    holdDurationMs: number;
    exitTrigger: string;
    buyTimestamp: number;
    sellTimestamp: number;
  };

  // Execution quality
  execution: {
    buySlippagePercent?: number;
    sellSlippagePercent?: number;
    buyOverheadSol?: number;
    highWaterMarkPercent?: number;
  };

  // Environment
  environment: {
    botMode: string;
    timestamp: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTER
// ═══════════════════════════════════════════════════════════════════════════════

export class TradeFeedbackReporter {
  private researchBotUrl: string;
  private lastReport: TradeOutcomeReport | null = null;

  constructor(researchBotUrl: string) {
    this.researchBotUrl = researchBotUrl;
  }

  /**
   * Build a TradeOutcomeReport from smoke test state.
   */
  buildReport(params: {
    tokenMint: string;
    tokenSymbol: string;
    researchScoreData: ResearchScoreGateData;
    entryAmountSol: number;
    exitAmountSol: number;
    buyTimestamp: number;
    sellTimestamp: number;
    exitTrigger: string;
    buySlippagePercent?: number;
    sellSlippagePercent?: number;
    buyOverheadSol?: number;
    highWaterMarkPercent?: number;
  }): TradeOutcomeReport {
    const pnlSol = params.exitAmountSol - params.entryAmountSol;
    const pnlPercent = params.entryAmountSol > 0
      ? (pnlSol / params.entryAmountSol) * 100
      : 0;

    return {
      tokenMint: params.tokenMint,
      tokenSymbol: params.tokenSymbol,
      researchScore: {
        score: params.researchScoreData.score,
        signal: params.researchScoreData.signal,
        features: params.researchScoreData.features,
        featureScores: params.researchScoreData.featureScores,
        scoreThreshold: params.researchScoreData.scoreThreshold,
        modelSampleCount: params.researchScoreData.modelSampleCount,
      },
      trade: {
        entryAmountSol: params.entryAmountSol,
        exitAmountSol: params.exitAmountSol,
        pnlSol,
        pnlPercent,
        holdDurationMs: params.sellTimestamp - params.buyTimestamp,
        exitTrigger: params.exitTrigger,
        buyTimestamp: params.buyTimestamp,
        sellTimestamp: params.sellTimestamp,
      },
      execution: {
        buySlippagePercent: params.buySlippagePercent,
        sellSlippagePercent: params.sellSlippagePercent,
        buyOverheadSol: params.buyOverheadSol,
        highWaterMarkPercent: params.highWaterMarkPercent,
      },
      environment: {
        botMode: 'smoke',
        timestamp: Date.now(),
      },
    };
  }

  /**
   * Send feedback to the research bot. Non-fatal on error.
   */
  async sendFeedback(report: TradeOutcomeReport): Promise<boolean> {
    this.lastReport = report;

    // Always log locally
    logger.info(
      {
        tokenMint: report.tokenMint,
        tokenSymbol: report.tokenSymbol,
        score: report.researchScore.score,
        signal: report.researchScore.signal,
        pnlSol: report.trade.pnlSol.toFixed(6),
        pnlPercent: report.trade.pnlPercent.toFixed(2),
        holdDurationMs: report.trade.holdDurationMs,
        exitTrigger: report.trade.exitTrigger,
      },
      '[feedback] Trade outcome report',
    );

    if (!this.researchBotUrl) {
      logger.warn('[feedback] No RESEARCH_BOT_URL configured — skipping POST');
      return false;
    }

    const url = `${this.researchBotUrl}/api/feedback/trade`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        logger.info({ url, status: response.status }, '[feedback] Report sent to research bot');
        return true;
      } else {
        logger.warn(
          { url, status: response.status, statusText: response.statusText },
          '[feedback] Research bot returned non-OK status',
        );
        return false;
      }
    } catch (error) {
      logger.warn(
        { url, error: error instanceof Error ? error.message : String(error) },
        '[feedback] Failed to send report to research bot (non-fatal)',
      );
      return false;
    }
  }

  /**
   * Get the last report (for dashboard).
   */
  getLastReport(): TradeOutcomeReport | null {
    return this.lastReport;
  }
}
