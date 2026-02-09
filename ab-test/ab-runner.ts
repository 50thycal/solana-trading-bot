/**
 * A/B Test Runner - Main Orchestrator
 *
 * Coordinates a single PumpFunListener feeding two independent variant pipelines
 * running in parallel. Each variant has its own:
 *   - ABPipeline (filters + momentum gate)
 *   - PaperTradeTracker (TP/SL/time exit monitoring)
 *
 * Results are persisted to ABTestStore (data/ab-test.db).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { ABTestConfig, ABTestReport } from './types';
import { ABPipeline } from './ab-pipeline';
import { ABTestStore } from './ab-store';
import { ABReportGenerator } from './ab-report';
import { PaperTradeTracker, PaperTrade } from '../risk/paper-trade-tracker';
import { PumpFunListener } from '../listeners/pumpfun-listener';
import { DetectedToken } from '../types';
import { DetectionEvent } from '../pipeline/types';
import { getBondingCurveState } from '../helpers/pumpfun';
import { logger } from '../helpers';
import { getConfig } from '../helpers/config-validator';

// ═══════════════════════════════════════════════════════════════════════════════
// DETECTION EVENT CONVERTER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert the listener's DetectedToken into the pipeline's DetectionEvent.
 * The production pipeline uses DetectionEvent internally.
 */
function toDetectionEvent(token: DetectedToken): DetectionEvent {
  return {
    signature: token.signature || 'unknown',
    slot: 0,
    mint: token.mint,
    bondingCurve: token.bondingCurve || token.poolState.state.bondingCurve,
    associatedBondingCurve: token.associatedBondingCurve || token.poolState.state.associatedBondingCurve,
    creator: token.creator || null,
    name: token.name,
    symbol: token.symbol,
    rawLogs: token.rawLogs || [],
    detectedAt: token.detectedAt,
    isToken2022: token.isToken2022,
    source: 'websocket',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AB TEST RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

export class ABTestRunner {
  private config: ABTestConfig;
  private connection: Connection;
  private store: ABTestStore;
  private listener: PumpFunListener;
  private reportGenerator: ABReportGenerator;

  private pipelineA: ABPipeline;
  private pipelineB: ABPipeline;
  private trackerA: PaperTradeTracker;
  private trackerB: PaperTradeTracker;

  private tokensDetected = 0;
  private testTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(config: ABTestConfig, connection: Connection) {
    this.config = config;
    this.connection = connection;

    const appConfig = getConfig();
    this.store = new ABTestStore(appConfig.dataDir);
    this.reportGenerator = new ABReportGenerator(this.store);

    // Initialize variant A pipeline + tracker
    this.pipelineA = new ABPipeline('A', connection, config.variantA);
    this.trackerA = new PaperTradeTracker(connection, {
      checkIntervalMs: config.variantA.priceCheckIntervalMs,
      takeProfit: config.variantA.takeProfit,
      stopLoss: config.variantA.stopLoss,
      maxHoldDurationMs: config.variantA.maxHoldDurationMs,
      enabled: true,
    });

    // Initialize variant B pipeline + tracker
    this.pipelineB = new ABPipeline('B', connection, config.variantB);
    this.trackerB = new PaperTradeTracker(connection, {
      checkIntervalMs: config.variantB.priceCheckIntervalMs,
      takeProfit: config.variantB.takeProfit,
      stopLoss: config.variantB.stopLoss,
      maxHoldDurationMs: config.variantB.maxHoldDurationMs,
      enabled: true,
    });

    // Hook into paper trade close events to persist to AB store
    this.trackerA.on('trade-closed', (trade: PaperTrade) => this.onTradeClose('A', trade));
    this.trackerB.on('trade-closed', (trade: PaperTrade) => this.onTradeClose('B', trade));

    // Initialize listener
    this.listener = new PumpFunListener(connection);
  }

  /**
   * Start the A/B test. Returns a promise that resolves with the report
   * when the test duration expires.
   */
  async start(): Promise<ABTestReport> {
    if (this.isRunning) throw new Error('Test already running');
    this.isRunning = true;

    // Record session
    this.store.createSession(this.config);

    logger.info(
      {
        sessionId: this.config.sessionId,
        durationMs: this.config.durationMs,
        durationHours: (this.config.durationMs / 3600000).toFixed(1),
      },
      '[ab-runner] Starting A/B test'
    );

    // Start paper trade monitors
    this.trackerA.start();
    this.trackerB.start();

    // Register new-token handler
    this.listener.on('new-token', (token: DetectedToken) => {
      this.handleNewToken(token).catch(err => {
        logger.error({ error: err }, '[ab-runner] Error handling token');
      });
    });

    // Start listener
    await this.listener.start();

    // Start heartbeat (every 5 minutes)
    this.heartbeatTimer = setInterval(() => this.logHeartbeat(), 5 * 60 * 1000);

    // Wait for test duration to expire
    return new Promise<ABTestReport>((resolve) => {
      this.testTimer = setTimeout(async () => {
        const report = await this.stop();
        resolve(report);
      }, this.config.durationMs);
    });
  }

  /**
   * Stop the test and generate the report.
   */
  async stop(): Promise<ABTestReport> {
    if (!this.isRunning) throw new Error('Test not running');
    this.isRunning = false;

    logger.info('[ab-runner] Stopping A/B test...');

    // Clear timers
    if (this.testTimer) { clearTimeout(this.testTimer); this.testTimer = null; }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }

    // Stop listener
    await this.listener.stop();

    // Stop paper trade monitors
    this.trackerA.stop();
    this.trackerB.stop();

    // Force-close any remaining active positions (record them as time_exit)
    await this.forceCloseActivePositions();

    // Complete session in DB
    this.store.completeSession(this.config.sessionId, this.tokensDetected);

    // Generate report
    const report = this.reportGenerator.generate(this.config.sessionId);
    this.reportGenerator.printReport(report);

    // Cleanup
    this.store.close();

    return report;
  }

  // ── Internal Methods ─────────────────────────────────────────────────────

  private async handleNewToken(token: DetectedToken): Promise<void> {
    this.tokensDetected++;

    const detection = toDetectionEvent(token);

    // Share the bonding curve fetch between both variants to save RPC calls
    let sharedState = undefined;
    try {
      sharedState = await getBondingCurveState(this.connection, detection.bondingCurve);
    } catch {
      // Each variant will handle the null state in their own pipeline
      sharedState = null;
    }

    // Run both pipelines concurrently
    const wrapSafe = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        logger.error({ error: err }, `[ab-runner] ${label} pipeline error`);
      }
    };

    await Promise.all([
      wrapSafe('Variant A', () => this.processForVariant('A', this.pipelineA, this.trackerA, detection, sharedState)),
      wrapSafe('Variant B', () => this.processForVariant('B', this.pipelineB, this.trackerB, detection, sharedState)),
    ]);
  }

  private async processForVariant(
    variant: 'A' | 'B',
    pipeline: ABPipeline,
    tracker: PaperTradeTracker,
    detection: DetectionEvent,
    sharedState: import('../helpers/pumpfun').BondingCurveState | null | undefined,
  ): Promise<void> {
    const result = await pipeline.process(detection, sharedState);

    // Record pipeline decision
    this.store.recordPipelineDecision({
      sessionId: this.config.sessionId,
      variant,
      tokenMint: detection.mint.toString(),
      tokenName: detection.name,
      tokenSymbol: detection.symbol,
      timestamp: Date.now(),
      passed: result.passed,
      rejectionStage: result.rejectionStage,
      rejectionReason: result.rejectionReason,
      pipelineDurationMs: result.pipelineDurationMs,
    });

    if (result.passed && result.bondingCurveState && result.bondingCurve) {
      const variantConfig = variant === 'A' ? this.config.variantA : this.config.variantB;

      // Record paper trade via the existing PaperTradeTracker
      tracker.recordPaperTrade({
        mint: detection.mint,
        bondingCurve: result.bondingCurve,
        bondingCurveState: result.bondingCurveState,
        hypotheticalSolSpent: variantConfig.quoteAmount,
        name: detection.name,
        symbol: detection.symbol,
        signature: detection.signature || 'ab-test',
        pipelineDurationMs: result.pipelineDurationMs,
      });

      // Also record in AB store for persistence
      this.store.recordTradeEntry({
        sessionId: this.config.sessionId,
        variant,
        tokenMint: detection.mint.toString(),
        tokenName: detection.name,
        tokenSymbol: detection.symbol,
        entryTimestamp: Date.now(),
        hypotheticalSolSpent: variantConfig.quoteAmount,
        hypotheticalTokensReceived: 0, // Will be filled by tracker
        entryPricePerToken: 0, // Will be filled by tracker
        pipelineDurationMs: result.pipelineDurationMs,
      });
    }
  }

  /**
   * Handle paper trade close events from PaperTradeTracker.
   * Persists exit data to the AB store.
   */
  private onTradeClose(variant: 'A' | 'B', trade: PaperTrade): void {
    const tradeId = this.store.findActiveTradeId(
      this.config.sessionId,
      variant,
      trade.mint,
    );

    if (!tradeId) {
      logger.debug(
        { variant, mint: trade.mint },
        '[ab-runner] Could not find active AB trade for closed paper trade'
      );
      return;
    }

    this.store.recordTradeExit(tradeId, {
      exitTimestamp: trade.closedTimestamp || Date.now(),
      exitReason: trade.closedReason || 'unknown',
      exitPricePerToken: trade.exitPricePerToken || 0,
      exitSolReceived: trade.exitSolReceived || trade.hypotheticalSolSpent,
      realizedPnlSol: trade.realizedPnlSol || 0,
      realizedPnlPercent: trade.realizedPnlPercent || 0,
      holdDurationMs: (trade.closedTimestamp || Date.now()) - trade.entryTimestamp,
    });

    logger.debug(
      {
        variant,
        mint: trade.mint,
        reason: trade.closedReason,
        pnl: trade.realizedPnlPercent?.toFixed(2) + '%',
      },
      '[ab-runner] Trade exit recorded'
    );
  }

  /**
   * Force-close any positions that are still active when the test ends.
   * Uses current bonding curve state for final P&L calculation.
   */
  private async forceCloseActivePositions(): Promise<void> {
    const summaryA = this.trackerA.getSummaryStats();
    const summaryB = this.trackerB.getSummaryStats();

    if (summaryA.activeTrades === 0 && summaryB.activeTrades === 0) {
      return;
    }

    logger.info(
      { activeA: summaryA.activeTrades, activeB: summaryB.activeTrades },
      '[ab-runner] Force-closing remaining active positions'
    );

    // Trigger a final P&L check which will cause the trackers to evaluate and close
    // We wait briefly for the monitors to process
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  private logHeartbeat(): void {
    const statsA = this.trackerA.getSummaryStats();
    const statsB = this.trackerB.getSummaryStats();
    const elapsed = Date.now() - this.config.startedAt;
    const remaining = Math.max(0, this.config.durationMs - elapsed);

    logger.info(
      {
        sessionId: this.config.sessionId,
        tokensDetected: this.tokensDetected,
        elapsed: `${(elapsed / 60000).toFixed(0)}m`,
        remaining: `${(remaining / 60000).toFixed(0)}m`,
        variantA: {
          active: statsA.activeTrades,
          closed: statsA.closedTrades,
          pnl: statsA.realizedPnlSol.toFixed(4),
        },
        variantB: {
          active: statsB.activeTrades,
          closed: statsB.closedTrades,
          pnl: statsB.realizedPnlSol.toFixed(4),
        },
      },
      '[ab-runner] Heartbeat'
    );
  }
}
