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
import BN from 'bn.js';

/**
 * pump.fun position for monitoring
 */
export interface PumpFunPosition {
  tokenMint: string;
  bondingCurve: string;
  entryAmountSol: number;
  tokenAmount: number;
  entryTimestamp: number;
  buySignature: string;
  isToken2022?: boolean;
  // For unrealized PnL tracking
  lastCurrentValueSol?: number;
  lastCheckTimestamp?: number;
}

/**
 * Trigger event for pump.fun positions
 */
export interface PumpFunTriggerEvent {
  type: 'take_profit' | 'stop_loss' | 'time_exit' | 'manual' | 'graduated';
  position: PumpFunPosition;
  currentValueSol: number;
  pnlPercent: number;
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
}

/**
 * pump.fun Position Monitor
 *
 * Monitors positions bought through pump.fun bonding curves and triggers sells
 * when take-profit, stop-loss, or time-based exit conditions are met.
 */
export class PumpFunPositionMonitor extends EventEmitter {
  private positions: Map<string, PumpFunPosition> = new Map();
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

    logger.info(
      {
        checkInterval: `${config.checkIntervalMs}ms`,
        takeProfit: `${config.takeProfit}%`,
        stopLoss: `${config.stopLoss}%`,
        maxHoldDuration: config.maxHoldDurationMs
          ? `${config.maxHoldDurationMs}ms`
          : 'disabled',
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
   * Check all positions and trigger sells if conditions met
   */
  private async checkPositions(): Promise<void> {
    if (this.positions.size === 0) {
      return;
    }

    logger.debug({ count: this.positions.size }, '[pump.fun] Checking positions');

    for (const [tokenMint, position] of this.positions) {
      try {
        await this.checkPosition(position);
      } catch (error) {
        logger.error(
          { error, mint: tokenMint },
          '[pump.fun] Error checking position',
        );
      }
    }
  }

  /**
   * Check a single position
   */
  private async checkPosition(position: PumpFunPosition): Promise<void> {
    const mint = new PublicKey(position.tokenMint);
    const bondingCurve = new PublicKey(position.bondingCurve);

    // Determine token program ID based on token type
    const tokenProgramId = position.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // First check if we still have tokens
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

      if (actualTokenAmount === 0) {
        // Position was sold externally or transferred
        logger.info({ mint: position.tokenMint }, '[pump.fun] Position closed externally (no tokens)');
        this.removePosition(position.tokenMint);

        // Update state store
        const stateStore = getStateStore();
        if (stateStore) {
          stateStore.closePosition(position.tokenMint, 'Tokens no longer in wallet');
        }
        return;
      }
    } catch {
      // Token account doesn't exist - position closed
      logger.info({ mint: position.tokenMint }, '[pump.fun] Position closed (token account not found)');
      this.removePosition(position.tokenMint);
      return;
    }

    // Get bonding curve state to calculate current value
    const state = await getBondingCurveState(this.connection, bondingCurve);

    if (!state) {
      logger.warn({ mint: position.tokenMint }, '[pump.fun] Could not get bonding curve state');
      return;
    }

    // Check if token graduated
    if (state.complete) {
      logger.info({ mint: position.tokenMint }, '[pump.fun] Token graduated - triggering sell');
      await this.executeSell(position, 0, 0, 'graduated', 'Token graduated from bonding curve');
      return;
    }

    // Calculate current value
    const tokenAmountBN = new BN(actualTokenAmount);
    const expectedSolOut = calculateSellSolOut(state, tokenAmountBN);
    const currentValueSol = expectedSolOut.toNumber() / LAMPORTS_PER_SOL;

    // Calculate P&L
    const pnlSol = currentValueSol - position.entryAmountSol;
    const pnlPercent = (pnlSol / position.entryAmountSol) * 100;

    // Store current value for unrealized PnL tracking
    position.lastCurrentValueSol = currentValueSol;
    position.lastCheckTimestamp = Date.now();

    logger.debug(
      {
        mint: position.tokenMint,
        entryAmountSol: position.entryAmountSol,
        currentValueSol: currentValueSol.toFixed(4),
        pnlPercent: pnlPercent.toFixed(2) + '%',
      },
      '[pump.fun] Position check',
    );

    // Check take profit
    if (pnlPercent >= this.config.takeProfit) {
      logger.info(
        { mint: position.tokenMint, pnlPercent: pnlPercent.toFixed(2) },
        '[pump.fun] Take profit triggered',
      );
      await this.executeSell(position, currentValueSol, pnlPercent, 'take_profit', `TP hit: ${pnlPercent.toFixed(2)}%`);
      return;
    }

    // Check stop loss
    if (pnlPercent <= -this.config.stopLoss) {
      logger.info(
        { mint: position.tokenMint, pnlPercent: pnlPercent.toFixed(2) },
        '[pump.fun] Stop loss triggered',
      );
      await this.executeSell(position, currentValueSol, pnlPercent, 'stop_loss', `SL hit: ${pnlPercent.toFixed(2)}%`);
      return;
    }

    // Check max hold duration
    if (this.config.maxHoldDurationMs && this.config.maxHoldDurationMs > 0) {
      const holdDuration = Date.now() - position.entryTimestamp;
      if (holdDuration >= this.config.maxHoldDurationMs) {
        logger.info(
          { mint: position.tokenMint, holdDurationMs: holdDuration },
          '[pump.fun] Max hold duration triggered',
        );
        await this.executeSell(position, currentValueSol, pnlPercent, 'time_exit', `Time exit after ${Math.floor(holdDuration / 1000)}s`);
        return;
      }
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
    const mint = new PublicKey(position.tokenMint);
    const bondingCurve = new PublicKey(position.bondingCurve);

    // Determine token program ID based on token type
    const tokenProgramId = position.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    // Emit trigger event before executing
    const triggerEvent: PumpFunTriggerEvent = {
      type: triggerType,
      position,
      currentValueSol,
      pnlPercent,
      reason,
    };
    this.emit('trigger', triggerEvent);

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
      this.finalizeSell(position, sellResult.signature || '', actualSolReceived, actualPnlPercent, reason);
    } else {
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

    logger.info(
      {
        mint: position.tokenMint,
        entrySol: position.entryAmountSol,
        exitSol: exitValueSol,
        pnlPercent: pnlPercent.toFixed(2) + '%',
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
  } {
    let totalEntryValue = 0;
    let totalCurrentValue = 0;

    for (const position of this.positions.values()) {
      totalEntryValue += position.entryAmountSol;
      // Use lastCurrentValueSol if available, otherwise fall back to entry value
      totalCurrentValue += position.lastCurrentValueSol ?? position.entryAmountSol;
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
