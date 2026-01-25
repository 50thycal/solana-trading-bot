import { logger } from '../helpers/logger';

/**
 * DexScreener API response types
 */
export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
  volume: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  priceChange: {
    m5: number;
    h1: number;
    h6: number;
    h24: number;
  };
  liquidity: {
    usd: number;
    base: number;
    quote: number;
  };
  fdv: number;
  pairCreatedAt: number;
}

interface DexScreenerResponse {
  schemaVersion: string;
  pairs: DexScreenerPair[] | null;
}

/**
 * Result of token verification
 */
export interface TokenVerification {
  isVerified: boolean;
  ageSeconds: number | null;
  source: 'dexscreener' | 'not_indexed' | 'error';
  reason?: string;
  pairs?: DexScreenerPair[];
}

/**
 * Token metadata from DexScreener
 */
export interface TokenMetadata {
  name: string;
  symbol: string;
  priceUsd: string | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  fdv: number | null;
  pairCreatedAt: number | null;
}

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex/tokens';

/**
 * Simple rate limiter for DexScreener API
 * Default: 200 requests per minute (conservative under 300 limit)
 */
class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private refillRate: number;
  private lastRefill: number;

  constructor(requestsPerMinute: number = 200) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.refillRate = requestsPerMinute / 60; // tokens per second
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens < 1) {
      // Wait for a token to become available
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate * 1000);
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      this.refill();
    }

    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// Global rate limiter instance
const rateLimiter = new RateLimiter();

/**
 * Verify token age via DexScreener API.
 *
 * ONLY called for cache misses (tokens we didn't detect via mint listener).
 * For cache hits, this function is NOT called - we trust our detection.
 *
 * @param mintAddress - The token mint address to verify
 * @param maxAgeSeconds - Maximum age in seconds for a token to be considered "new"
 * @returns TokenVerification result
 *
 * @example
 * ```typescript
 * // In pool detection handler:
 * if (mintCache.has(baseMint)) {
 *   // Cache hit - trust our detection, proceed immediately
 *   await executeBuy(pool);
 * } else {
 *   // Cache miss - verify via API before buying
 *   const verification = await verifyTokenAge(baseMint.toString(), 300);
 *   if (verification.isVerified) {
 *     await executeBuy(pool);
 *   } else {
 *     logger.info({ mint: baseMint.toString(), reason: verification.reason }, 'Rejected');
 *   }
 * }
 * ```
 */
export async function verifyTokenAge(
  mintAddress: string,
  maxAgeSeconds: number
): Promise<TokenVerification> {
  try {
    // Respect rate limits
    await rateLimiter.acquire();

    const response = await fetch(`${DEXSCREENER_BASE_URL}/${mintAddress}`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      logger.warn(
        { mintAddress, status: response.status },
        'DexScreener API error'
      );
      return {
        isVerified: false,
        ageSeconds: null,
        source: 'error',
        reason: `API returned ${response.status}`,
      };
    }

    const data: DexScreenerResponse = await response.json();

    // Token not indexed yet (very new or unknown)
    if (!data.pairs || data.pairs.length === 0) {
      return {
        isVerified: false,
        ageSeconds: null,
        source: 'not_indexed',
        reason: 'Token not found in DexScreener (may be too new)',
      };
    }

    // Get oldest pair creation time (earliest known trading activity)
    const oldestPair = data.pairs.reduce((oldest, pair) =>
      pair.pairCreatedAt < oldest.pairCreatedAt ? pair : oldest
    );

    const ageSeconds = Math.floor((Date.now() - oldestPair.pairCreatedAt) / 1000);
    const isNew = ageSeconds <= maxAgeSeconds;

    logger.debug(
      {
        mintAddress,
        ageSeconds,
        maxAgeSeconds,
        isNew,
        pairsFound: data.pairs.length,
      },
      'DexScreener token verification result'
    );

    return {
      isVerified: isNew,
      ageSeconds,
      source: 'dexscreener',
      reason: isNew ? undefined : `Token is ${ageSeconds}s old (max: ${maxAgeSeconds}s)`,
      pairs: data.pairs,
    };
  } catch (error) {
    logger.error({ mintAddress, error }, 'DexScreener verification failed');
    return {
      isVerified: false,
      ageSeconds: null,
      source: 'error',
      reason: String(error),
    };
  }
}

/**
 * Get token metadata from DexScreener
 *
 * Useful for getting additional information about a token after detection.
 *
 * @param mintAddress - The token mint address
 * @returns TokenMetadata or null if not found
 */
export async function getTokenMetadata(mintAddress: string): Promise<TokenMetadata | null> {
  try {
    // Respect rate limits
    await rateLimiter.acquire();

    const response = await fetch(`${DEXSCREENER_BASE_URL}/${mintAddress}`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data: DexScreenerResponse = await response.json();

    if (!data.pairs || data.pairs.length === 0) {
      return null;
    }

    // Use the pair with highest liquidity for metadata
    const bestPair = data.pairs.reduce((best, pair) =>
      (pair.liquidity?.usd || 0) > (best.liquidity?.usd || 0) ? pair : best
    );

    return {
      name: bestPair.baseToken.name,
      symbol: bestPair.baseToken.symbol,
      priceUsd: bestPair.priceUsd,
      liquidityUsd: bestPair.liquidity?.usd || null,
      volume24h: bestPair.volume?.h24 || null,
      fdv: bestPair.fdv || null,
      pairCreatedAt: bestPair.pairCreatedAt || null,
    };
  } catch (error) {
    logger.debug({ mintAddress, error }, 'Failed to get token metadata from DexScreener');
    return null;
  }
}

/**
 * Get all trading pairs for a token
 *
 * @param mintAddress - The token mint address
 * @returns Array of DexScreenerPair or empty array
 */
export async function getTokenPairs(mintAddress: string): Promise<DexScreenerPair[]> {
  try {
    // Respect rate limits
    await rateLimiter.acquire();

    const response = await fetch(`${DEXSCREENER_BASE_URL}/${mintAddress}`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return [];
    }

    const data: DexScreenerResponse = await response.json();
    return data.pairs || [];
  } catch (error) {
    logger.debug({ mintAddress, error }, 'Failed to get token pairs from DexScreener');
    return [];
  }
}

/**
 * Check if a token is indexed on DexScreener
 *
 * Quick check without full verification logic.
 *
 * @param mintAddress - The token mint address
 * @returns true if indexed, false otherwise
 */
export async function isTokenIndexed(mintAddress: string): Promise<boolean> {
  try {
    await rateLimiter.acquire();

    const response = await fetch(`${DEXSCREENER_BASE_URL}/${mintAddress}`, {
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return false;
    }

    const data: DexScreenerResponse = await response.json();
    return data.pairs !== null && data.pairs.length > 0;
  } catch {
    return false;
  }
}

/**
 * Filter pairs to only include Solana pairs
 *
 * @param pairs - Array of DexScreenerPair
 * @returns Filtered array with only Solana pairs
 */
export function filterSolanaPairs(pairs: DexScreenerPair[]): DexScreenerPair[] {
  return pairs.filter((pair) => pair.chainId === 'solana');
}

/**
 * Get total liquidity across all pairs for a token
 *
 * @param pairs - Array of DexScreenerPair
 * @returns Total liquidity in USD
 */
export function getTotalLiquidity(pairs: DexScreenerPair[]): number {
  return pairs.reduce((total, pair) => total + (pair.liquidity?.usd || 0), 0);
}

/**
 * Get total 24h volume across all pairs for a token
 *
 * @param pairs - Array of DexScreenerPair
 * @returns Total 24h volume in USD
 */
export function getTotalVolume24h(pairs: DexScreenerPair[]): number {
  return pairs.reduce((total, pair) => total + (pair.volume?.h24 || 0), 0);
}
