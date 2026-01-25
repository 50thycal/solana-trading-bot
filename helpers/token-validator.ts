import { Connection, PublicKey } from '@solana/web3.js';
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
}

/**
 * Get the age of a token by finding its first transaction
 *
 * This function queries the blockchain to find when the token mint was first used,
 * which gives us an approximation of when the token was created.
 *
 * @param connection - Solana RPC connection
 * @param mintAddress - The token mint address to check
 * @param maxAgeSeconds - Maximum age in seconds for a token to be considered "new"
 * @returns TokenAgeResult with age information and whether the token is new
 */
export async function getTokenAge(
  connection: Connection,
  mintAddress: PublicKey,
  maxAgeSeconds: number
): Promise<TokenAgeResult> {
  const currentTime = Math.floor(Date.now() / 1000);

  try {
    // Get signatures for the mint address
    // We request a small number first to check recent activity
    // For brand new tokens, there should be very few signatures
    const signatures = await connection.getSignaturesForAddress(
      mintAddress,
      { limit: 1000 },
      'confirmed'
    );

    if (signatures.length === 0) {
      // Brand new mint with no transaction history yet
      // This is actually the ideal case - truly new
      logger.debug(
        { mint: mintAddress.toString() },
        'Token has no transaction history - brand new'
      );
      return {
        ageSeconds: 0,
        firstTxTime: currentTime,
        firstTxSignature: '',
        isNew: true,
      };
    }

    // The oldest transaction is at the end of the array (signatures are returned newest first)
    const oldestTx = signatures[signatures.length - 1];
    const firstTxTime = oldestTx.blockTime ?? currentTime;
    const ageSeconds = currentTime - firstTxTime;

    const result: TokenAgeResult = {
      ageSeconds,
      firstTxTime,
      firstTxSignature: oldestTx.signature,
      isNew: ageSeconds <= maxAgeSeconds,
    };

    logger.debug(
      {
        mint: mintAddress.toString(),
        ageSeconds,
        maxAgeSeconds,
        isNew: result.isNew,
        totalSignatures: signatures.length,
      },
      `Token age check: ${ageSeconds}s (max: ${maxAgeSeconds}s) ${result.isNew ? 'PASS' : 'FAIL'}`
    );

    return result;
  } catch (error) {
    logger.error(
      { mint: mintAddress.toString(), error },
      'Failed to get token age - defaulting to NOT new (fail-safe)'
    );
    // On error, assume NOT new (fail safe)
    // This prevents buying tokens when we can't verify their age
    return {
      ageSeconds: Infinity,
      firstTxTime: 0,
      firstTxSignature: '',
      isNew: false,
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
