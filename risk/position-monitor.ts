import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { EventEmitter } from 'events';
import {
  Liquidity,
  LiquidityPoolKeysV4,
  Percent,
  Token,
  TokenAmount,
  TOKEN_PROGRAM_ID,
} from '@raydium-io/raydium-sdk';
import BN from 'bn.js';
import { logger, sleep } from '../helpers';
import { getExposureManager, OpenPosition } from './exposure-manager';
import { getPnlTracker } from './pnl-tracker';

/**
 * Monitored position with pool keys for price checks
 */
export interface MonitoredPosition {
  tokenMint: string;
  poolId: string;
  poolKeys: LiquidityPoolKeysV4;
  tokenAmount: TokenAmount;
  entryAmountSol: number;
  entryTimestamp: number;
  takeProfitSol: number;
  stopLossSol: number;
  lastCheckTimestamp: number;
  lastPriceSol: number;
}

/**
 * Trigger event emitted when TP/SL is hit
 */
export interface TriggerEvent {
  type: 'take_profit' | 'stop_loss' | 'manual';
  position: MonitoredPosition;
  currentValueSol: number;
  pnlPercent: number;
}

/**
 * Position monitor configuration
 */
export interface PositionMonitorConfig {
  checkIntervalMs: number;
  takeProfit: number; // percentage
  stopLoss: number; // percentage
  maxHoldDurationMs?: number; // optional time-based exit (0 = disabled)
}

/**
 * Independent position monitor that tracks all open positions indefinitely.
 * Emits events when take-profit or stop-loss triggers are hit.
 *
 * This replaces the time-limited priceMatch() function in bot.ts
 */
export class PositionMonitor extends EventEmitter {
  private positions: Map<string, MonitoredPosition> = new Map();
  private isRunning: boolean = false;
  private monitorLoop: NodeJS.Timeout | null = null;
  private config: PositionMonitorConfig;
  private connection: Connection;
  private quoteToken: Token;
  private sellSlippage: Percent;

  constructor(
    connection: Connection,
    quoteToken: Token,
    config: PositionMonitorConfig,
  ) {
    super();
    this.connection = connection;
    this.quoteToken = quoteToken;
    this.config = config;
    this.sellSlippage = new Percent(30, 100); // Default 30% slippage for price checks

    logger.info(
      {
        checkInterval: `${config.checkIntervalMs}ms`,
        takeProfit: `${config.takeProfit}%`,
        stopLoss: `${config.stopLoss}%`,
        maxHoldDuration: config.maxHoldDurationMs
          ? `${config.maxHoldDurationMs}ms`
          : 'disabled',
      },
      'Position monitor initialized',
    );
  }

  /**
   * Start the monitoring loop
   */
  start(): void {
    if (this.isRunning) {
      logger.warn('Position monitor already running');
      return;
    }

    this.isRunning = true;
    this.runMonitorLoop();
    logger.info('Position monitor started');
  }

  /**
   * Stop the monitoring loop
   */
  stop(): void {
    this.isRunning = false;
    if (this.monitorLoop) {
      clearTimeout(this.monitorLoop);
      this.monitorLoop = null;
    }
    logger.info('Position monitor stopped');
  }

  /**
   * Add a position to monitor
   */
  addPosition(params: {
    tokenMint: string;
    poolId: string;
    poolKeys: LiquidityPoolKeysV4;
    tokenAmount: TokenAmount;
    entryAmountSol: number;
  }): void {
    const { tokenMint, poolId, poolKeys, tokenAmount, entryAmountSol } = params;

    // Calculate take profit and stop loss thresholds
    const takeProfitSol =
      entryAmountSol * (1 + this.config.takeProfit / 100);
    const stopLossSol = entryAmountSol * (1 - this.config.stopLoss / 100);

    const position: MonitoredPosition = {
      tokenMint,
      poolId,
      poolKeys,
      tokenAmount,
      entryAmountSol,
      entryTimestamp: Date.now(),
      takeProfitSol,
      stopLossSol,
      lastCheckTimestamp: Date.now(),
      lastPriceSol: entryAmountSol,
    };

    this.positions.set(tokenMint, position);

    // Also add to exposure manager
    const exposureManager = getExposureManager();
    if (exposureManager) {
      exposureManager.addPosition({
        tokenMint,
        entryAmountSol,
        currentValueSol: entryAmountSol,
        entryTimestamp: position.entryTimestamp,
        poolId,
      });
    }

    logger.info(
      {
        tokenMint,
        entryAmountSol: entryAmountSol.toFixed(4),
        takeProfit: takeProfitSol.toFixed(4),
        stopLoss: stopLossSol.toFixed(4),
        totalPositions: this.positions.size,
      },
      'Position added to monitor',
    );
  }

  /**
   * Remove a position from monitoring
   */
  removePosition(tokenMint: string): boolean {
    const existed = this.positions.delete(tokenMint);

    // Also remove from exposure manager
    const exposureManager = getExposureManager();
    if (exposureManager) {
      exposureManager.removePosition(tokenMint);
    }

    if (existed) {
      logger.info(
        { tokenMint, remainingPositions: this.positions.size },
        'Position removed from monitor',
      );
    }

    return existed;
  }

  /**
   * Get a monitored position
   */
  getPosition(tokenMint: string): MonitoredPosition | undefined {
    return this.positions.get(tokenMint);
  }

  /**
   * Get all monitored positions
   */
  getAllPositions(): MonitoredPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Check if a position is being monitored
   */
  hasPosition(tokenMint: string): boolean {
    return this.positions.has(tokenMint);
  }

  /**
   * Update take profit/stop loss for a position
   */
  updateTriggers(
    tokenMint: string,
    takeProfitPercent?: number,
    stopLossPercent?: number,
  ): boolean {
    const position = this.positions.get(tokenMint);
    if (!position) {
      return false;
    }

    if (takeProfitPercent !== undefined) {
      position.takeProfitSol =
        position.entryAmountSol * (1 + takeProfitPercent / 100);
    }

    if (stopLossPercent !== undefined) {
      position.stopLossSol =
        position.entryAmountSol * (1 - stopLossPercent / 100);
    }

    logger.info(
      {
        tokenMint,
        newTakeProfit: position.takeProfitSol.toFixed(4),
        newStopLoss: position.stopLossSol.toFixed(4),
      },
      'Position triggers updated',
    );

    return true;
  }

  /**
   * Main monitoring loop
   */
  private async runMonitorLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        await this.checkAllPositions();
      } catch (error) {
        logger.error({ error }, 'Error in position monitor loop');
      }

      await sleep(this.config.checkIntervalMs);
    }
  }

  /**
   * Check all positions for trigger conditions
   */
  private async checkAllPositions(): Promise<void> {
    const positions = Array.from(this.positions.values());

    if (positions.length === 0) {
      return;
    }

    // Check positions in parallel (with some concurrency limit)
    const batchSize = 3;
    for (let i = 0; i < positions.length; i += batchSize) {
      const batch = positions.slice(i, i + batchSize);
      await Promise.all(batch.map((p) => this.checkPosition(p)));
    }
  }

  /**
   * Check a single position for trigger conditions
   */
  private async checkPosition(position: MonitoredPosition): Promise<void> {
    try {
      // Fetch current pool info
      const poolInfo = await Liquidity.fetchInfo({
        connection: this.connection,
        poolKeys: position.poolKeys,
      });

      // Calculate current value in quote token (SOL)
      const amountOut = Liquidity.computeAmountOut({
        poolKeys: position.poolKeys,
        poolInfo,
        amountIn: position.tokenAmount,
        currencyOut: this.quoteToken,
        slippage: this.sellSlippage,
      }).amountOut;

      const currentValueSol = parseFloat(amountOut.toFixed());

      // Update position tracking
      position.lastCheckTimestamp = Date.now();
      position.lastPriceSol = currentValueSol;

      // Update exposure manager with current value
      const exposureManager = getExposureManager();
      if (exposureManager) {
        exposureManager.updatePositionValue(position.tokenMint, currentValueSol);
      }

      // Calculate P&L
      const pnlSol = currentValueSol - position.entryAmountSol;
      const pnlPercent = (pnlSol / position.entryAmountSol) * 100;

      logger.debug(
        {
          tokenMint: position.tokenMint,
          currentValue: currentValueSol.toFixed(4),
          takeProfit: position.takeProfitSol.toFixed(4),
          stopLoss: position.stopLossSol.toFixed(4),
          pnlPercent: `${pnlPercent.toFixed(2)}%`,
        },
        'Position price check',
      );

      // Check take profit
      if (currentValueSol >= position.takeProfitSol) {
        logger.info(
          {
            tokenMint: position.tokenMint,
            currentValue: currentValueSol.toFixed(4),
            takeProfit: position.takeProfitSol.toFixed(4),
            pnlPercent: `+${pnlPercent.toFixed(2)}%`,
          },
          'Take profit triggered',
        );

        this.emit('trigger', {
          type: 'take_profit',
          position,
          currentValueSol,
          pnlPercent,
        } as TriggerEvent);

        return;
      }

      // Check stop loss
      if (currentValueSol <= position.stopLossSol) {
        logger.info(
          {
            tokenMint: position.tokenMint,
            currentValue: currentValueSol.toFixed(4),
            stopLoss: position.stopLossSol.toFixed(4),
            pnlPercent: `${pnlPercent.toFixed(2)}%`,
          },
          'Stop loss triggered',
        );

        this.emit('trigger', {
          type: 'stop_loss',
          position,
          currentValueSol,
          pnlPercent,
        } as TriggerEvent);

        return;
      }

      // Check max hold duration (if configured)
      if (this.config.maxHoldDurationMs && this.config.maxHoldDurationMs > 0) {
        const holdDuration = Date.now() - position.entryTimestamp;
        if (holdDuration >= this.config.maxHoldDurationMs) {
          logger.info(
            {
              tokenMint: position.tokenMint,
              holdDuration: `${Math.floor(holdDuration / 60000)}m`,
              currentValue: currentValueSol.toFixed(4),
              pnlPercent: `${pnlPercent.toFixed(2)}%`,
            },
            'Max hold duration reached',
          );

          this.emit('trigger', {
            type: 'manual',
            position,
            currentValueSol,
            pnlPercent,
          } as TriggerEvent);

          return;
        }
      }
    } catch (error) {
      logger.warn(
        { tokenMint: position.tokenMint, error },
        'Failed to check position price',
      );
    }
  }

  /**
   * Manually trigger a sell for a position
   */
  triggerManualSell(tokenMint: string): boolean {
    const position = this.positions.get(tokenMint);
    if (!position) {
      logger.warn({ tokenMint }, 'Cannot trigger sell - position not found');
      return false;
    }

    const pnlPercent =
      ((position.lastPriceSol - position.entryAmountSol) /
        position.entryAmountSol) *
      100;

    this.emit('trigger', {
      type: 'manual',
      position,
      currentValueSol: position.lastPriceSol,
      pnlPercent,
    } as TriggerEvent);

    return true;
  }

  /**
   * Get monitor statistics
   */
  getStats(): {
    isRunning: boolean;
    positionCount: number;
    totalEntryValue: number;
    totalCurrentValue: number;
    unrealizedPnl: number;
    unrealizedPnlPercent: number;
  } {
    let totalEntryValue = 0;
    let totalCurrentValue = 0;

    for (const position of this.positions.values()) {
      totalEntryValue += position.entryAmountSol;
      totalCurrentValue += position.lastPriceSol;
    }

    const unrealizedPnl = totalCurrentValue - totalEntryValue;
    const unrealizedPnlPercent =
      totalEntryValue > 0 ? (unrealizedPnl / totalEntryValue) * 100 : 0;

    return {
      isRunning: this.isRunning,
      positionCount: this.positions.size,
      totalEntryValue,
      totalCurrentValue,
      unrealizedPnl,
      unrealizedPnlPercent,
    };
  }

  /**
   * Log current status
   */
  logStatus(): void {
    const stats = this.getStats();

    if (stats.positionCount === 0) {
      logger.info({ isRunning: stats.isRunning }, 'Position monitor: No open positions');
      return;
    }

    logger.info(
      {
        isRunning: stats.isRunning,
        positions: stats.positionCount,
        totalEntry: `${stats.totalEntryValue.toFixed(4)} SOL`,
        totalCurrent: `${stats.totalCurrentValue.toFixed(4)} SOL`,
        unrealizedPnl: `${stats.unrealizedPnl >= 0 ? '+' : ''}${stats.unrealizedPnl.toFixed(4)} SOL`,
        unrealizedPnlPercent: `${stats.unrealizedPnlPercent >= 0 ? '+' : ''}${stats.unrealizedPnlPercent.toFixed(2)}%`,
      },
      'Position monitor status',
    );
  }
}

/**
 * Singleton instance
 */
let positionMonitorInstance: PositionMonitor | null = null;

/**
 * Initialize the position monitor singleton
 */
export function initPositionMonitor(
  connection: Connection,
  quoteToken: Token,
  config: PositionMonitorConfig,
): PositionMonitor {
  positionMonitorInstance = new PositionMonitor(connection, quoteToken, config);
  return positionMonitorInstance;
}

/**
 * Get the position monitor instance
 */
export function getPositionMonitor(): PositionMonitor | null {
  return positionMonitorInstance;
}
