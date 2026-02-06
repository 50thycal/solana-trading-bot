/**
 * Trade Audit Module
 *
 * Records and compares intended vs actual trade amounts for every buy and sell.
 * Surfaces mismatches prominently so they can be diagnosed quickly.
 *
 * Design:
 * - In-memory ring buffer (last 200 records) for fast access
 * - Singleton pattern matching the rest of the codebase
 * - Exposes data via getters for the dashboard API
 *
 * @module helpers/trade-audit
 */

import { logger } from './logger';
import { VerificationMethod } from './tx-verifier';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface TradeAuditRecord {
  id: string;
  timestamp: number;
  type: 'buy' | 'sell';
  tokenMint: string;
  tokenSymbol: string;

  // What the config intended
  intendedAmountSol: number;

  // What was encoded in the transaction instruction (lamports)
  instructionAmountLamports: number;

  // On-chain verified results
  actualSolSpent: number | null;       // For buys: pre - post SOL balance (includes gas)
  actualSolReceived: number | null;    // For sells: post - pre SOL balance (adjusted for gas)
  actualTokensReceived: number | null; // For buys
  expectedTokens: number | null;       // From bonding curve math

  // Verification info
  verificationMethod: VerificationMethod | 'none';
  verified: boolean;

  // Computed discrepancies
  solDiscrepancyPercent: number | null;   // (actualSpent - intended) / intended * 100
  tokenSlippagePercent: number | null;    // (actual - expected) / expected * 100
  hasMismatch: boolean;                    // true if |solDiscrepancy| > threshold

  // Transaction details
  signature: string;
  bondingCurve: string;
}

export interface TradeAuditSummary {
  totalAudited: number;
  totalBuys: number;
  totalSells: number;
  mismatches: number;
  avgSolDiscrepancyPercent: number;
  avgTokenSlippagePercent: number;
  lastAuditAt: number | null;
}

export interface RecordBuyAuditParams {
  tokenMint: string;
  tokenSymbol: string;
  intendedAmountSol: number;
  instructionAmountLamports: number;
  actualSolSpent: number | null;
  actualTokensReceived: number | null;
  expectedTokens: number | null;
  verificationMethod: VerificationMethod | 'none';
  verified: boolean;
  tokenSlippagePercent: number | null;
  signature: string;
  bondingCurve: string;
}

export interface RecordSellAuditParams {
  tokenMint: string;
  tokenSymbol: string;
  intendedTokenAmount: number;
  actualSolReceived: number | null;
  expectedSol: number | null;
  verificationMethod: VerificationMethod | 'none';
  verified: boolean;
  solSlippagePercent: number | null;
  signature: string;
  bondingCurve: string;
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const MAX_RECORDS = 200;

// Flag a mismatch if SOL spent differs from intended by more than this %
// Accounts for gas fees (~0.005 SOL max) on small trades
const SOL_MISMATCH_THRESHOLD_PERCENT = 5;

// ════════════════════════════════════════════════════════════════════════════
// TRADE AUDIT MANAGER
// ════════════════════════════════════════════════════════════════════════════

export class TradeAuditManager {
  private records: TradeAuditRecord[] = [];
  private nextId = 1;

  /**
   * Record a buy trade audit
   */
  recordBuy(params: RecordBuyAuditParams): TradeAuditRecord {
    const {
      tokenMint,
      tokenSymbol,
      intendedAmountSol,
      instructionAmountLamports,
      actualSolSpent,
      actualTokensReceived,
      expectedTokens,
      verificationMethod,
      verified,
      tokenSlippagePercent,
      signature,
      bondingCurve,
    } = params;

    // Calculate SOL discrepancy (how much more/less SOL was spent vs intended)
    let solDiscrepancyPercent: number | null = null;
    let hasMismatch = false;

    if (actualSolSpent !== null && intendedAmountSol > 0) {
      solDiscrepancyPercent = ((actualSolSpent - intendedAmountSol) / intendedAmountSol) * 100;
      hasMismatch = Math.abs(solDiscrepancyPercent) > SOL_MISMATCH_THRESHOLD_PERCENT;
    }

    const record: TradeAuditRecord = {
      id: `audit-${this.nextId++}`,
      timestamp: Date.now(),
      type: 'buy',
      tokenMint,
      tokenSymbol,
      intendedAmountSol,
      instructionAmountLamports,
      actualSolSpent,
      actualSolReceived: null,
      actualTokensReceived,
      expectedTokens,
      verificationMethod,
      verified,
      solDiscrepancyPercent,
      tokenSlippagePercent,
      hasMismatch,
      signature,
      bondingCurve,
    };

    this.addRecord(record);

    // Log the audit line
    const solSpentStr = actualSolSpent !== null ? actualSolSpent.toFixed(6) : 'unknown';
    const tokensStr = actualTokensReceived !== null ? actualTokensReceived.toString() : 'unknown';
    const discrepancyStr = solDiscrepancyPercent !== null ? `${solDiscrepancyPercent >= 0 ? '+' : ''}${solDiscrepancyPercent.toFixed(1)}%` : 'N/A';

    if (hasMismatch) {
      logger.warn(
        {
          mint: tokenMint,
          intended: intendedAmountSol,
          actualSpent: solSpentStr,
          tokens: tokensStr,
          discrepancy: discrepancyStr,
          signature,
        },
        `[trade-audit] BUY MISMATCH: intended=${intendedAmountSol} SOL, actual_spent=${solSpentStr} SOL, discrepancy=${discrepancyStr}`,
      );
    } else {
      logger.info(
        {
          mint: tokenMint,
          intended: intendedAmountSol,
          actualSpent: solSpentStr,
          tokens: tokensStr,
          slippage: tokenSlippagePercent !== null ? `${tokenSlippagePercent.toFixed(1)}%` : 'N/A',
          verified,
          signature: signature.substring(0, 12) + '...',
        },
        `[trade-audit] BUY AUDIT: intended=${intendedAmountSol} SOL, spent=${solSpentStr} SOL, tokens=${tokensStr}`,
      );
    }

    return record;
  }

  /**
   * Record a sell trade audit
   */
  recordSell(params: RecordSellAuditParams): TradeAuditRecord {
    const {
      tokenMint,
      tokenSymbol,
      intendedTokenAmount,
      actualSolReceived,
      expectedSol,
      verificationMethod,
      verified,
      solSlippagePercent,
      signature,
      bondingCurve,
    } = params;

    let hasMismatch = false;
    if (actualSolReceived !== null && expectedSol !== null && expectedSol > 0) {
      const discrepancy = Math.abs(((actualSolReceived - expectedSol) / expectedSol) * 100);
      hasMismatch = discrepancy > SOL_MISMATCH_THRESHOLD_PERCENT;
    }

    const record: TradeAuditRecord = {
      id: `audit-${this.nextId++}`,
      timestamp: Date.now(),
      type: 'sell',
      tokenMint,
      tokenSymbol,
      intendedAmountSol: expectedSol || 0,
      instructionAmountLamports: intendedTokenAmount,
      actualSolSpent: null,
      actualSolReceived,
      actualTokensReceived: null,
      expectedTokens: null,
      verificationMethod,
      verified,
      solDiscrepancyPercent: solSlippagePercent,
      tokenSlippagePercent: null,
      hasMismatch,
      signature,
      bondingCurve,
    };

    this.addRecord(record);

    const solStr = actualSolReceived !== null ? actualSolReceived.toFixed(6) : 'unknown';
    const expectedStr = expectedSol !== null ? expectedSol.toFixed(6) : 'unknown';

    if (hasMismatch) {
      logger.warn(
        {
          mint: tokenMint,
          expected: expectedStr,
          actual: solStr,
          signature,
        },
        `[trade-audit] SELL MISMATCH: expected=${expectedStr} SOL, actual=${solStr} SOL`,
      );
    } else {
      logger.info(
        {
          mint: tokenMint,
          expected: expectedStr,
          actual: solStr,
          verified,
          signature: signature.substring(0, 12) + '...',
        },
        `[trade-audit] SELL AUDIT: expected=${expectedStr} SOL, received=${solStr} SOL`,
      );
    }

    return record;
  }

  /**
   * Get recent audit records
   */
  getRecent(limit: number = 50): TradeAuditRecord[] {
    return this.records.slice(-limit);
  }

  /**
   * Get only records with mismatches (alerts)
   */
  getAlerts(): TradeAuditRecord[] {
    return this.records.filter((r) => r.hasMismatch);
  }

  /**
   * Get aggregate summary statistics
   */
  getSummary(): TradeAuditSummary {
    const buys = this.records.filter((r) => r.type === 'buy');
    const sells = this.records.filter((r) => r.type === 'sell');
    const mismatches = this.records.filter((r) => r.hasMismatch);

    // Average SOL discrepancy for buys that have data
    const buysWithDiscrepancy = buys.filter((r) => r.solDiscrepancyPercent !== null);
    const avgSolDiscrepancy =
      buysWithDiscrepancy.length > 0
        ? buysWithDiscrepancy.reduce((sum, r) => sum + (r.solDiscrepancyPercent || 0), 0) / buysWithDiscrepancy.length
        : 0;

    // Average token slippage for buys that have data
    const buysWithSlippage = buys.filter((r) => r.tokenSlippagePercent !== null);
    const avgTokenSlippage =
      buysWithSlippage.length > 0
        ? buysWithSlippage.reduce((sum, r) => sum + (r.tokenSlippagePercent || 0), 0) / buysWithSlippage.length
        : 0;

    const lastRecord = this.records.length > 0 ? this.records[this.records.length - 1] : null;

    return {
      totalAudited: this.records.length,
      totalBuys: buys.length,
      totalSells: sells.length,
      mismatches: mismatches.length,
      avgSolDiscrepancyPercent: Number(avgSolDiscrepancy.toFixed(2)),
      avgTokenSlippagePercent: Number(avgTokenSlippage.toFixed(2)),
      lastAuditAt: lastRecord?.timestamp || null,
    };
  }

  /**
   * Get a compact text report suitable for pasting into Claude
   */
  getCompactReport(): string {
    const summary = this.getSummary();
    const alerts = this.getAlerts();
    const recent = this.getRecent(10);

    const lines: string[] = [];
    lines.push('=== Trade Audit Report ===');
    lines.push(`Total: ${summary.totalAudited} (${summary.totalBuys} buys, ${summary.totalSells} sells)`);
    lines.push(`Mismatches: ${summary.mismatches}`);
    lines.push(`Avg SOL discrepancy: ${summary.avgSolDiscrepancyPercent}%`);
    lines.push(`Avg token slippage: ${summary.avgTokenSlippagePercent}%`);
    lines.push('');

    if (alerts.length > 0) {
      lines.push('--- ALERTS ---');
      for (const alert of alerts.slice(-5)) {
        const time = new Date(alert.timestamp).toISOString().substring(11, 19);
        lines.push(
          `[${time}] ${alert.type.toUpperCase()} ${alert.tokenSymbol} (${alert.tokenMint.substring(0, 8)}...) ` +
          `intended=${alert.intendedAmountSol} SOL, ` +
          `actual=${alert.type === 'buy' ? (alert.actualSolSpent?.toFixed(6) || '?') : (alert.actualSolReceived?.toFixed(6) || '?')} SOL, ` +
          `sig=${alert.signature.substring(0, 12)}...`,
        );
      }
      lines.push('');
    }

    if (recent.length > 0) {
      lines.push('--- Recent Trades ---');
      for (const rec of recent) {
        const time = new Date(rec.timestamp).toISOString().substring(11, 19);
        const status = rec.hasMismatch ? 'MISMATCH' : 'OK';
        if (rec.type === 'buy') {
          lines.push(
            `[${time}] BUY ${rec.tokenSymbol} | ${rec.intendedAmountSol} SOL -> ${rec.actualTokensReceived || '?'} tokens | ` +
            `spent=${rec.actualSolSpent?.toFixed(6) || '?'} | ${status}`,
          );
        } else {
          lines.push(
            `[${time}] SELL ${rec.tokenSymbol} | ${rec.actualSolReceived?.toFixed(6) || '?'} SOL received | ${status}`,
          );
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * Get total record count
   */
  getCount(): number {
    return this.records.length;
  }

  // ──────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────────────────

  private addRecord(record: TradeAuditRecord): void {
    this.records.push(record);

    // Ring buffer: drop oldest when over limit
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(-MAX_RECORDS);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SINGLETON
// ════════════════════════════════════════════════════════════════════════════

let instance: TradeAuditManager | null = null;

export function initTradeAuditManager(): TradeAuditManager {
  instance = new TradeAuditManager();
  logger.info('[trade-audit] Trade audit manager initialized');
  return instance;
}

export function getTradeAuditManager(): TradeAuditManager | null {
  return instance;
}
