/**
 * A/B Test Analyzer - Cross-Session Analysis
 *
 * Aggregates results across multiple completed A/B test sessions to:
 * - Rank which parameters have the most impact on PnL
 * - Identify best-performing values for each parameter
 * - Generate a "best known config" recommendation
 * - Suggest what to test next
 */

import { ABTestStore } from './ab-store';
import { ABVariantConfig } from './types';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** All numeric params on ABVariantConfig that can be compared */
const TUNABLE_PARAMS: (keyof ABVariantConfig)[] = [
  'takeProfit',
  'stopLoss',
  'maxHoldDurationMs',
  'priceCheckIntervalMs',
  'momentumMinTotalBuys',
  'pumpfunMinSolInCurve',
  'pumpfunMaxSolInCurve',
  'maxTokenAgeSeconds',
  'momentumInitialDelayMs',
  'momentumRecheckIntervalMs',
  'momentumMaxChecks',
  'buySlippage',
  'sellSlippage',
  'maxTradesPerHour',
  'quoteAmount',
];

export interface ParameterImpact {
  paramName: string;
  /** How many sessions tested this parameter (values differed between A and B) */
  sessionsTested: number;
  /** How many times the higher value won */
  higherWins: number;
  /** How many times the lower value won */
  lowerWins: number;
  /** Average absolute PnL difference when this param was tested */
  avgPnlImpact: number;
  /** Maximum PnL difference observed */
  maxPnlImpact: number;
  /** The value that won most often */
  bestValue: number | null;
  /** Win rate for the best value */
  bestValueWinRate: number;
  /** All tested value pairs with outcomes */
  history: Array<{
    sessionId: string;
    valueA: number;
    valueB: number;
    winner: string;
    winnerValue: number;
    pnlDifference: number;
    startedAt: number;
  }>;
}

export interface BestConfig {
  /** Recommended value for each param, based on winning history */
  params: Record<string, { value: number; confidence: string; sessionsTested: number }>;
  /** Overall confidence level */
  overallConfidence: string;
  /** Total sessions analyzed */
  totalSessions: number;
}

export interface TestSuggestion {
  paramName: string;
  reason: string;
  suggestedValueA: number;
  suggestedValueB: number;
  priority: 'high' | 'medium' | 'low';
}

export interface CrossSessionAnalysis {
  totalSessions: number;
  completedSessions: number;
  parameterImpacts: ParameterImpact[];
  bestConfig: BestConfig;
  testSuggestions: TestSuggestion[];
  sessions: Array<{
    sessionId: string;
    description?: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    totalTokensDetected: number;
    pnlA: number;
    pnlB: number;
    winner: string;
    paramsTested: string[];
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYZER
// ═══════════════════════════════════════════════════════════════════════════════

export class ABAnalyzer {
  constructor(private store: ABTestStore) {}

  /**
   * Compute parameter diffs for a session and save them.
   * Called automatically after each AB test completes.
   */
  computeAndSaveParameterDiffs(
    sessionId: string,
    configA: ABVariantConfig,
    configB: ABVariantConfig,
    pnlA: number,
    pnlB: number,
  ): void {
    const diffs: Array<{
      paramName: string;
      valueA: number;
      valueB: number;
      winner: 'A' | 'B' | 'tie';
      winnerValue: number;
      pnlA: number;
      pnlB: number;
      pnlDifference: number;
    }> = [];

    for (const param of TUNABLE_PARAMS) {
      const valA = configA[param] as number;
      const valB = configB[param] as number;

      if (valA !== valB) {
        const winner: 'A' | 'B' | 'tie' = pnlA > pnlB ? 'A' : pnlB > pnlA ? 'B' : 'tie';
        const winnerValue = winner === 'A' ? valA : winner === 'B' ? valB : valA;

        diffs.push({
          paramName: param,
          valueA: valA,
          valueB: valB,
          winner,
          winnerValue,
          pnlA,
          pnlB,
          pnlDifference: Math.abs(pnlA - pnlB),
        });
      }
    }

    if (diffs.length > 0) {
      this.store.saveParameterDiffs(sessionId, diffs);
      logger.info(
        { sessionId, paramsTested: diffs.map(d => d.paramName) },
        '[ab-analyzer] Saved parameter diffs'
      );
    }
  }

  /**
   * Generate the full cross-session analysis.
   */
  analyze(): CrossSessionAnalysis {
    const sessions = this.store.getCompletedSessionsWithPnl();
    const testedParams = this.store.getTestedParameters();

    // Build parameter impacts
    const parameterImpacts: ParameterImpact[] = [];

    for (const paramName of testedParams) {
      const history = this.store.getParameterHistory(paramName);
      if (history.length === 0) continue;

      let higherWins = 0;
      let lowerWins = 0;
      let totalPnlImpact = 0;
      let maxPnlImpact = 0;

      // Track which values win
      const valueWins = new Map<number, number>();

      for (const h of history) {
        const pnlDiff = Math.abs(h.pnlDifference);
        totalPnlImpact += pnlDiff;
        maxPnlImpact = Math.max(maxPnlImpact, pnlDiff);

        if (h.winner !== 'tie') {
          const winnerVal = h.winnerValue;
          const loserVal = h.winner === 'A' ? h.valueB : h.valueA;

          valueWins.set(winnerVal, (valueWins.get(winnerVal) || 0) + 1);

          if (winnerVal > loserVal) {
            higherWins++;
          } else {
            lowerWins++;
          }
        }
      }

      // Find the value that won most
      let bestValue: number | null = null;
      let bestValueWins = 0;
      for (const [val, wins] of valueWins) {
        if (wins > bestValueWins) {
          bestValue = val;
          bestValueWins = wins;
        }
      }

      const nonTieCount = history.filter(h => h.winner !== 'tie').length;
      const bestValueWinRate = nonTieCount > 0 ? (bestValueWins / nonTieCount) * 100 : 0;

      parameterImpacts.push({
        paramName,
        sessionsTested: history.length,
        higherWins,
        lowerWins,
        avgPnlImpact: history.length > 0 ? totalPnlImpact / history.length : 0,
        maxPnlImpact,
        bestValue,
        bestValueWinRate,
        history,
      });
    }

    // Sort by average PnL impact (most impactful first)
    parameterImpacts.sort((a, b) => b.avgPnlImpact - a.avgPnlImpact);

    // Build best config recommendation
    const bestConfig = this.buildBestConfig(parameterImpacts, sessions.length);

    // Build test suggestions
    const testSuggestions = this.buildTestSuggestions(parameterImpacts, testedParams);

    // Build session list with params tested
    const sessionList = sessions.map(s => {
      const diffs = this.store.getParameterDiffs(s.sessionId);
      return {
        sessionId: s.sessionId,
        description: s.description,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        durationMs: s.durationMs,
        totalTokensDetected: s.totalTokensDetected,
        pnlA: s.pnlA,
        pnlB: s.pnlB,
        winner: s.winner,
        paramsTested: diffs.map(d => d.paramName),
      };
    });

    return {
      totalSessions: sessions.length,
      completedSessions: sessions.length,
      parameterImpacts,
      bestConfig,
      testSuggestions,
      sessions: sessionList,
    };
  }

  private buildBestConfig(impacts: ParameterImpact[], totalSessions: number): BestConfig {
    const params: Record<string, { value: number; confidence: string; sessionsTested: number }> = {};

    for (const impact of impacts) {
      if (impact.bestValue === null) continue;

      let confidence: string;
      if (impact.sessionsTested >= 5 && impact.bestValueWinRate >= 70) {
        confidence = 'high';
      } else if (impact.sessionsTested >= 3 && impact.bestValueWinRate >= 60) {
        confidence = 'medium';
      } else {
        confidence = 'low';
      }

      params[impact.paramName] = {
        value: impact.bestValue,
        confidence,
        sessionsTested: impact.sessionsTested,
      };
    }

    let overallConfidence: string;
    const confidenceValues: string[] = [];
    for (const key of Object.keys(params)) {
      confidenceValues.push(params[key].confidence);
    }
    const highCount = confidenceValues.filter((c: string) => c === 'high').length;

    if (totalSessions < 3) {
      overallConfidence = 'insufficient_data';
    } else if (highCount >= confidenceValues.length * 0.5) {
      overallConfidence = 'high';
    } else if (totalSessions >= 5) {
      overallConfidence = 'medium';
    } else {
      overallConfidence = 'low';
    }

    return {
      params,
      overallConfidence,
      totalSessions,
    };
  }

  private buildTestSuggestions(
    impacts: ParameterImpact[],
    testedParams: string[],
  ): TestSuggestion[] {
    const suggestions: TestSuggestion[] = [];
    const testedSet = new Set(testedParams);

    // Default values for reference
    const defaults: Record<string, number> = {
      takeProfit: 40,
      stopLoss: 20,
      maxHoldDurationMs: 20000,
      priceCheckIntervalMs: 2000,
      momentumMinTotalBuys: 10,
      pumpfunMinSolInCurve: 3,
      pumpfunMaxSolInCurve: 70,
      maxTokenAgeSeconds: 30,
      momentumInitialDelayMs: 3000,
      momentumRecheckIntervalMs: 2000,
      momentumMaxChecks: 3,
      buySlippage: 20,
      sellSlippage: 20,
      maxTradesPerHour: 10,
      quoteAmount: 0.01,
    };

    // Suggest untested parameters
    for (const param of TUNABLE_PARAMS) {
      if (!testedSet.has(param)) {
        const defaultVal = defaults[param] || 0;
        const lowVal = defaultVal * 0.5;
        const highVal = defaultVal * 1.5;

        suggestions.push({
          paramName: param,
          reason: 'Never tested - unknown impact',
          suggestedValueA: Math.round(lowVal * 100) / 100,
          suggestedValueB: Math.round(highVal * 100) / 100,
          priority: 'medium',
        });
      }
    }

    // Suggest refinement for params with few tests
    for (const impact of impacts) {
      if (impact.sessionsTested < 3 && impact.bestValue !== null) {
        const variation = impact.bestValue * 0.15;
        suggestions.push({
          paramName: impact.paramName,
          reason: `Only ${impact.sessionsTested} test(s) - needs more data to confirm`,
          suggestedValueA: Math.round((impact.bestValue - variation) * 100) / 100,
          suggestedValueB: Math.round((impact.bestValue + variation) * 100) / 100,
          priority: 'high',
        });
      }
    }

    // Sort by priority
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return suggestions;
  }
}
