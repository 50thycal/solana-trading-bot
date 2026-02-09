/**
 * A/B Test Store - SQLite Persistence
 *
 * Dedicated database (data/ab-test.db) for A/B test sessions, trades,
 * and pipeline decisions. Separate from production bot.db.
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../helpers';
import {
  ABTestConfig,
  ABTradeResult,
  ABPipelineDecision,
  ABVariantConfig,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = `
  -- Session metadata
  CREATE TABLE IF NOT EXISTS ab_sessions (
    session_id TEXT PRIMARY KEY,
    description TEXT,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    duration_ms INTEGER NOT NULL,
    config_a TEXT NOT NULL,
    config_b TEXT NOT NULL,
    total_tokens_detected INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running'
  );

  -- Individual trade results
  CREATE TABLE IF NOT EXISTS ab_trades (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    entry_timestamp INTEGER NOT NULL,
    hypothetical_sol_spent REAL NOT NULL,
    hypothetical_tokens_received REAL NOT NULL,
    entry_price_per_token REAL NOT NULL,
    pipeline_duration_ms INTEGER NOT NULL,
    exit_timestamp INTEGER,
    exit_reason TEXT,
    exit_price_per_token REAL,
    exit_sol_received REAL,
    realized_pnl_sol REAL,
    realized_pnl_percent REAL,
    hold_duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    FOREIGN KEY (session_id) REFERENCES ab_sessions(session_id)
  );

  -- Pipeline decisions (every token, pass or fail)
  CREATE TABLE IF NOT EXISTS ab_pipeline_decisions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    variant TEXT NOT NULL,
    token_mint TEXT NOT NULL,
    token_name TEXT,
    token_symbol TEXT,
    timestamp INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    rejection_stage TEXT,
    rejection_reason TEXT,
    pipeline_duration_ms INTEGER,
    FOREIGN KEY (session_id) REFERENCES ab_sessions(session_id)
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_ab_trades_session ON ab_trades(session_id, variant);
  CREATE INDEX IF NOT EXISTS idx_ab_trades_status ON ab_trades(status);
  CREATE INDEX IF NOT EXISTS idx_ab_decisions_session ON ab_pipeline_decisions(session_id, variant);
  CREATE INDEX IF NOT EXISTS idx_ab_sessions_status ON ab_sessions(status);
`;

// ═══════════════════════════════════════════════════════════════════════════════
// AB TEST STORE
// ═══════════════════════════════════════════════════════════════════════════════

export class ABTestStore {
  private db: DatabaseType;
  private closed = false;

  constructor(dataDir: string) {
    const dbPath = path.join(dataDir, 'ab-test.db');

    // Ensure directory exists
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);

    logger.info({ dbPath }, '[ab-store] Initialized');
  }

  // ── Session Operations ───────────────────────────────────────────────────

  createSession(config: ABTestConfig): void {
    this.db.prepare(`
      INSERT INTO ab_sessions (session_id, description, started_at, duration_ms, config_a, config_b, status)
      VALUES (?, ?, ?, ?, ?, ?, 'running')
    `).run(
      config.sessionId,
      config.description ?? null,
      config.startedAt,
      config.durationMs,
      JSON.stringify(config.variantA),
      JSON.stringify(config.variantB),
    );
  }

  completeSession(sessionId: string, totalTokensDetected: number): void {
    this.db.prepare(`
      UPDATE ab_sessions
      SET status = 'completed', completed_at = ?, total_tokens_detected = ?
      WHERE session_id = ?
    `).run(Date.now(), totalTokensDetected, sessionId);
  }

  getSession(sessionId: string): {
    sessionId: string;
    description?: string;
    startedAt: number;
    completedAt?: number;
    durationMs: number;
    configA: ABVariantConfig;
    configB: ABVariantConfig;
    totalTokensDetected: number;
    status: string;
  } | null {
    const row = this.db.prepare(
      'SELECT * FROM ab_sessions WHERE session_id = ?'
    ).get(sessionId) as any;

    if (!row) return null;

    return {
      sessionId: row.session_id,
      description: row.description ?? undefined,
      startedAt: row.started_at,
      completedAt: row.completed_at ?? undefined,
      durationMs: row.duration_ms,
      configA: JSON.parse(row.config_a),
      configB: JSON.parse(row.config_b),
      totalTokensDetected: row.total_tokens_detected || 0,
      status: row.status,
    };
  }

  getAllSessions(): Array<{
    sessionId: string;
    startedAt: number;
    status: string;
    totalTokensDetected: number;
  }> {
    const rows = this.db.prepare(
      'SELECT session_id, started_at, status, total_tokens_detected FROM ab_sessions ORDER BY started_at DESC'
    ).all() as any[];

    return rows.map(row => ({
      sessionId: row.session_id,
      startedAt: row.started_at,
      status: row.status,
      totalTokensDetected: row.total_tokens_detected || 0,
    }));
  }

  // ── Pipeline Decision Operations ─────────────────────────────────────────

  recordPipelineDecision(decision: Omit<ABPipelineDecision, 'id'>): void {
    if (this.closed) return;
    const id = `abd_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO ab_pipeline_decisions (id, session_id, variant, token_mint, token_name, token_symbol, timestamp, passed, rejection_stage, rejection_reason, pipeline_duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      decision.sessionId,
      decision.variant,
      decision.tokenMint,
      decision.tokenName ?? null,
      decision.tokenSymbol ?? null,
      decision.timestamp,
      decision.passed ? 1 : 0,
      decision.rejectionStage ?? null,
      decision.rejectionReason ?? null,
      decision.pipelineDurationMs,
    );
  }

  getPipelineDecisions(sessionId: string, variant?: 'A' | 'B'): ABPipelineDecision[] {
    let sql = 'SELECT * FROM ab_pipeline_decisions WHERE session_id = ?';
    const params: any[] = [sessionId];

    if (variant) {
      sql += ' AND variant = ?';
      params.push(variant);
    }

    sql += ' ORDER BY timestamp ASC';

    const rows = this.db.prepare(sql).all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      variant: row.variant as 'A' | 'B',
      tokenMint: row.token_mint,
      tokenName: row.token_name ?? undefined,
      tokenSymbol: row.token_symbol ?? undefined,
      timestamp: row.timestamp,
      passed: row.passed === 1,
      rejectionStage: row.rejection_stage ?? undefined,
      rejectionReason: row.rejection_reason ?? undefined,
      pipelineDurationMs: row.pipeline_duration_ms,
    }));
  }

  // ── Trade Operations ─────────────────────────────────────────────────────

  recordTradeEntry(trade: Omit<ABTradeResult, 'id' | 'status'>): string {
    if (this.closed) return '';
    const id = `abt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.db.prepare(`
      INSERT INTO ab_trades (id, session_id, variant, token_mint, token_name, token_symbol, entry_timestamp, hypothetical_sol_spent, hypothetical_tokens_received, entry_price_per_token, pipeline_duration_ms, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(
      id,
      trade.sessionId,
      trade.variant,
      trade.tokenMint,
      trade.tokenName ?? null,
      trade.tokenSymbol ?? null,
      trade.entryTimestamp,
      trade.hypotheticalSolSpent,
      trade.hypotheticalTokensReceived,
      trade.entryPricePerToken,
      trade.pipelineDurationMs,
    );
    return id;
  }

  recordTradeExit(tradeId: string | null, exitData: {
    exitTimestamp: number;
    exitReason: string;
    exitPricePerToken: number;
    exitSolReceived: number;
    realizedPnlSol: number;
    realizedPnlPercent: number;
    holdDurationMs: number;
  }): void {
    if (this.closed || !tradeId) return;
    this.db.prepare(`
      UPDATE ab_trades
      SET status = 'closed',
          exit_timestamp = ?,
          exit_reason = ?,
          exit_price_per_token = ?,
          exit_sol_received = ?,
          realized_pnl_sol = ?,
          realized_pnl_percent = ?,
          hold_duration_ms = ?
      WHERE id = ?
    `).run(
      exitData.exitTimestamp,
      exitData.exitReason,
      exitData.exitPricePerToken,
      exitData.exitSolReceived,
      exitData.realizedPnlSol,
      exitData.realizedPnlPercent,
      exitData.holdDurationMs,
      tradeId,
    );
  }

  getSessionTrades(sessionId: string, variant?: 'A' | 'B'): ABTradeResult[] {
    let sql = 'SELECT * FROM ab_trades WHERE session_id = ?';
    const params: any[] = [sessionId];

    if (variant) {
      sql += ' AND variant = ?';
      params.push(variant);
    }

    sql += ' ORDER BY entry_timestamp ASC';

    const rows = this.db.prepare(sql).all(...params) as any[];

    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      variant: row.variant as 'A' | 'B',
      tokenMint: row.token_mint,
      tokenName: row.token_name ?? undefined,
      tokenSymbol: row.token_symbol ?? undefined,
      entryTimestamp: row.entry_timestamp,
      hypotheticalSolSpent: row.hypothetical_sol_spent,
      hypotheticalTokensReceived: row.hypothetical_tokens_received,
      entryPricePerToken: row.entry_price_per_token,
      pipelineDurationMs: row.pipeline_duration_ms,
      exitTimestamp: row.exit_timestamp ?? undefined,
      exitReason: row.exit_reason ?? undefined,
      exitPricePerToken: row.exit_price_per_token ?? undefined,
      exitSolReceived: row.exit_sol_received ?? undefined,
      realizedPnlSol: row.realized_pnl_sol ?? undefined,
      realizedPnlPercent: row.realized_pnl_percent ?? undefined,
      holdDurationMs: row.hold_duration_ms ?? undefined,
      status: row.status as 'active' | 'closed',
    }));
  }

  /** Find the AB trade ID for a given session+variant+mint (for linking paper tracker closes) */
  findActiveTradeId(sessionId: string, variant: 'A' | 'B', tokenMint: string): string | null {
    const row = this.db.prepare(
      "SELECT id FROM ab_trades WHERE session_id = ? AND variant = ? AND token_mint = ? AND status = 'active' LIMIT 1"
    ).get(sessionId, variant, tokenMint) as any;

    return row?.id ?? null;
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────

  close(): void {
    this.closed = true;
    this.db.close();
  }
}
