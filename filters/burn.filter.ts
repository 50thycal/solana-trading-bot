import { Filter, FilterResult, DetailedFilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class BurnFilter implements Filter {
  constructor(private readonly connection: Connection) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      // DLMM pools don't have LP tokens - they use Position NFTs
      // If lpMint equals pool id, this is a DLMM pool - skip burn check
      if (poolKeys.lpMint.equals(poolKeys.id)) {
        return { ok: true, message: 'DLMM pool - no LP tokens to burn' };
      }

      const amount = await this.connection.getTokenSupply(poolKeys.lpMint, this.connection.commitment);
      const burned = amount.value.uiAmount === 0;
      return { ok: burned, message: burned ? undefined : "Burned -> Creator didn't burn LP" };
    } catch (e: any) {
      // Error code -32602 means the account doesn't exist or is not a token mint
      if (e.code == -32602 || e.code === -32600) {
        return { ok: true };
      }

      logger.error({ mint: poolKeys.baseMint, error: e.message }, `Failed to check if LP is burned`);
    }

    return { ok: false, message: 'Failed to check if LP is burned' };
  }

  /**
   * Execute filter and return detailed results for dashboard
   */
  async executeDetailed(poolKeys: LiquidityPoolKeysV4): Promise<DetailedFilterResult[]> {
    try {
      // DLMM pools don't have LP tokens - they use Position NFTs
      // If lpMint equals pool id, this is a DLMM pool - skip burn check
      if (poolKeys.lpMint.equals(poolKeys.id)) {
        return [{
          name: 'burn',
          displayName: 'LP Burned',
          passed: true,
          checked: true,
          reason: 'DLMM pool - uses Position NFTs instead of LP tokens',
        }];
      }

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
      // Error code -32602 or -32600 means the account doesn't exist or is not a token mint
      if (e.code == -32602 || e.code === -32600) {
        return [{
          name: 'burn',
          displayName: 'LP Burned',
          passed: true,
          checked: true,
          reason: 'LP tokens burned (account closed or not found)',
        }];
      }

      logger.error({ mint: poolKeys.baseMint, error: e.message }, `Failed to check if LP is burned`);
      return [{
        name: 'burn',
        displayName: 'LP Burned',
        passed: false,
        checked: true,
        reason: `Failed to check LP burn status: ${e.message || 'Unknown error'}`,
      }];
    }
  }
}
