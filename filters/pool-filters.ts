import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { getMetadataAccountDataSerializer } from '@metaplex-foundation/mpl-token-metadata';
import { BurnFilter } from './burn.filter';
import { MutableFilter } from './mutable.filter';
import { RenouncedFreezeFilter } from './renounced.filter';
import { PoolSizeFilter } from './pool-size.filter';
import { CHECK_IF_BURNED, CHECK_IF_FREEZABLE, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_MUTABLE, CHECK_IF_SOCIALS, FILTER_PRESET, logger } from '../helpers';

export interface Filter {
  execute(poolKeysV4: LiquidityPoolKeysV4): Promise<FilterResult>;
}

export interface FilterResult {
  ok: boolean;
  message?: string;
}

/**
 * Detailed filter result for dashboard display
 */
export interface DetailedFilterResult {
  name: string;           // Filter identifier: 'burn', 'renounced', 'freezable', 'mutable', 'socials', 'pool_size'
  displayName: string;    // Human-readable name: 'LP Burned', 'Mint Renounced', etc.
  passed: boolean;
  reason: string;         // Human-readable explanation
  checked: boolean;       // Whether this filter was actually checked (based on config)
  details?: {
    expected?: string;    // What we expected
    actual?: string;      // What we found
    value?: number;       // Numeric value if applicable
  };
}

/**
 * Complete filter execution results for a pool
 */
export interface PoolFilterResults {
  tokenMint: string;
  poolId: string;
  filters: DetailedFilterResult[];
  allPassed: boolean;
  summary: string;        // Human-readable summary
  checkedAt: number;      // Timestamp
}

export interface PoolFilterArgs {
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
}

export class PoolFilters {
  private readonly filters: Filter[] = [];
  private readonly burnFilter?: BurnFilter;
  private readonly renouncedFreezeFilter?: RenouncedFreezeFilter;
  private readonly mutableFilter?: MutableFilter;
  private readonly poolSizeFilter?: PoolSizeFilter;

  constructor(
    readonly connection: Connection,
    readonly args: PoolFilterArgs,
  ) {
    logger.debug({ preset: FILTER_PRESET }, 'Initializing pool filters with preset');

    if (CHECK_IF_BURNED) {
      this.burnFilter = new BurnFilter(connection);
      this.filters.push(this.burnFilter);
    }

    if (CHECK_IF_MINT_IS_RENOUNCED || CHECK_IF_FREEZABLE) {
      this.renouncedFreezeFilter = new RenouncedFreezeFilter(connection, CHECK_IF_MINT_IS_RENOUNCED, CHECK_IF_FREEZABLE);
      this.filters.push(this.renouncedFreezeFilter);
    }

    if (CHECK_IF_MUTABLE || CHECK_IF_SOCIALS) {
      this.mutableFilter = new MutableFilter(connection, getMetadataAccountDataSerializer(), CHECK_IF_MUTABLE, CHECK_IF_SOCIALS);
      this.filters.push(this.mutableFilter);
    }

    if (!args.minPoolSize.isZero() || !args.maxPoolSize.isZero()) {
      this.poolSizeFilter = new PoolSizeFilter(connection, args.quoteToken, args.minPoolSize, args.maxPoolSize);
      this.filters.push(this.poolSizeFilter);
    }
  }

  public async execute(poolKeys: LiquidityPoolKeysV4): Promise<boolean> {
    if (this.filters.length === 0) {
      return true;
    }

    const result = await Promise.all(this.filters.map((f) => f.execute(poolKeys)));
    const pass = result.every((r) => r.ok);

    if (pass) {
      return true;
    }

    for (const filterResult of result.filter((r) => !r.ok)) {
      logger.trace(filterResult.message);
    }

    return false;
  }

  /**
   * Execute all filters and return detailed results for dashboard display.
   * This method runs all filters regardless of pass/fail to collect complete data.
   */
  public async executeWithDetails(poolKeys: LiquidityPoolKeysV4): Promise<PoolFilterResults> {
    const tokenMint = poolKeys.baseMint.toString();
    const poolId = poolKeys.id.toString();
    const filters: DetailedFilterResult[] = [];

    // Run all filters in parallel and collect detailed results
    const filterPromises: Promise<DetailedFilterResult[]>[] = [];

    // Burn filter
    if (this.burnFilter) {
      filterPromises.push(this.burnFilter.executeDetailed(poolKeys));
    } else {
      filters.push({
        name: 'burn',
        displayName: 'LP Burned',
        passed: true,
        reason: 'Check disabled',
        checked: false,
      });
    }

    // Renounced/Freeze filter
    if (this.renouncedFreezeFilter) {
      filterPromises.push(this.renouncedFreezeFilter.executeDetailed(poolKeys));
    } else {
      if (!CHECK_IF_MINT_IS_RENOUNCED) {
        filters.push({
          name: 'renounced',
          displayName: 'Mint Renounced',
          passed: true,
          reason: 'Check disabled',
          checked: false,
        });
      }
      if (!CHECK_IF_FREEZABLE) {
        filters.push({
          name: 'freezable',
          displayName: 'Not Freezable',
          passed: true,
          reason: 'Check disabled',
          checked: false,
        });
      }
    }

    // Mutable/Socials filter
    if (this.mutableFilter) {
      filterPromises.push(this.mutableFilter.executeDetailed(poolKeys));
    } else {
      if (!CHECK_IF_MUTABLE) {
        filters.push({
          name: 'mutable',
          displayName: 'Immutable Metadata',
          passed: true,
          reason: 'Check disabled',
          checked: false,
        });
      }
      if (!CHECK_IF_SOCIALS) {
        filters.push({
          name: 'socials',
          displayName: 'Has Socials',
          passed: true,
          reason: 'Check disabled',
          checked: false,
        });
      }
    }

    // Pool size filter
    if (this.poolSizeFilter) {
      filterPromises.push(this.poolSizeFilter.executeDetailed(poolKeys));
    } else {
      filters.push({
        name: 'pool_size',
        displayName: 'Pool Size',
        passed: true,
        reason: 'Check disabled',
        checked: false,
      });
    }

    // Wait for all filter results
    const detailedResults = await Promise.all(filterPromises);
    for (const resultArray of detailedResults) {
      filters.push(...resultArray);
    }

    // Calculate overall result
    const checkedFilters = filters.filter(f => f.checked);
    const allPassed = checkedFilters.length === 0 || checkedFilters.every(f => f.passed);

    // Build summary
    const failedFilters = checkedFilters.filter(f => !f.passed);
    let summary: string;
    if (allPassed) {
      summary = 'All filters passed';
    } else {
      const reasons = failedFilters.map(f => f.displayName).join(', ');
      summary = `Rejected: ${reasons}`;
    }

    return {
      tokenMint,
      poolId,
      filters,
      allPassed,
      summary,
      checkedAt: Date.now(),
    };
  }
}
