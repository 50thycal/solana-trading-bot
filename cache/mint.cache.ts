import { PublicKey } from '@solana/web3.js';
import { logger } from '../helpers/logger';

/**
 * Entry in the mint cache representing a recently detected token mint
 */
export interface MintCacheEntry {
  /** The mint public key */
  mint: PublicKey;
  /** Unix timestamp (ms) when we detected the mint */
  detectedAt: number;
  /** How the mint was detected */
  source: 'helius' | 'fallback';
  /** First transaction signature if available */
  signature?: string;
}

/**
 * Cache for recently minted tokens
 *
 * This cache is the primary source of truth for determining if a token
 * is newly minted. The mint listener populates this cache, and pool
 * detection uses it to verify new launches.
 *
 * Key features:
 * - TTL-based expiration (default: MAX_TOKEN_AGE_SECONDS)
 * - Automatic cleanup of expired entries
 * - Thread-safe operations
 * - Statistics tracking for monitoring
 */
export class MintCache {
  private cache: Map<string, MintCacheEntry> = new Map();
  private ttlMs: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Statistics
  private stats = {
    heliusDetected: 0,
    fallbackDetected: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };

  /**
   * Create a new MintCache
   * @param ttlSeconds - Time-to-live in seconds (default: 300 = 5 minutes)
   */
  constructor(ttlSeconds: number = 300) {
    this.ttlMs = ttlSeconds * 1000;

    // Cleanup expired entries every 60 seconds
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);

    logger.debug({ ttlSeconds }, 'MintCache initialized');
  }

  /**
   * Add a mint to the cache
   * @param mint - The mint public key
   * @param source - How the mint was detected ('helius' or 'fallback')
   * @param signature - Optional transaction signature
   */
  add(mint: PublicKey, source: 'helius' | 'fallback', signature?: string): void {
    const key = mint.toString();

    // Don't overwrite existing entries (keep the first detection)
    if (!this.cache.has(key)) {
      this.cache.set(key, {
        mint,
        detectedAt: Date.now(),
        source,
        signature,
      });

      // Update stats
      if (source === 'helius') {
        this.stats.heliusDetected++;
      } else {
        this.stats.fallbackDetected++;
      }

      logger.debug({ mint: key, source, signature }, 'Added mint to cache');
    }
  }

  /**
   * Get a mint entry from the cache
   * @param mint - The mint public key
   * @returns The cache entry if found and not expired, undefined otherwise
   */
  get(mint: PublicKey): MintCacheEntry | undefined {
    const key = mint.toString();
    const entry = this.cache.get(key);

    if (entry && this.isValid(entry)) {
      this.stats.cacheHits++;
      return entry;
    }

    this.stats.cacheMisses++;
    return undefined;
  }

  /**
   * Check if a mint is in the cache
   * @param mint - The mint public key
   * @returns true if the mint is in the cache and not expired
   */
  has(mint: PublicKey): boolean {
    return this.get(mint) !== undefined;
  }

  /**
   * Get the age of a mint in seconds
   * @param mint - The mint public key
   * @returns The age in seconds, or undefined if not in cache
   */
  getAge(mint: PublicKey): number | undefined {
    const entry = this.get(mint);
    if (entry) {
      return Math.floor((Date.now() - entry.detectedAt) / 1000);
    }
    return undefined;
  }

  /**
   * Check if an entry is still valid (not expired)
   */
  private isValid(entry: MintCacheEntry): boolean {
    return Date.now() - entry.detectedAt < this.ttlMs;
  }

  /**
   * Remove expired entries from the cache
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.detectedAt >= this.ttlMs) {
        this.cache.delete(key);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug({ removed, remaining: this.cache.size }, 'Mint cache cleanup');
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    size: number;
    oldestAgeSeconds: number;
    heliusDetected: number;
    fallbackDetected: number;
    cacheHits: number;
    cacheMisses: number;
    hitRate: number;
  } {
    let oldestAge = 0;
    const now = Date.now();

    for (const entry of this.cache.values()) {
      const age = Math.floor((now - entry.detectedAt) / 1000);
      if (age > oldestAge) oldestAge = age;
    }

    const totalLookups = this.stats.cacheHits + this.stats.cacheMisses;
    const hitRate = totalLookups > 0 ? this.stats.cacheHits / totalLookups : 0;

    return {
      size: this.cache.size,
      oldestAgeSeconds: oldestAge,
      heliusDetected: this.stats.heliusDetected,
      fallbackDetected: this.stats.fallbackDetected,
      cacheHits: this.stats.cacheHits,
      cacheMisses: this.stats.cacheMisses,
      hitRate,
    };
  }

  /**
   * Reset statistics (useful for periodic reporting)
   */
  resetStats(): void {
    this.stats = {
      heliusDetected: 0,
      fallbackDetected: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };
  }

  /**
   * Get all entries (for debugging)
   */
  getAll(): MintCacheEntry[] {
    return Array.from(this.cache.values()).filter((entry) => this.isValid(entry));
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
    logger.debug('Mint cache cleared');
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    logger.debug('Mint cache stopped');
  }
}

// Singleton instance - will be initialized with config-based TTL
let mintCacheInstance: MintCache | null = null;

/**
 * Get the global mint cache instance
 * @param ttlSeconds - Optional TTL override (only used on first call)
 */
export function getMintCache(ttlSeconds?: number): MintCache {
  if (!mintCacheInstance) {
    mintCacheInstance = new MintCache(ttlSeconds);
  }
  return mintCacheInstance;
}

/**
 * Initialize the mint cache with specific TTL
 * Should be called once at startup with config value
 */
export function initMintCache(ttlSeconds: number): MintCache {
  if (mintCacheInstance) {
    mintCacheInstance.stop();
  }
  mintCacheInstance = new MintCache(ttlSeconds);
  return mintCacheInstance;
}
