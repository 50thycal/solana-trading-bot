/**
 * Phase 3: Persistence Layer - SQLite State Store
 *
 * Provides persistent storage for positions, trades, seen pools, and blacklist.
 * Uses better-sqlite3 for synchronous, high-performance SQLite access.
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../helpers';
import { getConfig } from '../helpers/config-validator';
import {
  PositionRecord,
  TradeRecord,
  SeenPoolRecord,
  BlacklistRecord,
  CreatePositionInput,
  RecordTradeIntentInput,
  ConfirmTradeInput,
  FailTradeInput,
  RecordSeenPoolInput,
  AddBlacklistInput,
  PENDING_TRADE_TIMEOUT_MS,
  TradeStatus,
  PositionStatus,
  BlacklistType,
  PoolAction,
} from './models';

/**
 * Current schema version - increment when making schema changes
 */
const CURRENT_SCHEMA_VERSION = 1;

/**
 * SQLite State Store - manages all persistent data
 */
export class StateStore {
  private db: DatabaseType;
  private dbPath: string;
  private initialized: boolean = false;

  constructor() {
    const config = getConfig();
    this.dbPath = path.join(config.dataDir, 'bot.db');

    // Ensure data directory exists with proper permissions
    const dir = path.dirname(this.dbPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        logger.info({ dir }, 'Created data directory');
      }

      // Verify directory is writable
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (error) {
      logger.error({ dir, error }, 'Data directory is not writable. Check permissions or volume mount.');
      throw new Error(`Cannot write to data directory: ${dir}. Ensure the directory exists and is writable.`);
    }

    // Initialize database connection
    try {
      this.db = new Database(this.dbPath);
    } catch (error) {
      logger.error({ dbPath: this.dbPath, error }, 'Failed to open SQLite database');
      throw error;
    }

    // Enable WAL mode for better concurrent read performance
    this.db.pragma('journal_mode = WAL');

    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
  }

  /**
   * Initialize the database with schema migrations
   */
  init(): void {
    if (this.initialized) {
      return;
    }

    try {
      this.runMigrations();
      this.cleanupPendingTrades();
      this.initialized = true;

      logger.info({ dbPath: this.dbPath }, 'State store initialized');
    } catch (error) {
      logger.error({ error, dbPath: this.dbPath }, 'Failed to initialize state store');
      throw error;
    }
  }

  /**
   * Run database migrations
   */
  private runMigrations(): void {
    // Create schema_version table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    // Get current version
    const versionRow = this.db.prepare(
      'SELECT MAX(version) as version FROM schema_version'
    ).get() as { version: number | null };

    const currentVersion = versionRow?.version || 0;

    if (currentVersion < CURRENT_SCHEMA_VERSION) {
      logger.info(
        { currentVersion, targetVersion: CURRENT_SCHEMA_VERSION },
        'Running database migrations'
      );

      // Run migrations in order
      if (currentVersion < 1) {
        this.migrateToV1();
      }

      logger.info({ version: CURRENT_SCHEMA_VERSION }, 'Database migrations complete');
    }
  }

  /**
   * Migration to version 1 - Initial schema
   */
  private migrateToV1(): void {
    this.db.exec(`
      -- Positions table
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY,
        token_mint TEXT UNIQUE NOT NULL,
        entry_price REAL NOT NULL,
        amount_token REAL NOT NULL,
        amount_sol REAL NOT NULL,
        entry_timestamp INTEGER NOT NULL,
        pool_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        closed_timestamp INTEGER,
        closed_reason TEXT,
        take_profit_sol REAL,
        stop_loss_sol REAL,
        last_price_sol REAL,
        last_check_timestamp INTEGER
      );

      -- Trades table
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        position_id TEXT,
        type TEXT NOT NULL,
        token_mint TEXT NOT NULL,
        amount_sol REAL NOT NULL,
        amount_token REAL NOT NULL,
        price REAL NOT NULL,
        timestamp INTEGER NOT NULL,
        tx_signature TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        pool_id TEXT NOT NULL,
        intent_timestamp INTEGER,
        confirmed_timestamp INTEGER,
        error_message TEXT,
        FOREIGN KEY (position_id) REFERENCES positions(id)
      );

      -- Seen pools table
      CREATE TABLE IF NOT EXISTS seen_pools (
        pool_id TEXT PRIMARY KEY,
        token_mint TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        action_taken TEXT NOT NULL,
        filter_reason TEXT
      );

      -- Blacklist table
      CREATE TABLE IF NOT EXISTS blacklist (
        address TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        reason TEXT,
        added_timestamp INTEGER NOT NULL
      );

      -- Session stats table
      CREATE TABLE IF NOT EXISTS session_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        total_buys INTEGER NOT NULL DEFAULT 0,
        total_sells INTEGER NOT NULL DEFAULT 0,
        realized_pnl_sol REAL NOT NULL DEFAULT 0
      );

      -- Create indexes for common queries
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_token_mint ON positions(token_mint);
      CREATE INDEX IF NOT EXISTS idx_trades_token_mint ON trades(token_mint);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
      CREATE INDEX IF NOT EXISTS idx_seen_pools_token_mint ON seen_pools(token_mint);
      CREATE INDEX IF NOT EXISTS idx_blacklist_type ON blacklist(type);

      -- Record migration
      INSERT INTO schema_version (version, applied_at) VALUES (1, ${Date.now()});
    `);

    logger.info('Applied migration v1: Initial schema');
  }

  /**
   * Clean up stale pending trades on startup
   */
  private cleanupPendingTrades(): void {
    const cutoffTime = Date.now() - PENDING_TRADE_TIMEOUT_MS;

    const result = this.db.prepare(`
      UPDATE trades
      SET status = 'failed', error_message = 'Timed out on startup recovery'
      WHERE status = 'pending' AND intent_timestamp < ?
    `).run(cutoffTime);

    if (result.changes > 0) {
      logger.info(
        { count: result.changes },
        'Marked stale pending trades as failed'
      );
    }
  }

  // ============================================================
  // POSITION OPERATIONS
  // ============================================================

  /**
   * Create a new position
   */
  createPosition(input: CreatePositionInput): PositionRecord {
    const id = `pos_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();

    const position: PositionRecord = {
      id,
      tokenMint: input.tokenMint,
      entryPrice: input.entryPrice,
      amountToken: input.amountToken,
      amountSol: input.amountSol,
      entryTimestamp: now,
      poolId: input.poolId,
      status: 'open',
      takeProfitSol: input.takeProfitSol,
      stopLossSol: input.stopLossSol,
      lastPriceSol: input.amountSol,
      lastCheckTimestamp: now,
    };

    this.db.prepare(`
      INSERT INTO positions (
        id, token_mint, entry_price, amount_token, amount_sol,
        entry_timestamp, pool_id, status, take_profit_sol, stop_loss_sol,
        last_price_sol, last_check_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      position.id,
      position.tokenMint,
      position.entryPrice,
      position.amountToken,
      position.amountSol,
      position.entryTimestamp,
      position.poolId,
      position.status,
      position.takeProfitSol ?? null,
      position.stopLossSol ?? null,
      position.lastPriceSol ?? null,
      position.lastCheckTimestamp ?? null
    );

    logger.debug({ positionId: id, tokenMint: input.tokenMint }, 'Position created');
    return position;
  }

  /**
   * Get a position by token mint
   */
  getPositionByMint(tokenMint: string): PositionRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM positions WHERE token_mint = ? AND status = ?'
    ).get(tokenMint, 'open');

    return row ? this.rowToPosition(row) : null;
  }

  /**
   * Get a position by ID
   */
  getPositionById(id: string): PositionRecord | null {
    const row = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
    return row ? this.rowToPosition(row) : null;
  }

  /**
   * Get all open positions
   */
  getOpenPositions(): PositionRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM positions WHERE status = ?'
    ).all('open');

    return rows.map((row) => this.rowToPosition(row));
  }

  /**
   * Update position price data
   */
  updatePositionPrice(tokenMint: string, lastPriceSol: number): void {
    this.db.prepare(`
      UPDATE positions
      SET last_price_sol = ?, last_check_timestamp = ?
      WHERE token_mint = ? AND status = 'open'
    `).run(lastPriceSol, Date.now(), tokenMint);
  }

  /**
   * Update position token amount (after actual balance is known)
   */
  updatePositionTokenAmount(tokenMint: string, amountToken: number): void {
    this.db.prepare(`
      UPDATE positions
      SET amount_token = ?
      WHERE token_mint = ? AND status = 'open'
    `).run(amountToken, tokenMint);
  }

  /**
   * Close a position
   */
  closePosition(tokenMint: string, reason: string): void {
    this.db.prepare(`
      UPDATE positions
      SET status = 'closed', closed_timestamp = ?, closed_reason = ?
      WHERE token_mint = ? AND status = 'open'
    `).run(Date.now(), reason, tokenMint);

    logger.debug({ tokenMint, reason }, 'Position closed');
  }

  /**
   * Check if position exists for token
   */
  hasOpenPosition(tokenMint: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM positions WHERE token_mint = ? AND status = ?'
    ).get(tokenMint, 'open');

    return row !== undefined;
  }

  /**
   * Convert database row to PositionRecord
   */
  private rowToPosition(row: any): PositionRecord {
    return {
      id: row.id,
      tokenMint: row.token_mint,
      entryPrice: row.entry_price,
      amountToken: row.amount_token,
      amountSol: row.amount_sol,
      entryTimestamp: row.entry_timestamp,
      poolId: row.pool_id,
      status: row.status as PositionStatus,
      closedTimestamp: row.closed_timestamp ?? undefined,
      closedReason: row.closed_reason ?? undefined,
      takeProfitSol: row.take_profit_sol ?? undefined,
      stopLossSol: row.stop_loss_sol ?? undefined,
      lastPriceSol: row.last_price_sol ?? undefined,
      lastCheckTimestamp: row.last_check_timestamp ?? undefined,
    };
  }

  // ============================================================
  // TRADE OPERATIONS
  // ============================================================

  /**
   * Record trade intent BEFORE executing (for idempotency)
   */
  recordTradeIntent(input: RecordTradeIntentInput): TradeRecord {
    const id = `trade_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const now = Date.now();
    const price = input.amountToken > 0 ? input.amountSol / input.amountToken : 0;

    const trade: TradeRecord = {
      id,
      positionId: input.positionId,
      type: input.type,
      tokenMint: input.tokenMint,
      amountSol: input.amountSol,
      amountToken: input.amountToken,
      price,
      timestamp: now,
      status: 'pending',
      poolId: input.poolId,
      intentTimestamp: now,
    };

    this.db.prepare(`
      INSERT INTO trades (
        id, position_id, type, token_mint, amount_sol, amount_token,
        price, timestamp, status, pool_id, intent_timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trade.id,
      trade.positionId ?? null,
      trade.type,
      trade.tokenMint,
      trade.amountSol,
      trade.amountToken,
      trade.price,
      trade.timestamp,
      trade.status,
      trade.poolId,
      trade.intentTimestamp ?? null
    );

    logger.debug({ tradeId: id, type: input.type, tokenMint: input.tokenMint }, 'Trade intent recorded');
    return trade;
  }

  /**
   * Confirm a trade after successful execution
   */
  confirmTrade(input: ConfirmTradeInput): void {
    const now = Date.now();

    // Build update based on what's provided
    if (input.actualAmountSol !== undefined && input.actualAmountToken !== undefined) {
      const price = input.actualAmountToken > 0
        ? input.actualAmountSol / input.actualAmountToken
        : 0;

      this.db.prepare(`
        UPDATE trades
        SET status = 'confirmed',
            tx_signature = ?,
            confirmed_timestamp = ?,
            amount_sol = ?,
            amount_token = ?,
            price = ?
        WHERE id = ?
      `).run(input.txSignature, now, input.actualAmountSol, input.actualAmountToken, price, input.tradeId);
    } else {
      this.db.prepare(`
        UPDATE trades
        SET status = 'confirmed', tx_signature = ?, confirmed_timestamp = ?
        WHERE id = ?
      `).run(input.txSignature, now, input.tradeId);
    }

    logger.debug({ tradeId: input.tradeId, txSignature: input.txSignature }, 'Trade confirmed');
  }

  /**
   * Mark a trade as failed
   */
  failTrade(input: FailTradeInput): void {
    this.db.prepare(`
      UPDATE trades
      SET status = 'failed', error_message = ?
      WHERE id = ?
    `).run(input.errorMessage, input.tradeId);

    logger.debug({ tradeId: input.tradeId, error: input.errorMessage }, 'Trade failed');
  }

  /**
   * Get pending trade for a token (to prevent duplicates)
   */
  getPendingTradeForToken(tokenMint: string, type: 'buy' | 'sell'): TradeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM trades
      WHERE token_mint = ? AND type = ? AND status = 'pending'
      ORDER BY intent_timestamp DESC
      LIMIT 1
    `).get(tokenMint, type);

    return row ? this.rowToTrade(row) : null;
  }

  /**
   * Get all trades for a token
   */
  getTradesForToken(tokenMint: string): TradeRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM trades WHERE token_mint = ? ORDER BY timestamp DESC'
    ).all(tokenMint);

    return rows.map((row) => this.rowToTrade(row));
  }

  /**
   * Get recent confirmed trades
   */
  getRecentTrades(limit: number = 50): TradeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM trades
      WHERE status = 'confirmed'
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit);

    return rows.map((row) => this.rowToTrade(row));
  }

  /**
   * Get all confirmed trades
   */
  getAllConfirmedTrades(): TradeRecord[] {
    const rows = this.db.prepare(
      "SELECT * FROM trades WHERE status = 'confirmed' ORDER BY timestamp ASC"
    ).all();

    return rows.map((row) => this.rowToTrade(row));
  }

  /**
   * Get trade statistics
   */
  getTradeStats(): { totalBuys: number; totalSells: number; realizedPnlSol: number } {
    const stats = this.db.prepare(`
      SELECT
        SUM(CASE WHEN type = 'buy' THEN 1 ELSE 0 END) as total_buys,
        SUM(CASE WHEN type = 'sell' THEN 1 ELSE 0 END) as total_sells
      FROM trades
      WHERE status = 'confirmed'
    `).get() as { total_buys: number; total_sells: number };

    // Calculate realized P&L from confirmed sell trades
    const sellTrades = this.db.prepare(`
      SELECT t.*, p.amount_sol as entry_amount_sol
      FROM trades t
      LEFT JOIN positions p ON t.position_id = p.id
      WHERE t.type = 'sell' AND t.status = 'confirmed'
    `).all() as any[];

    let realizedPnlSol = 0;
    for (const sell of sellTrades) {
      if (sell.entry_amount_sol) {
        realizedPnlSol += sell.amount_sol - sell.entry_amount_sol;
      }
    }

    return {
      totalBuys: stats.total_buys || 0,
      totalSells: stats.total_sells || 0,
      realizedPnlSol,
    };
  }

  /**
   * Convert database row to TradeRecord
   */
  private rowToTrade(row: any): TradeRecord {
    return {
      id: row.id,
      positionId: row.position_id ?? undefined,
      type: row.type as 'buy' | 'sell',
      tokenMint: row.token_mint,
      amountSol: row.amount_sol,
      amountToken: row.amount_token,
      price: row.price,
      timestamp: row.timestamp,
      txSignature: row.tx_signature ?? undefined,
      status: row.status as TradeStatus,
      poolId: row.pool_id,
      intentTimestamp: row.intent_timestamp ?? undefined,
      confirmedTimestamp: row.confirmed_timestamp ?? undefined,
      errorMessage: row.error_message ?? undefined,
    };
  }

  // ============================================================
  // SEEN POOLS OPERATIONS
  // ============================================================

  /**
   * Record a seen pool
   */
  recordSeenPool(input: RecordSeenPoolInput): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO seen_pools (pool_id, token_mint, first_seen, action_taken, filter_reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.poolId,
      input.tokenMint,
      Date.now(),
      input.actionTaken,
      input.filterReason ?? null
    );
  }

  /**
   * Check if pool has been seen
   */
  hasSeenPool(poolId: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM seen_pools WHERE pool_id = ?').get(poolId);
    return row !== undefined;
  }

  /**
   * Check if token mint has been seen (in any pool)
   */
  hasSeenTokenMint(tokenMint: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM seen_pools WHERE token_mint = ?').get(tokenMint);
    return row !== undefined;
  }

  /**
   * Get seen pool record
   */
  getSeenPool(poolId: string): SeenPoolRecord | null {
    const row = this.db.prepare('SELECT * FROM seen_pools WHERE pool_id = ?').get(poolId);
    return row ? this.rowToSeenPool(row) : null;
  }

  /**
   * Get count of seen pools
   */
  getSeenPoolCount(): number {
    const result = this.db.prepare('SELECT COUNT(*) as count FROM seen_pools').get() as { count: number };
    return result.count;
  }

  /**
   * Clean up old seen pools (optional, for memory management)
   */
  cleanupOldSeenPools(daysToKeep: number = 7): number {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM seen_pools WHERE first_seen < ?').run(cutoff);

    if (result.changes > 0) {
      logger.info({ count: result.changes, daysToKeep }, 'Cleaned up old seen pools');
    }

    return result.changes;
  }

  /**
   * Convert database row to SeenPoolRecord
   */
  private rowToSeenPool(row: any): SeenPoolRecord {
    return {
      poolId: row.pool_id,
      tokenMint: row.token_mint,
      firstSeen: row.first_seen,
      actionTaken: row.action_taken as PoolAction,
      filterReason: row.filter_reason ?? undefined,
    };
  }

  // ============================================================
  // BLACKLIST OPERATIONS
  // ============================================================

  /**
   * Add address to blacklist
   */
  addToBlacklist(input: AddBlacklistInput): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO blacklist (address, type, reason, added_timestamp)
      VALUES (?, ?, ?, ?)
    `).run(input.address, input.type, input.reason ?? null, Date.now());

    logger.info({ address: input.address, type: input.type, reason: input.reason }, 'Added to blacklist');
  }

  /**
   * Remove address from blacklist
   */
  removeFromBlacklist(address: string): boolean {
    const result = this.db.prepare('DELETE FROM blacklist WHERE address = ?').run(address);

    if (result.changes > 0) {
      logger.info({ address }, 'Removed from blacklist');
    }

    return result.changes > 0;
  }

  /**
   * Check if token is blacklisted
   */
  isTokenBlacklisted(tokenMint: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM blacklist WHERE address = ? AND type = 'token'"
    ).get(tokenMint);
    return row !== undefined;
  }

  /**
   * Check if creator is blacklisted
   */
  isCreatorBlacklisted(creatorAddress: string): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM blacklist WHERE address = ? AND type = 'creator'"
    ).get(creatorAddress);
    return row !== undefined;
  }

  /**
   * Get all blacklisted tokens
   */
  getBlacklistedTokens(): string[] {
    const rows = this.db.prepare(
      "SELECT address FROM blacklist WHERE type = 'token'"
    ).all() as { address: string }[];
    return rows.map((r) => r.address);
  }

  /**
   * Get all blacklisted creators
   */
  getBlacklistedCreators(): string[] {
    const rows = this.db.prepare(
      "SELECT address FROM blacklist WHERE type = 'creator'"
    ).all() as { address: string }[];
    return rows.map((r) => r.address);
  }

  /**
   * Get blacklist statistics
   */
  getBlacklistStats(): { tokens: number; creators: number } {
    const stats = this.db.prepare(`
      SELECT
        SUM(CASE WHEN type = 'token' THEN 1 ELSE 0 END) as tokens,
        SUM(CASE WHEN type = 'creator' THEN 1 ELSE 0 END) as creators
      FROM blacklist
    `).get() as { tokens: number; creators: number };

    return {
      tokens: stats.tokens || 0,
      creators: stats.creators || 0,
    };
  }

  // ============================================================
  // UTILITY OPERATIONS
  // ============================================================

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      logger.info('State store closed');
    }
  }

  /**
   * Get database file path
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Get database statistics
   */
  getStats(): {
    positions: { open: number; closed: number };
    trades: { pending: number; confirmed: number; failed: number };
    seenPools: number;
    blacklist: { tokens: number; creators: number };
  } {
    const positionStats = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_count,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_count
      FROM positions
    `).get() as { open_count: number; closed_count: number };

    const tradeStats = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending_count,
        SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) as confirmed_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_count
      FROM trades
    `).get() as { pending_count: number; confirmed_count: number; failed_count: number };

    return {
      positions: {
        open: positionStats.open_count || 0,
        closed: positionStats.closed_count || 0,
      },
      trades: {
        pending: tradeStats.pending_count || 0,
        confirmed: tradeStats.confirmed_count || 0,
        failed: tradeStats.failed_count || 0,
      },
      seenPools: this.getSeenPoolCount(),
      blacklist: this.getBlacklistStats(),
    };
  }
}

/**
 * Singleton instance
 */
let stateStoreInstance: StateStore | null = null;

/**
 * Initialize the state store singleton
 * Returns null if initialization fails (bot can continue without persistence)
 */
export function initStateStore(): StateStore | null {
  if (!stateStoreInstance) {
    try {
      stateStoreInstance = new StateStore();
      stateStoreInstance.init();
    } catch (error) {
      logger.warn(
        { error },
        'Failed to initialize SQLite state store. Bot will continue WITHOUT persistence. ' +
        'Data will not survive restarts. To fix: ensure DATA_DIR is writable or configure Railway volume.'
      );
      stateStoreInstance = null;
    }
  }
  return stateStoreInstance;
}

/**
 * Get the state store instance
 */
export function getStateStore(): StateStore | null {
  return stateStoreInstance;
}

/**
 * Close and cleanup the state store
 */
export function closeStateStore(): void {
  if (stateStoreInstance) {
    stateStoreInstance.close();
    stateStoreInstance = null;
  }
}
