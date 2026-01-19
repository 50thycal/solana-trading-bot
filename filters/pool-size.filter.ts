import { Filter, FilterResult, DetailedFilterResult } from './pool-filters';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { Connection } from '@solana/web3.js';
import { logger } from '../helpers';

export class PoolSizeFilter implements Filter {
  constructor(
    private readonly connection: Connection,
    private readonly quoteToken: Token,
    private readonly minPoolSize: TokenAmount,
    private readonly maxPoolSize: TokenAmount,
  ) {}

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const response = await this.connection.getTokenAccountBalance(poolKeys.quoteVault, this.connection.commitment);
      const poolSize = new TokenAmount(this.quoteToken, response.value.amount, true);
      let inRange = true;

      if (!this.maxPoolSize?.isZero()) {
        inRange = poolSize.raw.lte(this.maxPoolSize.raw);

        if (!inRange) {
          return { ok: false, message: `PoolSize -> Pool size ${poolSize.toFixed()} > ${this.maxPoolSize.toFixed()}` };
        }
      }

      if (!this.minPoolSize?.isZero()) {
        inRange = poolSize.raw.gte(this.minPoolSize.raw);

        if (!inRange) {
          return { ok: false, message: `PoolSize -> Pool size ${poolSize.toFixed()} < ${this.minPoolSize.toFixed()}` };
        }
      }

      return { ok: inRange };
    } catch (error) {
      logger.error({ mint: poolKeys.baseMint }, `Failed to check pool size`);
    }

    return { ok: false, message: 'PoolSize -> Failed to check pool size' };
  }

  /**
   * Execute filter and return detailed results for dashboard
   */
  async executeDetailed(poolKeys: LiquidityPoolKeysV4): Promise<DetailedFilterResult[]> {
    try {
      const response = await this.connection.getTokenAccountBalance(poolKeys.quoteVault, this.connection.commitment);
      const poolSize = new TokenAmount(this.quoteToken, response.value.amount, true);
      const poolSizeNum = parseFloat(poolSize.toFixed());
      const minSize = parseFloat(this.minPoolSize.toFixed());
      const maxSize = parseFloat(this.maxPoolSize.toFixed());

      // Check if in range
      let passed = true;
      let reason = '';

      const checkMin = !this.minPoolSize.isZero();
      const checkMax = !this.maxPoolSize.isZero();

      if (checkMax && poolSize.raw.gt(this.maxPoolSize.raw)) {
        passed = false;
        reason = `Pool too large: ${poolSizeNum.toFixed(2)} ${this.quoteToken.symbol} (max: ${maxSize} ${this.quoteToken.symbol})`;
      } else if (checkMin && poolSize.raw.lt(this.minPoolSize.raw)) {
        passed = false;
        reason = `Pool too small: ${poolSizeNum.toFixed(2)} ${this.quoteToken.symbol} (min: ${minSize} ${this.quoteToken.symbol})`;
      } else {
        reason = `Pool size: ${poolSizeNum.toFixed(2)} ${this.quoteToken.symbol} (range: ${minSize}-${maxSize} ${this.quoteToken.symbol})`;
      }

      return [{
        name: 'pool_size',
        displayName: 'Pool Size',
        passed,
        checked: true,
        reason,
        details: {
          expected: `${minSize}-${maxSize} ${this.quoteToken.symbol}`,
          actual: `${poolSizeNum.toFixed(2)} ${this.quoteToken.symbol}`,
          value: poolSizeNum,
        },
      }];
    } catch (error) {
      logger.error({ mint: poolKeys.baseMint }, `Failed to check pool size`);
      return [{
        name: 'pool_size',
        displayName: 'Pool Size',
        passed: false,
        checked: true,
        reason: 'Failed to check pool size',
      }];
    }
  }
}
