import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { logger } from '../helpers';
import { getConfig } from '../helpers/config-validator';

/**
 * Represents an open position for exposure tracking
 */
export interface OpenPosition {
  tokenMint: string;
  entryAmountSol: number;
  currentValueSol: number;
  entryTimestamp: number;
  poolId: string;
}

/**
 * Trade timestamp for hourly rate limiting
 */
interface TradeTimestamp {
  timestamp: number;
}

/**
 * Result of exposure check
 */
export interface ExposureCheckResult {
  allowed: boolean;
  reason?: string;
  currentExposure?: number;
  maxExposure?: number;
  tradesThisHour?: number;
  maxTradesPerHour?: number;
  walletBalance?: number;
  requiredBalance?: number;
}

/**
 * Exposure Manager configuration
 */
export interface ExposureManagerConfig {
  maxTotalExposureSol: number;
  maxTradesPerHour: number;
  minWalletBufferSol: number;
}

/**
 * Manages risk exposure including:
 * - Total deployed SOL across open positions
 * - Hourly trade rate limiting
 * - Wallet balance guard
 */
export class ExposureManager {
  private positions: Map<string, OpenPosition> = new Map();
  private tradeTimestamps: TradeTimestamp[] = [];
  private config: ExposureManagerConfig;
  private connection: Connection;
  private walletPublicKey: PublicKey;

  constructor(
    connection: Connection,
    walletPublicKey: PublicKey,
    config: ExposureManagerConfig,
  ) {
    this.connection = connection;
    this.walletPublicKey = walletPublicKey;
    this.config = config;

    logger.info(
      {
        maxTotalExposureSol: config.maxTotalExposureSol,
        maxTradesPerHour: config.maxTradesPerHour,
        minWalletBufferSol: config.minWalletBufferSol,
      },
      'Exposure manager initialized',
    );
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(config: Partial<ExposureManagerConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Exposure manager config updated');
  }

  /**
   * Add or update a position
   */
  addPosition(position: OpenPosition): void {
    this.positions.set(position.tokenMint, position);
    logger.debug(
      {
        tokenMint: position.tokenMint,
        entryAmountSol: position.entryAmountSol,
        totalPositions: this.positions.size,
      },
      'Position added to exposure tracking',
    );
  }

  /**
   * Update position value (for current value tracking)
   */
  updatePositionValue(tokenMint: string, currentValueSol: number): void {
    const position = this.positions.get(tokenMint);
    if (position) {
      position.currentValueSol = currentValueSol;
    }
  }

  /**
   * Remove a position (after sell)
   */
  removePosition(tokenMint: string): void {
    this.positions.delete(tokenMint);
    logger.debug(
      {
        tokenMint,
        totalPositions: this.positions.size,
      },
      'Position removed from exposure tracking',
    );
  }

  /**
   * Check if a position exists
   */
  hasPosition(tokenMint: string): boolean {
    return this.positions.has(tokenMint);
  }

  /**
   * Get a position by token mint
   */
  getPosition(tokenMint: string): OpenPosition | undefined {
    return this.positions.get(tokenMint);
  }

  /**
   * Get all open positions
   */
  getAllPositions(): OpenPosition[] {
    return Array.from(this.positions.values());
  }

  /**
   * Record a trade for rate limiting
   */
  recordTrade(): void {
    this.tradeTimestamps.push({ timestamp: Date.now() });
    this.cleanupOldTimestamps();
  }

  /**
   * Remove trade timestamps older than 1 hour
   */
  private cleanupOldTimestamps(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.tradeTimestamps = this.tradeTimestamps.filter(
      (t) => t.timestamp > oneHourAgo,
    );
  }

  /**
   * Get trades in the last hour
   */
  getTradesThisHour(): number {
    this.cleanupOldTimestamps();
    return this.tradeTimestamps.length;
  }

  /**
   * Calculate total current exposure (sum of current values of all positions)
   */
  getTotalExposure(): number {
    let total = 0;
    for (const position of this.positions.values()) {
      // Use current value if available, otherwise entry amount
      total += position.currentValueSol || position.entryAmountSol;
    }
    return total;
  }

  /**
   * Get wallet SOL balance
   */
  async getWalletBalance(): Promise<number> {
    try {
      const balance = await this.connection.getBalance(this.walletPublicKey);
      return balance / LAMPORTS_PER_SOL;
    } catch (error) {
      logger.error({ error }, 'Failed to get wallet balance');
      return 0;
    }
  }

  /**
   * Check if a new trade is allowed based on all risk controls
   */
  async canTrade(tradeAmountSol: number): Promise<ExposureCheckResult> {
    // Check 1: Exposure limit
    const currentExposure = this.getTotalExposure();
    const newExposure = currentExposure + tradeAmountSol;

    if (newExposure > this.config.maxTotalExposureSol) {
      return {
        allowed: false,
        reason: `Exposure limit exceeded: ${newExposure.toFixed(4)} SOL would exceed max ${this.config.maxTotalExposureSol} SOL`,
        currentExposure,
        maxExposure: this.config.maxTotalExposureSol,
      };
    }

    // Check 2: Hourly trade limit
    const tradesThisHour = this.getTradesThisHour();
    if (tradesThisHour >= this.config.maxTradesPerHour) {
      return {
        allowed: false,
        reason: `Hourly trade limit reached: ${tradesThisHour}/${this.config.maxTradesPerHour} trades`,
        tradesThisHour,
        maxTradesPerHour: this.config.maxTradesPerHour,
      };
    }

    // Check 3: Wallet balance (with buffer)
    const walletBalance = await this.getWalletBalance();
    const requiredBalance = tradeAmountSol + this.config.minWalletBufferSol;

    if (walletBalance < requiredBalance) {
      return {
        allowed: false,
        reason: `Insufficient balance: ${walletBalance.toFixed(4)} SOL, need ${requiredBalance.toFixed(4)} SOL (${tradeAmountSol} trade + ${this.config.minWalletBufferSol} buffer)`,
        walletBalance,
        requiredBalance,
      };
    }

    return {
      allowed: true,
      currentExposure,
      maxExposure: this.config.maxTotalExposureSol,
      tradesThisHour,
      maxTradesPerHour: this.config.maxTradesPerHour,
      walletBalance,
      requiredBalance,
    };
  }

  /**
   * Get current exposure statistics
   */
  getStats(): {
    totalExposure: number;
    maxExposure: number;
    positionCount: number;
    tradesThisHour: number;
    maxTradesPerHour: number;
    exposureUtilization: number;
  } {
    const totalExposure = this.getTotalExposure();
    return {
      totalExposure,
      maxExposure: this.config.maxTotalExposureSol,
      positionCount: this.positions.size,
      tradesThisHour: this.getTradesThisHour(),
      maxTradesPerHour: this.config.maxTradesPerHour,
      exposureUtilization:
        this.config.maxTotalExposureSol > 0
          ? (totalExposure / this.config.maxTotalExposureSol) * 100
          : 0,
    };
  }

  /**
   * Log current exposure status
   */
  logStatus(): void {
    const stats = this.getStats();
    logger.info(
      {
        totalExposure: `${stats.totalExposure.toFixed(4)} SOL`,
        maxExposure: `${stats.maxExposure} SOL`,
        utilization: `${stats.exposureUtilization.toFixed(1)}%`,
        positions: stats.positionCount,
        tradesThisHour: `${stats.tradesThisHour}/${stats.maxTradesPerHour}`,
      },
      'Exposure status',
    );
  }
}

/**
 * Singleton instance
 */
let exposureManagerInstance: ExposureManager | null = null;

/**
 * Initialize the exposure manager singleton
 */
export function initExposureManager(
  connection: Connection,
  walletPublicKey: PublicKey,
  config: ExposureManagerConfig,
): ExposureManager {
  exposureManagerInstance = new ExposureManager(connection, walletPublicKey, config);
  return exposureManagerInstance;
}

/**
 * Get the exposure manager instance
 */
export function getExposureManager(): ExposureManager | null {
  return exposureManagerInstance;
}
