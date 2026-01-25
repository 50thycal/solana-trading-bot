import { Connection, PublicKey } from '@solana/web3.js';
import { getMintCache } from '../cache/mint.cache';
import { logger } from './logger';

/**
 * Result of token age validation
 */
export interface TokenAgeResult {
  /** Age of the token in seconds since first transaction */
  ageSeconds: number;
  /** Unix timestamp of the first transaction for this mint */
  firstTxTime: number;
  /** Signature of the first transaction */
  firstTxSignature: string;
  /** Whether the token is considered "new" (age <= maxAgeSeconds) */
  isNew: boolean;
  /** How the age was determined */
  source: 'cache' | 'helius-history' | 'standard-rpc' | 'error';
}

/**
 * Get token age with proper ordering using Helius-specific API
 *
 * This function uses a multi-tier approach:
 * 1. First, check the mint cache (fastest path - from mint detection)
 * 2. If not cached, try Helius getTransactionsForAddress with sortOrder: "asc"
 * 3. Fallback to standard RPC if Helius-specific method fails
 *
 * IMPORTANT: Standard getSignaturesForAddress returns NEWEST first (descending).
 * Helius getTransactionsForAddress supports sortOrder: "asc" for OLDEST first.
 *
 * @param connection - Solana RPC connection (should be Helius for full functionality)
 * @param mintAddress - The token mint address to check
 * @param maxAgeSeconds - Maximum age in seconds for a token to be considered "new"
 * @returns TokenAgeResult with age information, source, and whether the token is new
 */
export async function getTokenAge(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<TokenAgeResult> {
  const currentTime = Math.floor(Date.now() / 1000);

  // First check mint cache (fastest path - populated by mint listener)
  const mintCache = getMintCache();
  const cachedAge = mintCache.getAge(mintAddress);

  if (cachedAge !== undefined) {
    const cached = mintCache.get(mintAddress)!;
    const result: TokenAgeResult = {
      ageSeconds: cachedAge,
      firstTxTime: Math.floor(cached.detectedAt / 1000),
      firstTxSignature: cached.signature || '',
      isNew: cachedAge <= maxAgeSeconds,
      source: 'cache',
    };

    logger.debug(
      {
        mint: mintAddress.toString(),
        ageSeconds: cachedAge,
        maxAgeSeconds,
        isNew: result.isNew,
        source: 'cache',
        detectedVia: cached.source,
      },
      `Token age from cache: ${cachedAge}s (max: ${maxAgeSeconds}s) ${result.isNew ? 'PASS' : 'FAIL'}`
    );

    return result;
  }

  // Try Helius-specific getTransactionsForAddress with sortOrder: "asc"
  try {
    const result = await getTokenAgeHelius(connection, mintAddress, maxAgeSeconds);
    if (result.source === 'helius-history') {
      return result;
    }
  } catch (error) {
    logger.debug({ mint: mintAddress.toString(), error }, 'Helius method failed, falling back to standard RPC');
  }

  // Fallback to standard RPC
  return getTokenAgeStandardRpc(connection, mintAddress, maxAgeSeconds);
}

/**
 * Get token age using Helius getTransactionsForAddress with sortOrder: "asc"
 *
 * This is the preferred method when using Helius RPC as it correctly returns
 * the oldest transaction first, giving us the true token creation time.
 */
async function getTokenAgeHelius(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<TokenAgeResult> {
  const currentTime = Math.floor(Date.now() / 1000);
  const mintCache = getMintCache();

  try {
    // Use Helius-specific RPC method
    // @ts-ignore - Custom Helius method not in standard types
    const response = await connection._rpcRequest('getTransactionsForAddress', [
      mintAddress.toString(),
      {
        limit: 1,
        sortOrder: 'asc', // CRITICAL: Oldest first (Helius-specific)
        commitment: 'confirmed',
      },
    ]);

    if (response.result && response.result.length > 0) {
      const firstTx = response.result[0];
      const firstTxTime = firstTx.blockTime ?? currentTime;
      const ageSeconds = currentTime - firstTxTime;

      // Add to cache for future lookups
      mintCache.add(mintAddress, 'fallback', firstTx.signature);

      const result: TokenAgeResult = {
        ageSeconds,
        firstTxTime,
        firstTxSignature: firstTx.signature,
        isNew: ageSeconds <= maxAgeSeconds,
        source: 'helius-history',
      };

      logger.debug(
        {
          mint: mintAddress.toString(),
          ageSeconds,
          maxAgeSeconds,
          isNew: result.isNew,
          source: 'helius-history',
        },
        `Token age via Helius: ${ageSeconds}s (max: ${maxAgeSeconds}s) ${result.isNew ? 'PASS' : 'FAIL'}`
      );

      return result;
    }

    // No history found - likely brand new
    logger.debug({ mint: mintAddress.toString() }, 'Token has no transaction history via Helius - brand new');

    return {
      ageSeconds: 0,
      firstTxTime: currentTime,
      firstTxSignature: '',
      isNew: true,
      source: 'helius-history',
    };
  } catch (error) {
    // Re-throw to trigger fallback
    throw error;
  }
}

/**
 * Standard Solana RPC fallback for token age validation
 *
 * WARNING: getSignaturesForAddress returns signatures in REVERSE chronological
 * order (newest first). This makes finding the "first" transaction potentially
 * inaccurate for tokens with many transactions.
 *
 * This is used as a fallback when Helius-specific methods are unavailable.
 */
async function getTokenAgeStandardRpc(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<TokenAgeResult> {
  const currentTime = Math.floor(Date.now() / 1000);
  const mintCache = getMintCache();

  try {
    // Get signatures (newest first - this is a limitation)
    const signatures = await connection.getSignaturesForAddress(
      mintAddress,
      { limit: 1000 }, // Get many to increase chance of finding oldest
      'confirmed'
    );

    if (signatures.length === 0) {
      // Brand new mint with no transaction history
      logger.debug(
        { mint: mintAddress.toString() },
        'Token has no transaction history - brand new'
      );
      return {
        ageSeconds: 0,
        firstTxTime: currentTime,
        firstTxSignature: '',
        isNew: true,
        source: 'standard-rpc',
      };
    }

    // Last in array is oldest (within our limit)
    // WARNING: This may not be the TRUE oldest if token has >1000 txs
    const oldestInBatch = signatures[signatures.length - 1];
    const oldestTime = oldestInBatch.blockTime ?? currentTime;
    const ageSeconds = currentTime - oldestTime;

    // If oldest in batch is already too old, token is definitely old
    if (ageSeconds > maxAgeSeconds) {
      logger.debug(
        {
          mint: mintAddress.toString(),
          ageSeconds,
          maxAgeSeconds,
          signaturesFound: signatures.length,
        },
        `Token is too old: ${ageSeconds}s > ${maxAgeSeconds}s FAIL`
      );

      return {
        ageSeconds,
        firstTxTime: oldestTime,
        firstTxSignature: oldestInBatch.signature,
        isNew: false,
        source: 'standard-rpc',
      };
    }

    // If we got fewer than limit, we have all signatures
    if (signatures.length < 1000) {
      // Add to cache for future lookups
      mintCache.add(mintAddress, 'fallback', oldestInBatch.signature);

      const result: TokenAgeResult = {
        ageSeconds,
        firstTxTime: oldestTime,
        firstTxSignature: oldestInBatch.signature,
        isNew: true,
        source: 'standard-rpc',
      };

      logger.debug(
        {
          mint: mintAddress.toString(),
          ageSeconds,
          maxAgeSeconds,
          isNew: result.isNew,
          totalSignatures: signatures.length,
        },
        `Token age via standard RPC: ${ageSeconds}s (max: ${maxAgeSeconds}s) ${result.isNew ? 'PASS' : 'FAIL'}`
      );

      return result;
    }

    // Got exactly 1000 - there may be more, oldest is unknown
    // Be conservative: treat as old
    logger.warn(
      {
        mint: mintAddress.toString(),
        signaturesFound: signatures.length,
        oldestInBatchAge: ageSeconds,
      },
      'Token has many signatures, cannot determine true age - treating as old for safety'
    );

    return {
      ageSeconds: Infinity,
      firstTxTime: 0,
      firstTxSignature: '',
      isNew: false,
      source: 'standard-rpc',
    };
  } catch (error) {
    logger.error(
      { mint: mintAddress.toString(), error },
      'Failed to get token age - defaulting to NOT new (fail-safe)'
    );

    // On error, assume NOT new (fail safe)
    return {
      ageSeconds: Infinity,
      firstTxTime: 0,
      firstTxSignature: '',
      isNew: false,
      source: 'error',
    };
  }
}

/**
 * Validate that a token is newly created
 *
 * Convenience wrapper around getTokenAge that returns just the boolean result.
 * Useful when you only need to know if the token is new or not.
 *
 * @param connection - Solana RPC connection
 * @param mintAddress - The token mint address to check
 * @param maxAgeSeconds - Maximum age in seconds for a token to be considered "new"
 * @returns true if the token is new (age <= maxAgeSeconds), false otherwise
 */
export async function isTokenNew(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<boolean> {
  const result = await getTokenAge(connection, mintAddress, maxAgeSeconds);
  return result.isNew;
}

/**
 * Check if a mint is in the recently-minted cache
 *
 * This is the fastest check and should be used when only cache presence
 * matters (e.g., for launch confidence scoring).
 *
 * @param mintAddress - The token mint address to check
 * @returns true if the mint is in the cache, false otherwise
 */
export function isMintInCache(mintAddress: PublicKey): boolean {
  return getMintCache().has(mintAddress);
}

/**
 * Get the age of a mint from the cache only
 *
 * @param mintAddress - The token mint address to check
 * @returns Age in seconds if in cache, undefined otherwise
 */
export function getMintAgeFromCache(mintAddress: PublicKey): number | undefined {
  return getMintCache().getAge(mintAddress);
}
