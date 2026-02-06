/**
 * Log Summarizer Module
 *
 * Captures key bot events in 5-minute buckets and produces compact summaries
 * that are small enough to paste into Claude's context window.
 *
 * Replaces the need to copy hundreds of noisy log lines --
 * one compact summary per 5 minutes covers everything.
 *
 * @module helpers/log-summarizer
 */

import { logger } from './logger';

// ════════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════════

export interface LogSummaryBucket {
  periodStart: number;
  periodEnd: number;
  periodLabel: string; // "13:00-13:05"

  tokensDetected: number;
  tokensPassed: number;

  buysAttempted: number;
  buysSucceeded: number;
  buysFailed: number;

  sellsAttempted: number;
  sellsSucceeded: number;
  sellsFailed: number;

  verificationAlerts: number;
  positionsOpen: number;
  walletBalance: number | null;

  topRejectionReason: string;
  rejectionCounts: Map<string, number>;

  errors: string[];
}

// ════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════════════════════

const BUCKET_DURATION_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BUCKETS = 72; // 6 hours of 5-minute buckets
const MAX_ERRORS_PER_BUCKET = 5;

// ════════════════════════════════════════════════════════════════════════════
// LOG SUMMARIZER CLASS
// ════════════════════════════════════════════════════════════════════════════

export class LogSummarizer {
  private buckets: LogSummaryBucket[] = [];
  private currentBucket: LogSummaryBucket;

  constructor() {
    this.currentBucket = this.createBucket();
  }

  // ──────────────────────────────────────────────────────────────────────
  // EVENT RECORDING
  // ──────────────────────────────────────────────────────────────────────

  recordTokenDetected(): void {
    this.ensureCurrentBucket();
    this.currentBucket.tokensDetected++;
  }

  recordTokenPassed(): void {
    this.ensureCurrentBucket();
    this.currentBucket.tokensPassed++;
  }

  recordTokenRejected(reason: string): void {
    this.ensureCurrentBucket();
    const count = this.currentBucket.rejectionCounts.get(reason) || 0;
    this.currentBucket.rejectionCounts.set(reason, count + 1);
  }

  recordBuyAttempt(): void {
    this.ensureCurrentBucket();
    this.currentBucket.buysAttempted++;
  }

  recordBuySuccess(): void {
    this.ensureCurrentBucket();
    this.currentBucket.buysSucceeded++;
  }

  recordBuyFailure(): void {
    this.ensureCurrentBucket();
    this.currentBucket.buysFailed++;
  }

  recordSellAttempt(): void {
    this.ensureCurrentBucket();
    this.currentBucket.sellsAttempted++;
  }

  recordSellSuccess(): void {
    this.ensureCurrentBucket();
    this.currentBucket.sellsSucceeded++;
  }

  recordSellFailure(): void {
    this.ensureCurrentBucket();
    this.currentBucket.sellsFailed++;
  }

  recordVerificationAlert(): void {
    this.ensureCurrentBucket();
    this.currentBucket.verificationAlerts++;
  }

  recordError(message: string): void {
    this.ensureCurrentBucket();
    if (this.currentBucket.errors.length < MAX_ERRORS_PER_BUCKET) {
      // Deduplicate
      if (!this.currentBucket.errors.includes(message)) {
        this.currentBucket.errors.push(message);
      }
    }
  }

  /**
   * Update snapshot data (called periodically from heartbeat)
   */
  updateSnapshot(positionsOpen: number, walletBalance: number | null): void {
    this.ensureCurrentBucket();
    this.currentBucket.positionsOpen = positionsOpen;
    this.currentBucket.walletBalance = walletBalance;
  }

  // ──────────────────────────────────────────────────────────────────────
  // RETRIEVAL
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Get the last N finalized buckets
   */
  getSummaries(count: number = 6): LogSummaryBucket[] {
    return this.buckets.slice(-count);
  }

  /**
   * Get the current in-progress bucket
   */
  getCurrentBucket(): LogSummaryBucket {
    this.ensureCurrentBucket();
    return this.currentBucket;
  }

  /**
   * Get a compact text report designed for Claude's context window.
   * Covers the last 30 minutes (6 buckets) plus the current period.
   */
  getCompactReport(): string {
    this.ensureCurrentBucket();
    const lines: string[] = [];

    lines.push('=== Bot Summary ===');

    // Finalized buckets
    const recentBuckets = this.buckets.slice(-6);
    for (const bucket of recentBuckets) {
      lines.push(this.formatBucketLine(bucket));
    }

    // Current (in-progress) bucket
    if (this.currentBucket.tokensDetected > 0 || this.currentBucket.buysAttempted > 0) {
      lines.push(this.formatBucketLine(this.currentBucket) + ' (current)');
    }

    // Aggregate rejection reasons across all recent buckets
    const allRejections = new Map<string, number>();
    for (const bucket of [...recentBuckets, this.currentBucket]) {
      for (const [reason, count] of bucket.rejectionCounts) {
        allRejections.set(reason, (allRejections.get(reason) || 0) + count);
      }
    }

    if (allRejections.size > 0) {
      const totalRejections = Array.from(allRejections.values()).reduce((a, b) => a + b, 0);
      const sorted = Array.from(allRejections.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const reasonStrs = sorted.map(([reason, count]) => {
        const pct = totalRejections > 0 ? ((count / totalRejections) * 100).toFixed(0) : '0';
        return `${reason}(${pct}%)`;
      });
      lines.push(`Top rejections: ${reasonStrs.join(', ')}`);
    }

    // Count alerts across all buckets
    const totalAlerts = recentBuckets.reduce((sum, b) => sum + b.verificationAlerts, 0) + this.currentBucket.verificationAlerts;
    if (totalAlerts > 0) {
      lines.push(`Active alerts: ${totalAlerts} trade verification mismatch(es)`);
    }

    // Collect errors
    const allErrors: string[] = [];
    for (const bucket of [...recentBuckets, this.currentBucket]) {
      allErrors.push(...bucket.errors);
    }
    if (allErrors.length > 0) {
      lines.push(`Errors: ${allErrors.slice(0, 3).join('; ')}`);
    }

    return lines.join('\n');
  }

  // ──────────────────────────────────────────────────────────────────────
  // PRIVATE
  // ──────────────────────────────────────────────────────────────────────

  private formatBucketLine(bucket: LogSummaryBucket): string {
    const buys = `Buy:${bucket.buysSucceeded}/${bucket.buysAttempted}`;
    const sells = `Sell:${bucket.sellsSucceeded}/${bucket.sellsAttempted}`;
    const bal = bucket.walletBalance !== null ? `${bucket.walletBalance.toFixed(2)} SOL` : '?';
    const alerts = bucket.verificationAlerts > 0 ? ` Alerts:${bucket.verificationAlerts}` : '';

    return `${bucket.periodLabel} | Det:${bucket.tokensDetected} ${buys} ${sells} | Pos:${bucket.positionsOpen} | Bal:${bal}${alerts}`;
  }

  /**
   * Check if the current bucket has expired and rotate if needed
   */
  private ensureCurrentBucket(): void {
    const now = Date.now();
    if (now >= this.currentBucket.periodEnd) {
      // Finalize top rejection reason
      this.finalizeBucket(this.currentBucket);

      // Store and create new
      this.buckets.push(this.currentBucket);
      if (this.buckets.length > MAX_BUCKETS) {
        this.buckets = this.buckets.slice(-MAX_BUCKETS);
      }

      this.currentBucket = this.createBucket();
    }
  }

  private finalizeBucket(bucket: LogSummaryBucket): void {
    let topReason = '';
    let topCount = 0;
    for (const [reason, count] of bucket.rejectionCounts) {
      if (count > topCount) {
        topCount = count;
        topReason = reason;
      }
    }
    bucket.topRejectionReason = topReason;
  }

  private createBucket(): LogSummaryBucket {
    const now = Date.now();
    // Align to 5-minute boundaries
    const periodStart = now - (now % BUCKET_DURATION_MS);
    const periodEnd = periodStart + BUCKET_DURATION_MS;

    const startDate = new Date(periodStart);
    const endDate = new Date(periodEnd);
    const fmt = (d: Date) => `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;

    return {
      periodStart,
      periodEnd,
      periodLabel: `${fmt(startDate)}-${fmt(endDate)}`,
      tokensDetected: 0,
      tokensPassed: 0,
      buysAttempted: 0,
      buysSucceeded: 0,
      buysFailed: 0,
      sellsAttempted: 0,
      sellsSucceeded: 0,
      sellsFailed: 0,
      verificationAlerts: 0,
      positionsOpen: 0,
      walletBalance: null,
      topRejectionReason: '',
      rejectionCounts: new Map(),
      errors: [],
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SINGLETON
// ════════════════════════════════════════════════════════════════════════════

let instance: LogSummarizer | null = null;

export function initLogSummarizer(): LogSummarizer {
  instance = new LogSummarizer();
  logger.info('[log-summarizer] Log summarizer initialized');
  return instance;
}

export function getLogSummarizer(): LogSummarizer | null {
  return instance;
}
