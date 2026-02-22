import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { EventEmitter } from 'events';
import {
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  logger,
  getBondingCurveState,
  decodeBondingCurveState,
  deriveBondingCurve,
  calculateSellSolOut,
  sellOnPumpFun,
  SELL_SLIPPAGE,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  DRY_RUN,
} from '../helpers';
import { getStateStore } from '../persistence';
import { getExposureManager } from './exposure-manager';
import { getPnlTracker } from './pnl-tracker';
import { getLogSummarizer } from '../helpers/log-summarizer';
import BN from 'bn.js';

/**
 * pump.fun position for monitoring
 */
export interface PumpFunPosition {
  tokenMint: string;
  bondingCurve: string;
  entryAmountSol: number;
  actualCostSol?: number; // Total wallet debit (trade + ATA rent + gas fees)
  tokenAmount: number;
  entryTimestamp: number;
  buySignature: string;
  isToken2022?: boolean;
  // For unrealized PnL tracking
  lastCurrentValueSol?: number;
  lastCheckTimestamp?: number;
  // Sniper gate metadata (for future sell pressure analysis)
  sniperWallets?: string[];
  // Trailing stop: highest PnL % seen (updated each check)
  highWaterMarkPercent?: number;
}

/**
 * Trigger event for pump.fun positions
 */
export interface PumpFunTriggerEvent {
  type: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'time_exit' | 'manual' | 'graduated';
  position: PumpFunPosition;
  currentValueSol: number;
  pnlPercent: number;
  totalCostPnlPercent?: number; // PnL including fees/ATA rent (for reporting)
  reason: string;
}

/**
 * Configuration for pump.fun position monitor
 */
export interface PumpFunMonitorConfig {
  checkIntervalMs: number;
  takeProfit: number; // percentage
  stopLoss: number; // percentage
  maxHoldDurationMs?: number; // 0 = disabled
  // Trailing stop loss (all optional - disabled by default)
  trailingStopEnabled?: boolean;          // default: false
  trailingStopActivationPercent?: number; // default: 15 (activate at +15% PnL)
  trailingStopDistancePercent?: number;   // default: 10 (sell if 10% below high water)
  hardTakeProfitPercent?: number;         // default: 0 (0 = disabled)
}

/**
 * pump.fun Position Monitor
 *
 * Monitors positions bought through pump.fun bonding curves and triggers sells
 * when take-profit, stop-loss, or time-based exit conditions are met.
 */
export class PumpFunPositionMonitor extends EventEmitter {
  private positions: Map<string, PumpFunPosition> = new Map();
  private sellingPositions: Set<string> = new Set();
  private isRunning: boolean = false;
  private monitorLoop: NodeJS.Timeout | null = null;
  private config: PumpFunMonitorConfig;
  private connection: Connection;
  private wallet: Keypair;

  constructor(
    connection: Connection,
    wallet: Keypair,
    config: PumpFunMonitorConfig,
  ) {
    super();
    this.connection = connection;
    this.wallet = wallet;
    this.config = config;

    const trailingEnabled = config.trailingStopEnabled ?? false;
    const trailingActivation = config.trailingStopActivationPercent ?? 15;
    const trailingDistance = config.trailingStopDistancePercent ?? 10;
    const hardTp = config.hardTakeProfitPercent ?? 0;

    logger.info(
      {
        checkInterval: `${(config.checkIntervalMs / 60000).toFixed(4)} min`,
        takeProfit: trailingEnabled ? 'disabled (trailing stop active)' : `${config.takeProfit}%`,
        stopLoss: `${config.stopLoss}%`,
        maxHoldDuration: config.maxHoldDurationMs
          ? `${(config.maxHoldDurationMs / 60000).toFixed(4)} min`
          : 'disabled',
        trailingStop: trailingEnabled
          ? `enabled (activate at +${trailingActivation}%, trail ${trailingDistance}%)`
          : 'disabled',
        hardTakeProfit: hardTp > 0 ? `${hardTp}%` : 'disabled',
      },
      '[pump.fun] Position monitor initialized',
    );
  }

  /**
   * Start the monitoring loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('[pump.fun] Position monitor already running');
      return;
    }

    this.isRunning = true;
    logger.info('[pump.fun] Starting position monitor');

    // Run immediately, then on interval
    this.checkPositions();

    this.monitorLoop = setInterval(() => {
      this.checkPositions();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the monitoring loop
   */
  stop(): void {
    if (this.monitorLoop) {
      clearInterval(this.monitorLoop);
      this.monitorLoop = null;
    }
    this.isRunning = false;
    logger.info('[pump.fun] Position monitor stopped');
  }

  /**
   * Add a position to monitor
   */
  addPosition(position: PumpFunPosition): void {
    if (!position.entryAmountSol || position.entryAmountSol <= 0) {
      logger.error(
        {
          mint: position.tokenMint,
          entryAmountSol: position.entryAmountSol,
        },
        '[pump.fun] Rejecting position with invalid entryAmountSol <= 0',
      );
      return;
    }

    this.positions.set(position.tokenMint, position);
    logger.info(
      {
        mint: position.tokenMint,
        entrySol: position.entryAmountSol,
        tokenAmount: position.tokenAmount,
      },
      '[pump.fun] Position added to monitor',
    );
  }

  /**
   * Remove a position from monitoring
   */
  removePosition(tokenMint: string): void {
    this.positions.delete(tokenMint);
    logger.debug({ mint: tokenMint }, '[pump.fun] Position removed from monitor');
  }

  /**
   * Get all monitored positions
   */
  getPositions(): PumpFunPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Check all positions using batched RPC calls
   * Uses getMultipleAccountsInfo to fetch all bonding curve states in ONE call
   */
  private async checkPositions(): Promise<void> {
    if (this.positions.size === 0) {
      return;
    }

    const positionList = Array.from(this.positions.values());
    logger.debug({ count: positionList.length }, '[pump.fun] Checking positions (batched)');

    try {
      // ═══════════════ BATCH FETCH BONDING CURVE STATES ═══════════════
      // Single RPC call for ALL positions instead of N individual calls
      const bondingCurveKeys = positionList.map(p => new PublicKey(p.bondingCurve));
      const accountInfos = await this.connection.getMultipleAccountsInfo(bondingCurveKeys, 'confirmed');

      // Process each position with its corresponding account data
      for (let i = 0; i < positionList.length; i++) {
        const position = positionList[i];
        const accountInfo = accountInfos[i];

        try {
          await this.evaluatePosition(position, accountInfo?.data || null);
        } catch (error) {
          logger.error(
            { error, mint: position.tokenMint },
            '[pump.fun] Error evaluating position',
          );
        }
      }
    } catch (error) {
      logger.error({ error }, '[pump.fun] Error fetching bonding curve states (batch)');
    }
  }

  /**
   * Evaluate a single position using pre-fetched bonding curve data
   * No individual RPC calls - all data passed in from batch fetch
   */
  private async evaluatePosition(
    position: PumpFunPosition,
    bondingCurveData: Buffer | null,
  ): Promise<void> {
    // Check max hold duration first (no RPC needed)
    if (this.config.maxHoldDurationMs && this.config.maxHoldDurationMs > 0) {
      const holdDuration = Date.now() - position.entryTimestamp;
      if (holdDuration >= this.config.maxHoldDurationMs) {
        const currentValueSol = position.lastCurrentValueSol ?? position.entryAmountSol;
        const pnlPercent = ((currentValueSol - position.entryAmountSol) / position.entryAmountSol) * 100;
        logger.info(
          { mint: position.tokenMint, holdDurationMs: holdDuration },
          '[pump.fun] Max hold duration triggered',
        );
        await this.executeSell(position, currentValueSol, pnlPercent, 'time_exit', `Time exit after ${Math.floor(holdDuration / 1000)}s`);
        return;
      }
    }

    // Decode bonding curve state from pre-fetched data
    if (!bondingCurveData) {
      logger.warn({ mint: position.tokenMint }, '[pump.fun] Could not get bonding curve state');
      return;
    }

    const state = decodeBondingCurveState(bondingCurveData);
    if (!state) {
      logger.warn({ mint: position.tokenMint }, '[pump.fun] Could not decode bonding curve state');
      return;
    }

    // Check if token graduated
    if (state.complete) {
      logger.info({ mint: position.tokenMint }, '[pump.fun] Token graduated - triggering sell');
      await this.executeSell(position, 0, 0, 'graduated', 'Token graduated from bonding curve');
      return;
    }

    // Use stored token amount from buy (avoids extra RPC call for balance check)
    const tokenAmount = position.tokenAmount;
    if (tokenAmount === 0) {
      logger.warn({ mint: position.tokenMint }, '[pump.fun] Position has 0 tokens');
      return;
    }

    // Calculate current value
    const tokenAmountBN = new BN(tokenAmount);
    const expectedSolOut = calculateSellSolOut(state, tokenAmountBN);
    const currentValueSol = expectedSolOut.toNumber() / LAMPORTS_PER_SOL;

    // Guard: skip evaluation if currentValueSol is invalid (corrupted/stale bonding curve)
    if (!Number.isFinite(currentValueSol) || currentValueSol < 0) {
      logger.warn(
        {
          mint: position.tokenMint,
          rawSolOut: expectedSolOut.toString(),
          currentValueSol,
        },
        '[pump.fun] Invalid currentValueSol — skipping evaluation (will retry next interval)',
      );
      return;
    }

    // Calculate bonding curve P&L (used for TP/SL triggers)
    const pnlSol = currentValueSol - position.entryAmountSol;
    const pnlPercent = (pnlSol / position.entryAmountSol) * 100;

    // Calculate total-cost P&L (includes ATA rent + gas fees, for reporting only)
    let totalCostPnlPercent: number | undefined;
    if (position.actualCostSol !== undefined && position.actualCostSol > 0) {
      const totalCostPnlSol = currentValueSol - position.actualCostSol;
      totalCostPnlPercent = (totalCostPnlSol / position.actualCostSol) * 100;
    }

    // Store current value for unrealized PnL tracking
    position.lastCurrentValueSol = currentValueSol;
    position.lastCheckTimestamp = Date.now();

    logger.debug(
      {
        mint: position.tokenMint,
        entryAmountSol: position.entryAmountSol,
        actualCostSol: position.actualCostSol,
        currentValueSol: currentValueSol.toFixed(4),
        bondingCurvePnl: pnlPercent.toFixed(2) + '%',
        totalCostPnl: totalCostPnlPercent !== undefined
          ? totalCostPnlPercent.toFixed(2) + '%'
          : 'N/A',
        holdTimeSec: Math.floor((Date.now() - position.entryTimestamp) / 1000),
      },
      '[pump.fun] Position check',
    );

    // ═══════════════ TRAILING STOP LOGIC ═══════════════
    const trailingStopEnabled = this.config.trailingStopEnabled ?? false;
    const trailingStopActivationPercent = this.config.trailingStopActivationPercent ?? 15;
    const trailingStopDistancePercent = this.config.trailingStopDistancePercent ?? 10;
    const hardTakeProfitPercent = this.config.hardTakeProfitPercent ?? 0;

    if (trailingStopEnabled) {
      // Initialize high water mark if not set
      if (position.highWaterMarkPercent === undefined) {
        position.highWaterMarkPercent = 0;
      }

      // Update high water mark
      if (pnlPercent > position.highWaterMarkPercent) {
        position.highWaterMarkPercent = pnlPercent;
      }

      // Check if trailing stop is activated (above activation threshold)
      if (position.highWaterMarkPercent >= trailingStopActivationPercent) {
        const trailLevel = position.highWaterMarkPercent - trailingStopDistancePercent;

        if (pnlPercent <= trailLevel) {
          logger.info(
            {
              mint: position.tokenMint,
              pnlPercent: pnlPercent.toFixed(2),
              highWaterMark: position.highWaterMarkPercent.toFixed(2),
              trailLevel: trailLevel.toFixed(2),
            },
            '[pump.fun] Trailing stop triggered',
          );
          await this.executeSell(
            position,
            currentValueSol,
            pnlPercent,
            'trailing_stop',
            `Trail stop: PnL ${pnlPercent.toFixed(2)}% dropped below trail ${trailLevel.toFixed(2)}% (high: ${position.highWaterMarkPercent.toFixed(2)}%)`,
          );
          return;
        }
      }

      // Hard take profit ceiling (optional, fires even with trailing stop active)
      if (hardTakeProfitPercent > 0 && pnlPercent >= hardTakeProfitPercent) {
        logger.info(
          { mint: position.tokenMint, pnlPercent: pnlPercent.toFixed(2) },
          '[pump.fun] Hard take profit triggered',
        );
        await this.executeSell(
          position,
          currentValueSol,
          pnlPercent,
          'take_profit',
          `Hard TP hit: ${pnlPercent.toFixed(2)}%`,
        );
        return;
      }
    }

    // Check take profit (only when trailing stop is disabled)
    if (!trailingStopEnabled && pnlPercent >= this.config.takeProfit) {
      logger.info(
        { mint: position.tokenMint, pnlPercent: pnlPercent.toFixed(2) },
        '[pump.fun] Take profit triggered',
      );
      await this.executeSell(position, currentValueSol, pnlPercent, 'take_profit', `TP hit: ${pnlPercent.toFixed(2)}%`);
      return;
    }

    // Check stop loss (always active - protects before trailing stop activates)
    if (pnlPercent <= -this.config.stopLoss) {
      logger.info(
        { mint: position.tokenMint, pnlPercent: pnlPercent.toFixed(2) },
        '[pump.fun] Stop loss triggered',
      );
      await this.executeSell(position, currentValueSol, pnlPercent, 'stop_loss', `SL hit: ${pnlPercent.toFixed(2)}%`);
      return;
    }
  }

  /**
   * Execute a sell for a position
   */
  private async executeSell(
    position: PumpFunPosition,
    currentValueSol: number,
    pnlPercent: number,
    triggerType: PumpFunTriggerEvent['type'],
    reason: string,
  ): Promise<void> {
    // Guard: prevent concurrent sells for the same position
    if (this.sellingPositions.has(position.tokenMint)) {
      logger.debug({ mint: position.tokenMint }, '[pump.fun] Sell already in progress - skipping');
      return;
    }
    this.sellingPositions.add(position.tokenMint);

    try {
      await this.executeSellInner(position, currentValueSol, pnlPercent, triggerType, reason);
    } finally {
      this.sellingPositions.delete(position.tokenMint);
    }
  }

  private async executeSellInner(
    position: PumpFunPosition,
    currentValueSol: number,
    pnlPercent: number,
    triggerType: PumpFunTriggerEvent['type'],
    reason: string,
  ): Promise<void> {
    const mint = new PublicKey(position.tokenMint);
    const bondingCurve = new PublicKey(position.bondingCurve);

    // Determine token program ID based on token type
    const tokenProgramId = position.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // Compute total-cost PnL for reporting
    let totalCostPnlPercent: number | undefined;
    if (position.actualCostSol !== undefined && position.actualCostSol > 0) {
      totalCostPnlPercent = ((currentValueSol - position.actualCostSol) / position.actualCostSol) * 100;
    }

    // Emit trigger event before executing
    const triggerEvent: PumpFunTriggerEvent = {
      type: triggerType,
      position,
      currentValueSol,
      pnlPercent,
      totalCostPnlPercent,
      reason,
    };
    this.emit('trigger', triggerEvent);

    // If an external handler (e.g. smoke test) removed the position after the trigger,
    // it intends to handle the sell itself — bail out to avoid a duplicate sell.
    if (!this.positions.has(position.tokenMint)) {
      logger.debug({ mint: position.tokenMint }, '[pump.fun] Position removed by external handler - skipping sell');
      return;
    }

    // Record sell attempt in log summarizer
    const summarizer = getLogSummarizer();
    if (summarizer) summarizer.recordSellAttempt();

    // Get actual token balance
    const tokenAta = getAssociatedTokenAddressSync(
      mint,
      this.wallet.publicKey,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    let actualTokenAmount: number;

    try {
      const tokenAccount = await getAccount(this.connection, tokenAta, 'confirmed', tokenProgramId);
      actualTokenAmount = Number(tokenAccount.amount);
    } catch {
      logger.warn({ mint: position.tokenMint }, '[pump.fun] Could not get token balance for sell');
      this.removePosition(position.tokenMint);
      return;
    }

    if (actualTokenAmount === 0) {
      logger.warn({ mint: position.tokenMint }, '[pump.fun] No tokens to sell');
      this.removePosition(position.tokenMint);
      return;
    }

    logger.info(
      {
        mint: position.tokenMint,
        tokenAmount: actualTokenAmount,
        triggerType,
        reason,
        pnlPercent: pnlPercent.toFixed(2) + '%',
      },
      '[pump.fun] Executing sell',
    );

    if (DRY_RUN) {
      logger.info(
        { mint: position.tokenMint, tokenAmount: actualTokenAmount, currentValueSol },
        '[pump.fun] DRY RUN - would have sold tokens',
      );
      if (summarizer) summarizer.recordSellSuccess();
      this.finalizeSell(position, 'dry_run', currentValueSol, pnlPercent, reason);
      return;
    }

    // Execute sell
    const sellResult = await sellOnPumpFun({
      connection: this.connection,
      wallet: this.wallet,
      mint,
      bondingCurve,
      tokenAmount: actualTokenAmount,
      slippageBps: SELL_SLIPPAGE * 100,
      computeUnitLimit: COMPUTE_UNIT_LIMIT,
      computeUnitPrice: COMPUTE_UNIT_PRICE,
      isToken2022: position.isToken2022,
    });

    if (sellResult.success) {
      // Use actual verified SOL received, fall back to calculated value
      const actualSolReceived = sellResult.solReceived ?? currentValueSol;
      const expectedSol = sellResult.expectedSol ?? currentValueSol;

      // Recalculate PnL based on actual SOL received
      const actualPnlSol = actualSolReceived - position.entryAmountSol;
      const actualPnlPercent = (actualPnlSol / position.entryAmountSol) * 100;

      // Log slippage if verification succeeded
      if (sellResult.actualVerified && sellResult.slippagePercent !== undefined) {
        const slippageSign = sellResult.slippagePercent >= 0 ? '+' : '';
        logger.info(
          {
            mint: position.tokenMint,
            expectedSol: expectedSol.toFixed(6),
            actualSol: actualSolReceived.toFixed(6),
            slippagePercent: `${slippageSign}${sellResult.slippagePercent.toFixed(2)}%`,
            verificationMethod: sellResult.verificationMethod,
          },
          '[pump.fun] Sell verification complete'
        );
      } else if (!sellResult.actualVerified) {
        logger.warn(
          {
            mint: position.tokenMint,
            solReceived: actualSolReceived,
            verificationMethod: sellResult.verificationMethod,
          },
          '[pump.fun] Sell verification failed - using expected SOL'
        );
      }

      logger.info(
        {
          mint: position.tokenMint,
          signature: sellResult.signature,
          solReceived: actualSolReceived.toFixed(6),
          pnlPercent: actualPnlPercent.toFixed(2) + '%',
          verified: sellResult.actualVerified,
        },
        '[pump.fun] Sell successful',
      );

      // Use ACTUAL SOL received for PnL calculation (CRITICAL FIX)
      if (summarizer) summarizer.recordSellSuccess();
      this.finalizeSell(position, sellResult.signature || '', actualSolReceived, actualPnlPercent, reason);
    } else {
      if (summarizer) {
        summarizer.recordSellFailure();
        summarizer.recordError(`Sell failed: ${sellResult.error || 'unknown'}`);
      }
      logger.error(
        { mint: position.tokenMint, error: sellResult.error },
        '[pump.fun] Sell failed',
      );
      // Don't remove position on failed sell - will retry
    }
  }

  /**
   * Finalize a sell - update state and tracking
   */
  private finalizeSell(
    position: PumpFunPosition,
    signature: string,
    exitValueSol: number,
    pnlPercent: number,
    reason: string,
  ): void {
    // Remove from monitoring
    this.removePosition(position.tokenMint);

    // Update state store
    const stateStore = getStateStore();
    if (stateStore) {
      stateStore.closePosition(position.tokenMint, `${reason} (sig: ${signature})`);
    }

    // Update P&L tracker
    const pnlTracker = getPnlTracker();
    pnlTracker.recordSell({
      tokenMint: position.tokenMint,
      amountSol: exitValueSol,
      amountToken: position.tokenAmount,
      txSignature: signature,
      poolId: position.bondingCurve,
    });

    // Update exposure manager
    const exposureManager = getExposureManager();
    if (exposureManager) {
      exposureManager.removePosition(position.tokenMint);
    }

    // Emit completion event
    this.emit('sell-complete', {
      tokenMint: position.tokenMint,
      signature,
      exitValueSol,
      pnlPercent,
      reason,
    });

    // Compute total-cost PnL for the close log
    let totalCostPnl = 'N/A';
    if (position.actualCostSol !== undefined && position.actualCostSol > 0) {
      const tcPnl = ((exitValueSol - position.actualCostSol) / position.actualCostSol) * 100;
      totalCostPnl = tcPnl.toFixed(2) + '%';
    }

    logger.info(
      {
        mint: position.tokenMint,
        entrySol: position.entryAmountSol,
        actualCostSol: position.actualCostSol,
        exitSol: exitValueSol,
        bondingCurvePnl: pnlPercent.toFixed(2) + '%',
        totalCostPnl,
        reason,
      },
      '[pump.fun] Position closed',
    );
  }

  /**
   * Get monitor statistics including unrealized P&L
   */
  getStats(): {
    isRunning: boolean;
    positionCount: number;
    totalEntryValue: number;
    totalCurrentValue: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
    totalActualCost: number;
    totalCostUnrealizedPnl: number;
    totalCostUnrealizedPnlPercent: number;
  } {
    let totalEntryValue = 0;
    let totalCurrentValue = 0;
    let totalActualCost = 0;

    for (const position of this.positions.values()) {
      totalEntryValue += position.entryAmountSol;
      totalCurrentValue += position.lastCurrentValueSol ?? position.entryAmountSol;
      totalActualCost += position.actualCostSol ?? position.entryAmountSol;
    }

    const unrealizedPnl = totalCurrentValue - totalEntryValue;
    const unrealizedPnlPercent =
      totalEntryValue > 0 ? (unrealizedPnl / totalEntryValue) * 100 : 0;

    const totalCostUnrealizedPnl = totalCurrentValue - totalActualCost;
    const totalCostUnrealizedPnlPercent =
      totalActualCost > 0 ? (totalCostUnrealizedPnl / totalActualCost) * 100 : 0;

    return {
      isRunning: this.isRunning,
      positionCount: this.positions.size,
      totalEntryValue,
      totalCurrentValue,
      unrealizedPnl,
      unrealizedPnlPercent,
      totalActualCost,
      totalCostUnrealizedPnl,
      totalCostUnrealizedPnlPercent,
    };
  }
}

// Singleton instance
let pumpFunPositionMonitor: PumpFunPositionMonitor | null = null;

/**
 * Initialize the pump.fun position monitor
 */
export function initPumpFunPositionMonitor(
  connection: Connection,
  wallet: Keypair,
  config: PumpFunMonitorConfig,
): PumpFunPositionMonitor {
  if (!pumpFunPositionMonitor) {
    pumpFunPositionMonitor = new PumpFunPositionMonitor(connection, wallet, config);
  }
  return pumpFunPositionMonitor;
}

/**
 * Get the pump.fun position monitor instance
 */
export function getPumpFunPositionMonitor(): PumpFunPositionMonitor | null {
  return pumpFunPositionMonitor;
}
