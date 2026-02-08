/**
 * Token Log Buffer
 *
 * Collects log entries per-token during pipeline processing,
 * then flushes the entire block atomically to prevent interleaved output
 * from concurrent token pipelines.
 */

import { logger } from './logger';

export interface BufferedLogEntry {
  level: 'info' | 'warn' | 'debug';
  timestamp: number;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * TokenLogBuffer - Buffers log output per-token for clean, non-interleaved display
 *
 * Usage:
 *   const buffer = new TokenLogBuffer(mint, symbol);
 *   buffer.info('Cheap gates: PASSED', { durationMs: 37 });
 *   buffer.warn('Something suspicious');
 *   buffer.flush(); // Writes entire block atomically
 */
export class TokenLogBuffer {
  private entries: BufferedLogEntry[] = [];
  private mintShort: string;
  private symbol: string;
  private startTime: number;

  constructor(mint: string, symbol?: string) {
    // Show first 6 chars + "...pump" for readability
    this.mintShort = mint.length > 10 ? `${mint.slice(0, 6)}...${mint.slice(-4)}` : mint;
    this.symbol = symbol || 'Unknown';
    this.startTime = Date.now();
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.entries.push({ level: 'info', timestamp: Date.now(), message, data });
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.entries.push({ level: 'warn', timestamp: Date.now(), message, data });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.entries.push({ level: 'debug', timestamp: Date.now(), message, data });
  }

  /**
   * Flush all buffered entries as a single formatted block.
   * Includes a header/footer banner for visual separation.
   */
  flush(outcome?: { result: 'BOUGHT' | 'REJECTED'; stage?: string; reason?: string; totalMs?: number }): void {
    const banner = `═══════ TOKEN: ${this.symbol} (${this.mintShort}) ═══════`;
    const separator = '═'.repeat(banner.length);

    const lines: string[] = [banner];

    for (const entry of this.entries) {
      const ts = formatTimestamp(entry.timestamp);
      const prefix = entry.level === 'warn' ? '⚠ ' : '';
      lines.push(`[${ts}] ${prefix}${entry.message}`);
    }

    if (outcome) {
      const ts = formatTimestamp(Date.now());
      const totalMs = outcome.totalMs ?? (Date.now() - this.startTime);
      if (outcome.result === 'REJECTED') {
        lines.push(`[${ts}] Result: REJECTED at ${outcome.stage} - ${outcome.reason} (${totalMs}ms total)`);
      } else {
        lines.push(`[${ts}] Result: BOUGHT (${totalMs}ms total)`);
      }
    }

    lines.push(separator);

    // Write the entire block as a single logger.info call so it's atomic
    logger.info(lines.join('\n'));
  }

  /** Get the number of buffered entries */
  get length(): number {
    return this.entries.length;
  }
}

/**
 * Format a timestamp as HH:MM:SS.mmm
 */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const h = pad2(d.getHours());
  const m = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  const ms = pad3(d.getMilliseconds());
  return `${h}:${m}:${s}.${ms}`;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : '' + n;
}

function pad3(n: number): string {
  if (n < 10) return '00' + n;
  if (n < 100) return '0' + n;
  return '' + n;
}
