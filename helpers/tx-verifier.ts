/**
 * Transaction Verification Utility
 *
 * Verifies actual token and SOL amounts received from pump.fun transactions
 * rather than relying on calculated/expected values from bonding curve math.
 *
 * Verification strategies (in order of preference):
 * 1. Balance Comparison: Pre vs post transaction balance
 * 2. Transaction Parsing: Extract from transaction metadata
 * 3. Expected Only: Return expected values as fallback
 *
 * @module helpers/tx-verifier
 */

import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  ParsedTransactionWithMeta,
} from '@solana/web3.js';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { logger } from './logger';
import { sleep } from './promises';

// ════════════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Method used for transaction verification
 */
export type VerificationMethod = 'balance_check' | 'tx_parsing' | 'expected_only';

/**
 * Result of verifying a pump.fun transaction
 */
export interface TxVerificationResult {
  /** Whether verification was successful */
  success: boolean;

  /** Transaction signature */
  signature: string;

  // For buys
  /** Actual tokens received (verified) */
  actualTokensReceived?: number;
  /** Expected tokens from bonding curve calculation */
  expectedTokens?: number;
  /** Token slippage percentage (actual vs expected) */
  tokenSlippagePercent?: number;

  // For sells
  /** Actual SOL received (verified) */
  actualSolReceived?: number;
  /** Expected SOL from bonding curve calculation */
  expectedSol?: number;
  /** SOL slippage percentage (actual vs expected) */
  solSlippagePercent?: number;

  /** How the verification was performed */
  verificationMethod: VerificationMethod;

  /** Error message if verification failed */
  error?: string;
}

/**
 * Parameters for verifying a buy transaction
 */
export interface VerifyBuyParams {
  connection: Connection;
  signature: string;
  wallet: PublicKey;
  mint: PublicKey;
  expectedTokens: number;
  tokenProgramId: PublicKey;
  /** Pre-transaction token balance (0 if ATA didn't exist) */
  preBalance: number;
}

/**
 * Parameters for verifying a sell transaction
 */
export interface VerifySellParams {
  connection: Connection;
  signature: string;
  wallet: PublicKey;
  expectedSol: number;
  /** Pre-transaction SOL balance in lamports */
  preBalance: number;
}

/**
 * Balance changes extracted from a parsed transaction
 */
interface ParsedBalanceChanges {
  solChange: number; // In lamports
  tokenChanges: Map<string, { mint: string; change: number }>;
}

// ════════════════════════════════════════════════════════════════════════════
// RETRY CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 2000;

/**
 * Calculate exponential backoff delay
 */
function getBackoffDelay(attempt: number): number {
  return Math.min(INITIAL_BACKOFF_MS * Math.pow(2, attempt), MAX_BACKOFF_MS);
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Verify actual tokens received from a pump.fun buy transaction
 *
 * Strategy:
 * 1. Attempt balance comparison (pre vs post balance)
 * 2. Fall back to transaction parsing if needed
 * 3. Return expected values if all verification fails
 *
 * @param params - Verification parameters
 * @returns Verification result with actual or expected amounts
 */
export async function verifyBuyTransaction(
  params: VerifyBuyParams,
): Promise<TxVerificationResult> {
  const { connection, signature, wallet, mint, expectedTokens, tokenProgramId, preBalance } =
    params;

  try {
    // Strategy 1: Balance comparison (preferred)
    const postBalance = await getTokenBalanceWithRetry(connection, wallet, mint, tokenProgramId);

    if (postBalance !== null) {
      const actualTokensReceived = postBalance - preBalance;
      const slippagePercent = calculateSlippage(expectedTokens, actualTokensReceived);

      // Log significant slippage
      if (Math.abs(slippagePercent) > 5) {
        logger.warn(
          {
            signature,
            mint: mint.toString(),
            expected: expectedTokens,
            actual: actualTokensReceived,
            slippagePercent: slippagePercent.toFixed(2),
          },
          '[tx-verifier] Significant token slippage detected on buy',
        );
      }

      return {
        success: true,
        signature,
        actualTokensReceived,
        expectedTokens,
        tokenSlippagePercent: slippagePercent,
        verificationMethod: 'balance_check',
      };
    }

    // Strategy 2: Transaction parsing (fallback)
    const txBalances = await parseTransactionBalancesWithRetry(connection, signature, wallet);

    if (txBalances) {
      const tokenChange = txBalances.tokenChanges.get(mint.toString());
      if (tokenChange && tokenChange.change > 0) {
        const actualTokensReceived = tokenChange.change;
        const slippagePercent = calculateSlippage(expectedTokens, actualTokensReceived);

        return {
          success: true,
          signature,
          actualTokensReceived,
          expectedTokens,
          tokenSlippagePercent: slippagePercent,
          verificationMethod: 'tx_parsing',
        };
      }
    }

    // Strategy 3: Return expected (last resort)
    logger.warn(
      { signature, mint: mint.toString() },
      '[tx-verifier] Could not verify buy - using expected values',
    );

    return {
      success: false,
      signature,
      actualTokensReceived: expectedTokens,
      expectedTokens,
      tokenSlippagePercent: 0,
      verificationMethod: 'expected_only',
      error: 'Verification failed - using expected values',
    };
  } catch (error) {
    logger.error(
      { signature, mint: mint.toString(), error: String(error) },
      '[tx-verifier] Error verifying buy transaction',
    );

    return {
      success: false,
      signature,
      actualTokensReceived: expectedTokens,
      expectedTokens,
      tokenSlippagePercent: 0,
      verificationMethod: 'expected_only',
      error: String(error),
    };
  }
}

/**
 * Verify actual SOL received from a pump.fun sell transaction
 *
 * @param params - Verification parameters
 * @returns Verification result with actual or expected amounts
 */
export async function verifySellTransaction(
  params: VerifySellParams,
): Promise<TxVerificationResult> {
  const { connection, signature, wallet, expectedSol, preBalance } = params;

  try {
    // Strategy 1: Balance comparison (preferred)
    const postBalance = await getSolBalanceWithRetry(connection, wallet);

    if (postBalance !== null) {
      // Calculate raw change (includes tx fees)
      const rawChange = postBalance - preBalance;

      // Get transaction fee to adjust the calculation
      const txFee = await getTransactionFeeWithRetry(connection, signature);

      // Actual SOL received = balance change + tx fee (fee is already deducted from balance)
      const actualSolReceivedLamports = rawChange + (txFee ?? 0);
      const actualSolReceived = actualSolReceivedLamports / LAMPORTS_PER_SOL;
      const slippagePercent = calculateSlippage(expectedSol, actualSolReceived);

      // Log significant slippage
      if (Math.abs(slippagePercent) > 5) {
        logger.warn(
          {
            signature,
            wallet: wallet.toString(),
            expected: expectedSol,
            actual: actualSolReceived,
            slippagePercent: slippagePercent.toFixed(2),
          },
          '[tx-verifier] Significant SOL slippage detected on sell',
        );
      }

      return {
        success: true,
        signature,
        actualSolReceived,
        expectedSol,
        solSlippagePercent: slippagePercent,
        verificationMethod: 'balance_check',
      };
    }

    // Strategy 2: Transaction parsing (fallback)
    const txBalances = await parseTransactionBalancesWithRetry(connection, signature, wallet);

    if (txBalances && txBalances.solChange > 0) {
      const actualSolReceived = txBalances.solChange / LAMPORTS_PER_SOL;
      const slippagePercent = calculateSlippage(expectedSol, actualSolReceived);

      return {
        success: true,
        signature,
        actualSolReceived,
        expectedSol,
        solSlippagePercent: slippagePercent,
        verificationMethod: 'tx_parsing',
      };
    }

    // Strategy 3: Return expected (last resort)
    logger.warn({ signature }, '[tx-verifier] Could not verify sell - using expected values');

    return {
      success: false,
      signature,
      actualSolReceived: expectedSol,
      expectedSol,
      solSlippagePercent: 0,
      verificationMethod: 'expected_only',
      error: 'Verification failed - using expected values',
    };
  } catch (error) {
    logger.error({ signature, error: String(error) }, '[tx-verifier] Error verifying sell transaction');

    return {
      success: false,
      signature,
      actualSolReceived: expectedSol,
      expectedSol,
      solSlippagePercent: 0,
      verificationMethod: 'expected_only',
      error: String(error),
    };
  }
}

/**
 * Get pre-transaction token balance
 * Call this BEFORE sending the transaction
 *
 * @returns Token balance in smallest units (0 if ATA doesn't exist)
 */
export async function getPreTxTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): Promise<number> {
  const balance = await getTokenBalanceWithRetry(connection, wallet, mint, tokenProgramId);
  return balance ?? 0;
}

/**
 * Get pre-transaction SOL balance
 * Call this BEFORE sending the transaction
 *
 * @returns SOL balance in lamports
 */
export async function getPreTxSolBalance(connection: Connection, wallet: PublicKey): Promise<number> {
  const balance = await getSolBalanceWithRetry(connection, wallet);
  return balance ?? 0;
}

// ════════════════════════════════════════════════════════════════════════════
// TOKEN BALANCE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get token balance with retry logic
 *
 * @returns Token balance in smallest units, or null if account doesn't exist
 */
async function getTokenBalanceWithRetry(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): Promise<number | null> {
  const tokenAta = getAssociatedTokenAddressSync(
    mint,
    wallet,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const account = await getAccount(connection, tokenAta, 'confirmed', tokenProgramId);
      return Number(account.amount);
    } catch (error) {
      // Check if it's a "token account not found" error
      // This is expected if the ATA was just created or doesn't exist yet
      if (isTokenAccountNotFoundError(error)) {
        return 0;
      }

      // For other errors, retry with backoff
      if (attempt < MAX_RETRIES - 1) {
        const delay = getBackoffDelay(attempt);
        logger.debug(
          { mint: mint.toString(), attempt, delay },
          '[tx-verifier] Retrying token balance fetch',
        );
        await sleep(delay);
      }
    }
  }

  logger.warn({ mint: mint.toString() }, '[tx-verifier] Failed to get token balance after retries');
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// SOL BALANCE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get SOL balance with retry logic
 *
 * @returns SOL balance in lamports, or null if failed
 */
async function getSolBalanceWithRetry(
  connection: Connection,
  wallet: PublicKey,
): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await connection.getBalance(wallet, 'confirmed');
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = getBackoffDelay(attempt);
        logger.debug(
          { wallet: wallet.toString(), attempt, delay },
          '[tx-verifier] Retrying SOL balance fetch',
        );
        await sleep(delay);
      }
    }
  }

  logger.warn({ wallet: wallet.toString() }, '[tx-verifier] Failed to get SOL balance after retries');
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// TRANSACTION PARSING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get transaction fee with retry logic
 */
async function getTransactionFeeWithRetry(
  connection: Connection,
  signature: string,
): Promise<number | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      return tx?.meta?.fee ?? null;
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = getBackoffDelay(attempt);
        await sleep(delay);
      }
    }
  }
  return null;
}

/**
 * Parse transaction to extract balance changes with retry logic
 *
 * Uses preBalances/postBalances and preTokenBalances/postTokenBalances
 * from the parsed transaction metadata
 */
async function parseTransactionBalancesWithRetry(
  connection: Connection,
  signature: string,
  wallet: PublicKey,
): Promise<ParsedBalanceChanges | null> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const tx = await connection.getParsedTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });

      if (!tx || !tx.meta || tx.meta.err) {
        if (attempt < MAX_RETRIES - 1) {
          const delay = getBackoffDelay(attempt);
          logger.debug(
            { signature, attempt, delay },
            '[tx-verifier] Transaction not found or has error, retrying',
          );
          await sleep(delay);
          continue;
        }
        return null;
      }

      return extractBalanceChanges(tx, wallet);
    } catch (error) {
      if (attempt < MAX_RETRIES - 1) {
        const delay = getBackoffDelay(attempt);
        logger.debug(
          { signature, attempt, delay, error: String(error) },
          '[tx-verifier] Error fetching transaction, retrying',
        );
        await sleep(delay);
      }
    }
  }

  logger.warn({ signature }, '[tx-verifier] Failed to parse transaction after retries');
  return null;
}

/**
 * Extract balance changes from a parsed transaction
 */
function extractBalanceChanges(
  tx: ParsedTransactionWithMeta,
  wallet: PublicKey,
): ParsedBalanceChanges {
  const walletStr = wallet.toString();
  const accountKeys = tx.transaction.message.accountKeys;

  // Find wallet index in account keys
  let walletIndex = -1;
  for (let i = 0; i < accountKeys.length; i++) {
    if (accountKeys[i].pubkey.toString() === walletStr) {
      walletIndex = i;
      break;
    }
  }

  // Calculate SOL change
  let solChange = 0;
  if (walletIndex >= 0 && tx.meta?.preBalances && tx.meta?.postBalances) {
    const pre = tx.meta.preBalances[walletIndex] ?? 0;
    const post = tx.meta.postBalances[walletIndex] ?? 0;
    // Add back the fee to get the actual received amount
    const fee = tx.meta.fee ?? 0;
    solChange = post - pre + fee;
  }

  // Calculate token changes
  const tokenChanges = new Map<string, { mint: string; change: number }>();

  const preTokenBalances = tx.meta?.preTokenBalances ?? [];
  const postTokenBalances = tx.meta?.postTokenBalances ?? [];

  // Build a map of post-balances by owner+mint
  const postBalanceMap = new Map<string, number>();
  for (const balance of postTokenBalances) {
    if (balance.owner === walletStr) {
      const key = `${balance.owner}:${balance.mint}`;
      postBalanceMap.set(key, Number(balance.uiTokenAmount?.amount ?? '0'));
    }
  }

  // Build a map of pre-balances by owner+mint
  const preBalanceMap = new Map<string, number>();
  for (const balance of preTokenBalances) {
    if (balance.owner === walletStr) {
      const key = `${balance.owner}:${balance.mint}`;
      preBalanceMap.set(key, Number(balance.uiTokenAmount?.amount ?? '0'));
    }
  }

  // Calculate changes for each token
  const allMints = new Set<string>();
  for (const balance of [...preTokenBalances, ...postTokenBalances]) {
    if (balance.owner === walletStr) {
      allMints.add(balance.mint);
    }
  }

  for (const mint of allMints) {
    const key = `${walletStr}:${mint}`;
    const pre = preBalanceMap.get(key) ?? 0;
    const post = postBalanceMap.get(key) ?? 0;
    const change = post - pre;

    if (change !== 0) {
      tokenChanges.set(mint, { mint, change });
    }
  }

  return { solChange, tokenChanges };
}

// ════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Calculate slippage percentage between expected and actual values
 * Positive = received more than expected
 * Negative = received less than expected
 */
function calculateSlippage(expected: number, actual: number): number {
  if (expected === 0) return 0;
  return ((actual - expected) / expected) * 100;
}

/**
 * Check if an error is a "token account not found" error
 */
function isTokenAccountNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('could not find account') ||
      message.includes('account not found') ||
      message.includes('tokenaccountnotfounderror')
    );
  }
  return false;
}
