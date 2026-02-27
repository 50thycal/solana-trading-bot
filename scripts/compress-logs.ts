#!/usr/bin/env ts-node
/**
 * compress-logs.ts
 *
 * Strips verbose debug noise from bot logs to reduce token usage when sharing
 * logs with an AI for code review. Removes raw Solana program instruction
 * arrays, account index lists, and redundant extracted-account fields — while
 * keeping every meaningful pipeline decision, token summary, error, and the
 * smoke-test report.
 *
 * Usage:
 *   # pipe directly from a running container
 *   docker logs <container> 2>&1 | ts-node scripts/compress-logs.ts
 *
 *   # process a saved log file
 *   ts-node scripts/compress-logs.ts run.log
 *
 *   # via npm script
 *   npm run compress-logs -- run.log
 */

import * as fs from 'fs';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Patterns — lines whose *content* (after Docker prefix stripping) matches
// any of these regexes are dropped entirely.
// ---------------------------------------------------------------------------
const DROP_PATTERNS: RegExp[] = [
  // ── [pump.fun DEBUG] verbose message lines ────────────────────────────────
  /\[pump\.fun DEBUG\]/,

  // ── allLogs / accounts / mints / accountKeys array headers ───────────────
  /^\s*allLogs\s*:\s*\[/,
  /^\s*accountKeys\s*:\s*\[/,
  /^\s*mints\s*:\s*\[/,
  // "accounts: [" but NOT "accounts:" standalone summary lines
  /^\s*accounts\s*:\s*\[/,

  // ── Entries inside allLogs arrays: "Program log: ..." ────────────────────
  // Matches lines like:   "Program log: Instruction: InitializeMint2",
  // Does NOT match buy-failure lines like "Program pfee... consumed ..."
  /^\s*"Program log:/,

  // ── Entries inside accounts / accountKeys arrays: "[N] <address>" ─────────
  /^\s*"\[\d+\]/,

  // ── Redundant per-token extracted fields (already in token summary) ───────
  /^\s*createLogLine\s*:/,
  /^\s*accountCount\s*:/,
  /^\s*ixIndex\s*:/,
  /^\s*innerIxIndex\s*:/,
  /^\s*postBalanceCount\s*:/,
  /^\s*extractedMint\s*:/,
  /^\s*extractedBondingCurve\s*:/,
  /^\s*extractedAssociatedBondingCurve\s*:/,
  /^\s*extractedCreator\s*:/,
  /^\s*isCreateV2\s*:/,
  /^\s*isPumpFunGlobal\s*:/,
  /^\s*isMintAProgram\s*:/,

  // ── Orphaned closing brackets left after filtering array bodies ───────────
  // Matches "      ]" (indented-only) but NOT "  ]." or "]" (buy-failure logs)
  /^\s{2,}\]\s*$/,
];

// ---------------------------------------------------------------------------
// Docker / container log prefix stripper
// Format: 2026-02-27T14:53:07.808165931Z [inf]  <content>
//         or plain lines (passthrough)
// ---------------------------------------------------------------------------
const DOCKER_PREFIX_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+\[(?:inf|err|wrn|dbg)\]\s{0,2}/;

function stripDockerPrefix(line: string): string {
  return line.replace(DOCKER_PREFIX_RE, '');
}

function shouldDrop(content: string): boolean {
  return DROP_PATTERNS.some((p) => p.test(content));
}

// ---------------------------------------------------------------------------
// Main streaming processor
// ---------------------------------------------------------------------------
async function processStream(input: NodeJS.ReadableStream): Promise<void> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let linesIn = 0;
  let linesOut = 0;

  for await (const rawLine of rl) {
    linesIn++;
    const content = stripDockerPrefix(rawLine);
    if (!shouldDrop(content)) {
      process.stdout.write(content + '\n');
      linesOut++;
    }
  }

  const pct = linesIn > 0 ? Math.round((1 - linesOut / linesIn) * 100) : 0;
  process.stderr.write(
    `compress-logs: ${linesIn} lines in → ${linesOut} lines out (${pct}% reduction)\n`
  );
}

async function main(): Promise<void> {
  const filePath = process.argv[2];

  if (filePath) {
    if (!fs.existsSync(filePath)) {
      process.stderr.write(`compress-logs: file not found: ${filePath}\n`);
      process.exit(1);
    }
    await processStream(fs.createReadStream(filePath, { encoding: 'utf8' }));
  } else {
    if (process.stdin.isTTY) {
      process.stderr.write('Usage: ts-node scripts/compress-logs.ts [logfile]\n');
      process.stderr.write('       cat run.log | ts-node scripts/compress-logs.ts\n');
      process.exit(0);
    }
    await processStream(process.stdin);
  }
}

main().catch((err: Error) => {
  process.stderr.write(`compress-logs error: ${err.message}\n`);
  process.exit(1);
});
