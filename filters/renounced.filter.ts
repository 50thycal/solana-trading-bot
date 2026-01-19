import { Filter, FilterResult, DetailedFilterResult } from './pool-filters';
import { MintLayout } from '@solana/spl-token';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { logger } from '../helpers';

export class RenouncedFreezeFilter implements Filter {
  private readonly errorMessage: string[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly checkRenounced: boolean,
    private readonly checkFreezable: boolean,
  ) {
    if (this.checkRenounced) {
      this.errorMessage.push('mint');
    }

    if (this.checkFreezable) {
      this.errorMessage.push('freeze');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const accountInfo = await this.connection.getAccountInfo(poolKeys.baseMint, this.connection.commitment);
      if (!accountInfo?.data) {
        return { ok: false, message: 'RenouncedFreeze -> Failed to fetch account data' };
      }

      const deserialize = MintLayout.decode(accountInfo.data);
      const renounced = !this.checkRenounced || deserialize.mintAuthorityOption === 0;
      const freezable = !this.checkFreezable || deserialize.freezeAuthorityOption !== 0;
      const ok = renounced && !freezable;
      const message: string[] = [];

      if (!renounced) {
        message.push('mint');
      }

      if (freezable) {
        message.push('freeze');
      }

      return { ok: ok, message: ok ? undefined : `RenouncedFreeze -> Creator can ${message.join(' and ')} tokens` };
    } catch (e) {
      logger.error(
        { mint: poolKeys.baseMint },
        `RenouncedFreeze -> Failed to check if creator can ${this.errorMessage.join(' and ')} tokens`,
      );
    }

    return {
      ok: false,
      message: `RenouncedFreeze -> Failed to check if creator can ${this.errorMessage.join(' and ')} tokens`,
    };
  }

  /**
   * Execute filter and return detailed results for dashboard
   */
  async executeDetailed(poolKeys: LiquidityPoolKeysV4): Promise<DetailedFilterResult[]> {
    const results: DetailedFilterResult[] = [];

    try {
      const accountInfo = await this.connection.getAccountInfo(poolKeys.baseMint, this.connection.commitment);
      if (!accountInfo?.data) {
        // Return error results for both checks
        if (this.checkRenounced) {
          results.push({
            name: 'renounced',
            displayName: 'Mint Renounced',
            passed: false,
            checked: true,
            reason: 'Failed to fetch mint account data',
          });
        }
        if (this.checkFreezable) {
          results.push({
            name: 'freezable',
            displayName: 'Not Freezable',
            passed: false,
            checked: true,
            reason: 'Failed to fetch mint account data',
          });
        }
        return results;
      }

      const deserialize = MintLayout.decode(accountInfo.data);
      const hasMintAuthority = deserialize.mintAuthorityOption !== 0;
      const hasFreezeAuthority = deserialize.freezeAuthorityOption !== 0;

      // Renounced check
      if (this.checkRenounced) {
        const renounced = !hasMintAuthority;
        results.push({
          name: 'renounced',
          displayName: 'Mint Renounced',
          passed: renounced,
          checked: true,
          reason: renounced
            ? 'Mint authority renounced'
            : 'Mint authority still active - creator can mint more tokens',
          details: {
            expected: 'No mint authority',
            actual: hasMintAuthority ? 'Has mint authority' : 'No mint authority',
          },
        });
      }

      // Freezable check
      if (this.checkFreezable) {
        const notFreezable = !hasFreezeAuthority;
        results.push({
          name: 'freezable',
          displayName: 'Not Freezable',
          passed: notFreezable,
          checked: true,
          reason: notFreezable
            ? 'No freeze authority - tokens cannot be frozen'
            : 'Freeze authority active - creator can freeze tokens',
          details: {
            expected: 'No freeze authority',
            actual: hasFreezeAuthority ? 'Has freeze authority' : 'No freeze authority',
          },
        });
      }

      return results;
    } catch (e) {
      logger.error(
        { mint: poolKeys.baseMint },
        `RenouncedFreeze -> Failed to check authorities`,
      );

      // Return error results
      if (this.checkRenounced) {
        results.push({
          name: 'renounced',
          displayName: 'Mint Renounced',
          passed: false,
          checked: true,
          reason: 'Error checking mint authority',
        });
      }
      if (this.checkFreezable) {
        results.push({
          name: 'freezable',
          displayName: 'Not Freezable',
          passed: false,
          checked: true,
          reason: 'Error checking freeze authority',
        });
      }
      return results;
    }
  }
}
