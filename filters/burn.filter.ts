import { Filter, FilterResult, DetailedFilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class BurnFilter implements Filter {
  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const amount = await this.connection.getTokenSupply(poolKeys.lpMint, this.connection.commitment);
      const burned = amount.value.uiAmount === 0;
      return { ok: burned, message: burned ? undefined : "Burned -> Creator didn't burn LP" };
    } catch (e: any) {
      if (e.code == -32602) {
        return { ok: true };
      }

      logger.error({ mint: poolKeys.baseMint }, `Failed to check if LP is burned`);
    }

    return { ok: false, message: 'Failed to check if LP is burned' };
  }

  /**
   * Execute filter and return detailed results for dashboard
   */
  async executeDetailed(poolKeys: LiquidityPoolKeysV4): Promise<DetailedFilterResult[]> {
    try {
      const amount = await this.connection.getTokenSupply(poolKeys.lpMint, this.connection.commitment);
      const lpSupply = amount.value.uiAmount ?? 0;
      const burned = lpSupply === 0;

      return [{
        name: 'burn',
        displayName: 'LP Burned',
        passed: burned,
        checked: true,
        reason: burned
          ? 'LP tokens burned (supply = 0)'
          : `LP not burned: ${lpSupply.toLocaleString()} tokens remain`,
        details: {
          expected: '0',
          actual: lpSupply.toString(),
          value: lpSupply,
        },
      }];
    } catch (e: any) {
      // Error code -32602 means the account doesn't exist, which means LP is burned
      if (e.code == -32602) {
        return [{
          name: 'burn',
          displayName: 'LP Burned',
          passed: true,
          checked: true,
          reason: 'LP tokens burned (account closed)',
        }];
      }

      logger.error({ mint: poolKeys.baseMint }, `Failed to check if LP is burned`);
      return [{
        name: 'burn',
        displayName: 'LP Burned',
        passed: false,
        checked: true,
        reason: 'Failed to check LP burn status',
      }];
    }
  }
}
