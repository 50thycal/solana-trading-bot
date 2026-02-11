/**
 * A/B Test Entry Point
 *
 * Invoked via BOT_MODE=ab. Runs two variant configurations in parallel
 * on the same token stream using paper trading. Generates a comparison
 * report when the test duration expires.
 *
 * Usage:
 *   BOT_MODE=ab AB_TEST_DURATION_MINUTES=240 \
 *   AB_CONFIG_A='{"takeProfit":40,"stopLoss":20}' \
 *   AB_CONFIG_B='{"takeProfit":60,"stopLoss":15}' \
 *   npx ts-node bootstrap.ts
 */

import { Connection } from '@solana/web3.js';
import { parseABTestConfig, ABTestRunner, ABTestReport } from './ab-test/index';
import { getConfig } from './helpers/config-validator';
import { logger } from './helpers';

export async function runABTest(): Promise<ABTestReport> {
  // Parse configuration
  const config = parseABTestConfig();
  const appConfig = getConfig();

  logger.info(
    {
      sessionId: config.sessionId,
      durationHours: (config.durationMs / 3600000).toFixed(1),
      rpcEndpoint: appConfig.rpcEndpoint.replace(/\/[^/]+$/, '/***'),
    },
    '[ab-test] Starting A/B paper trade test'
  );

  // Create RPC connection
  const connection = new Connection(appConfig.rpcEndpoint, {
    wsEndpoint: appConfig.rpcWebsocketEndpoint,
    commitment: appConfig.commitmentLevel,
  });

  // Create and run the test
  const runner = new ABTestRunner(config, connection);
  const report = await runner.start();

  logger.info(
    {
      sessionId: report.sessionId,
      winner: report.winner,
      pnlA: report.variantA.realizedPnlSol.toFixed(4),
      pnlB: report.variantB.realizedPnlSol.toFixed(4),
      tradesA: report.variantA.totalTradesClosed,
      tradesB: report.variantB.totalTradesClosed,
      tokensDetected: report.totalTokensDetected,
    },
    '[ab-test] Test complete'
  );

  return report;
}
