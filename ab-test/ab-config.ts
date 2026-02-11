/**
 * A/B Test Configuration Parser
 *
 * Parses AB_CONFIG_A and AB_CONFIG_B from environment variables (JSON strings)
 * and validates all fields. Returns production defaults for any missing fields.
 */

import { ABVariantConfig, ABTestConfig } from './types';
import { logger } from '../helpers';

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULTS (match production defaults from config-validator.ts)
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_VARIANT_CONFIG: Omit<ABVariantConfig, 'name'> = {
  takeProfit: 40,
  stopLoss: 20,
  maxHoldDurationMs: 20000,
  priceCheckIntervalMs: 2000,
  momentumMinTotalBuys: 10,
  pumpfunMinSolInCurve: 5,
  pumpfunMaxSolInCurve: 300,
  maxTokenAgeSeconds: 300,
  momentumInitialDelayMs: 100,
  momentumRecheckIntervalMs: 100,
  momentumMaxChecks: 5,
  buySlippage: 20,
  sellSlippage: 30,
  maxTradesPerHour: 10,
  quoteAmount: 0.01,
};

const DEFAULT_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

// ═══════════════════════════════════════════════════════════════════════════════
// PARSER
// ═══════════════════════════════════════════════════════════════════════════════

function parseVariantConfig(jsonStr: string, name: string): ABVariantConfig {
  let parsed: Record<string, unknown> = {};

  if (jsonStr && jsonStr.trim()) {
    try {
      parsed = JSON.parse(jsonStr);
    } catch (error) {
      throw new Error(
        `AB_CONFIG_${name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Merge with defaults - any field not provided uses production default
  const config: ABVariantConfig = {
    name,
    takeProfit: num(parsed.takeProfit, DEFAULT_VARIANT_CONFIG.takeProfit),
    stopLoss: num(parsed.stopLoss, DEFAULT_VARIANT_CONFIG.stopLoss),
    maxHoldDurationMs: Math.round(num(parsed.maxHoldDurationMinutes, DEFAULT_VARIANT_CONFIG.maxHoldDurationMs / 60000) * 60000),
    priceCheckIntervalMs: Math.round(num(parsed.priceCheckIntervalMinutes, DEFAULT_VARIANT_CONFIG.priceCheckIntervalMs / 60000) * 60000),
    momentumMinTotalBuys: num(parsed.momentumMinTotalBuys, DEFAULT_VARIANT_CONFIG.momentumMinTotalBuys),
    pumpfunMinSolInCurve: num(parsed.pumpfunMinSolInCurve, DEFAULT_VARIANT_CONFIG.pumpfunMinSolInCurve),
    pumpfunMaxSolInCurve: num(parsed.pumpfunMaxSolInCurve, DEFAULT_VARIANT_CONFIG.pumpfunMaxSolInCurve),
    maxTokenAgeSeconds: num(parsed.maxTokenAgeSeconds, DEFAULT_VARIANT_CONFIG.maxTokenAgeSeconds),
    momentumInitialDelayMs: Math.round(num(parsed.momentumInitialDelayMinutes, DEFAULT_VARIANT_CONFIG.momentumInitialDelayMs / 60000) * 60000),
    momentumRecheckIntervalMs: Math.round(num(parsed.momentumRecheckIntervalMinutes, DEFAULT_VARIANT_CONFIG.momentumRecheckIntervalMs / 60000) * 60000),
    momentumMaxChecks: num(parsed.momentumMaxChecks, DEFAULT_VARIANT_CONFIG.momentumMaxChecks),
    buySlippage: num(parsed.buySlippage, DEFAULT_VARIANT_CONFIG.buySlippage),
    sellSlippage: num(parsed.sellSlippage, DEFAULT_VARIANT_CONFIG.sellSlippage),
    maxTradesPerHour: num(parsed.maxTradesPerHour, DEFAULT_VARIANT_CONFIG.maxTradesPerHour),
    quoteAmount: num(parsed.quoteAmount, DEFAULT_VARIANT_CONFIG.quoteAmount),
  };

  // Validate ranges
  const errors: string[] = [];
  if (config.takeProfit <= 0) errors.push('takeProfit must be > 0');
  if (config.stopLoss <= 0) errors.push('stopLoss must be > 0');
  if (config.maxHoldDurationMs < 0) errors.push('maxHoldDurationMinutes cannot be negative');
  if (config.priceCheckIntervalMs < 500) errors.push('priceCheckIntervalMinutes must be >= 0.0083 (500ms)');
  if (config.momentumMinTotalBuys < 1) errors.push('momentumMinTotalBuys must be >= 1');
  if (config.pumpfunMinSolInCurve < 0) errors.push('pumpfunMinSolInCurve cannot be negative');
  if (config.pumpfunMaxSolInCurve <= config.pumpfunMinSolInCurve) errors.push('pumpfunMaxSolInCurve must be > pumpfunMinSolInCurve');
  if (config.maxTokenAgeSeconds < 0) errors.push('maxTokenAgeSeconds cannot be negative');
  if (config.momentumInitialDelayMs < 0) errors.push('momentumInitialDelayMinutes cannot be negative');
  if (config.momentumRecheckIntervalMs < 0) errors.push('momentumRecheckIntervalMinutes cannot be negative');
  if (config.momentumMaxChecks < 1) errors.push('momentumMaxChecks must be >= 1');
  if (config.buySlippage < 0 || config.buySlippage > 100) errors.push('buySlippage must be 0-100');
  if (config.sellSlippage < 0 || config.sellSlippage > 100) errors.push('sellSlippage must be 0-100');
  if (config.maxTradesPerHour < 1) errors.push('maxTradesPerHour must be >= 1');
  if (config.quoteAmount <= 0) errors.push('quoteAmount must be > 0');

  if (errors.length > 0) {
    throw new Error(`AB_CONFIG_${name} validation failed: ${errors.join('; ')}`);
  }

  return config;
}

function num(value: unknown, defaultValue: number): number {
  if (value === undefined || value === null) return defaultValue;
  const n = Number(value);
  return isNaN(n) ? defaultValue : n;
}

/**
 * Parse the full A/B test configuration from environment variables.
 */
export function parseABTestConfig(): ABTestConfig {
  const durationMinutes = Number(process.env.AB_TEST_DURATION_MINUTES) || (DEFAULT_DURATION_MS / 60000);
  if (durationMinutes < 1) {
    throw new Error('AB_TEST_DURATION_MINUTES must be at least 1');
  }
  const durationMs = Math.round(durationMinutes * 60000);

  const configAStr = process.env.AB_CONFIG_A || '';
  const configBStr = process.env.AB_CONFIG_B || '';

  const variantA = parseVariantConfig(configAStr, 'A');
  const variantB = parseVariantConfig(configBStr, 'B');

  const sessionId = `ab_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

  const config: ABTestConfig = {
    sessionId,
    durationMs,
    variantA,
    variantB,
    startedAt: Date.now(),
    description: process.env.AB_TEST_DESCRIPTION || undefined,
  };

  logger.info(
    {
      sessionId,
      durationMs,
      durationHours: (durationMs / 3600000).toFixed(1),
      variantA: summarizeConfig(variantA),
      variantB: summarizeConfig(variantB),
    },
    '[ab-config] Test configuration parsed'
  );

  return config;
}

/** Produce a compact summary of a variant config for logging */
function summarizeConfig(c: ABVariantConfig): Record<string, unknown> {
  return {
    tp: `${c.takeProfit}%`,
    sl: `${c.stopLoss}%`,
    maxHold: `${(c.maxHoldDurationMs / 60000).toFixed(4)} min`,
    checkInterval: `${(c.priceCheckIntervalMs / 60000).toFixed(4)} min`,
    minBuys: c.momentumMinTotalBuys,
    minSol: c.pumpfunMinSolInCurve,
    maxSol: c.pumpfunMaxSolInCurve,
    maxAge: `${c.maxTokenAgeSeconds}s`,
    momDelay: `${(c.momentumInitialDelayMs / 60000).toFixed(4)} min`,
    momRecheck: `${(c.momentumRecheckIntervalMs / 60000).toFixed(4)} min`,
    momMaxChecks: c.momentumMaxChecks,
    buySlip: `${c.buySlippage}%`,
    sellSlip: `${c.sellSlippage}%`,
    tradesPerHour: c.maxTradesPerHour,
    quoteAmount: `${c.quoteAmount} SOL`,
  };
}
