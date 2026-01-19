import { Filter, FilterResult, DetailedFilterResult } from './pool-filters';
import { Connection } from '@solana/web3.js';
import { LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { getPdaMetadataKey } from '@raydium-io/raydium-sdk';
import { MetadataAccountData, MetadataAccountDataArgs } from '@metaplex-foundation/mpl-token-metadata';
import { Serializer } from '@metaplex-foundation/umi/serializers';
import { logger } from '../helpers';

export class MutableFilter implements Filter {
  private readonly errorMessage: string[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly metadataSerializer: Serializer<MetadataAccountDataArgs, MetadataAccountData>,
    private readonly checkMutable: boolean,
    private readonly checkSocials: boolean,
  ) {
    if (this.checkMutable) {
      this.errorMessage.push('mutable');
    }

    if (this.checkSocials) {
      this.errorMessage.push('socials');
    }
  }

  async execute(poolKeys: LiquidityPoolKeysV4): Promise<FilterResult> {
    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!metadataAccount?.data) {
        return { ok: false, message: 'Mutable -> Failed to fetch account data' };
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const mutable = !this.checkMutable || deserialize[0].isMutable;
      const hasSocials = !this.checkSocials || (await this.hasSocials(deserialize[0]));
      const ok = !mutable && hasSocials;
      const message: string[] = [];

      if (mutable) {
        message.push('metadata can be changed');
      }

      if (!hasSocials) {
        message.push('has no socials');
      }

      return { ok: ok, message: ok ? undefined : `MutableSocials -> Token ${message.join(' and ')}` };
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`);
    }

    return {
      ok: false,
      message: `MutableSocials -> Failed to check ${this.errorMessage.join(' and ')}`,
    };
  }

  private async hasSocials(metadata: MetadataAccountData): Promise<boolean> {
    try {
      const response = await fetch(metadata.uri);
      const data = await response.json();
      return Object.values(data?.extensions ?? {}).some((value: any) => value !== null && value.length > 0);
    } catch {
      return false;
    }
  }

  /**
   * Execute filter and return detailed results for dashboard
   */
  async executeDetailed(poolKeys: LiquidityPoolKeysV4): Promise<DetailedFilterResult[]> {
    const results: DetailedFilterResult[] = [];

    try {
      const metadataPDA = getPdaMetadataKey(poolKeys.baseMint);
      const metadataAccount = await this.connection.getAccountInfo(metadataPDA.publicKey, this.connection.commitment);

      if (!metadataAccount?.data) {
        if (this.checkMutable) {
          results.push({
            name: 'mutable',
            displayName: 'Immutable Metadata',
            passed: false,
            checked: true,
            reason: 'Failed to fetch metadata account',
          });
        }
        if (this.checkSocials) {
          results.push({
            name: 'socials',
            displayName: 'Has Socials',
            passed: false,
            checked: true,
            reason: 'Failed to fetch metadata account',
          });
        }
        return results;
      }

      const deserialize = this.metadataSerializer.deserialize(metadataAccount.data);
      const metadata = deserialize[0];
      const isMutable = metadata.isMutable;

      // Mutable check
      if (this.checkMutable) {
        const isImmutable = !isMutable;
        results.push({
          name: 'mutable',
          displayName: 'Immutable Metadata',
          passed: isImmutable,
          checked: true,
          reason: isImmutable
            ? 'Metadata is immutable - cannot be changed'
            : 'Metadata is mutable - creator can change token info',
          details: {
            expected: 'Immutable',
            actual: isMutable ? 'Mutable' : 'Immutable',
          },
        });
      }

      // Socials check
      if (this.checkSocials) {
        const hasSocials = await this.hasSocials(metadata);
        results.push({
          name: 'socials',
          displayName: 'Has Socials',
          passed: hasSocials,
          checked: true,
          reason: hasSocials
            ? 'Token has social links in metadata'
            : 'No social links found in metadata',
          details: {
            expected: 'Has social links',
            actual: hasSocials ? 'Has socials' : 'No socials',
          },
        });
      }

      return results;
    } catch (e) {
      logger.error({ mint: poolKeys.baseMint }, `MutableSocials -> Failed to check metadata`);

      if (this.checkMutable) {
        results.push({
          name: 'mutable',
          displayName: 'Immutable Metadata',
          passed: false,
          checked: true,
          reason: 'Error checking metadata mutability',
        });
      }
      if (this.checkSocials) {
        results.push({
          name: 'socials',
          displayName: 'Has Socials',
          passed: false,
          checked: true,
          reason: 'Error checking social links',
        });
      }
      return results;
    }
  }
}
