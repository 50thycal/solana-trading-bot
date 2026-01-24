import { PublicKey } from '@solana/web3.js';
import {
  CpmmPoolInfoLayout,
  CREATE_CPMM_POOL_PROGRAM,
  getPdaPoolAuthority,
} from '@raydium-io/raydium-sdk-v2';
import BN from 'bn.js';

/**
 * CPMM Program ID - CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
 */
export const CPMM_PROGRAM_ID = CREATE_CPMM_POOL_PROGRAM;

/**
 * Export the CPMM pool layout from V2 SDK for external use
 */
export { CpmmPoolInfoLayout };

/**
 * Decoded CPMM pool state
 */
export type CpmmPoolState = ReturnType<typeof CpmmPoolInfoLayout.decode>;

/**
 * Pool keys structure for CPMM pools (similar to LiquidityPoolKeysV4)
 */
export interface CpmmPoolKeys {
  id: PublicKey;
  programId: PublicKey;
  authority: PublicKey;
  mintA: PublicKey;
  mintB: PublicKey;
  mintLp: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  configId: PublicKey;
  observationId: PublicKey;
  mintDecimalA: number;
  mintDecimalB: number;
  lpDecimals: number;
  mintProgramA: PublicKey;
  mintProgramB: PublicKey;
  poolCreator: PublicKey;
  version: 7; // CPMM version
}

/**
 * CPMM pool status bits
 * Bit 0: enable deposit
 * Bit 1: enable withdraw
 * Bit 2: enable swap
 *
 * Status = 7 means all operations enabled (111 in binary)
 */
export const CPMM_POOL_STATUS = {
  DEPOSIT_ENABLED: 1,  // bit 0
  WITHDRAW_ENABLED: 2, // bit 1
  SWAP_ENABLED: 4,     // bit 2
  ALL_ENABLED: 7,      // all bits set
};

/**
 * Check if CPMM pool has swap enabled
 */
export function isCpmmSwapEnabled(status: number): boolean {
  return (status & CPMM_POOL_STATUS.SWAP_ENABLED) !== 0;
}

/**
 * Create CPMM pool keys from decoded pool state
 * Similar to createPoolKeys for AmmV4, but for CPMM pools
 */
export function createCpmmPoolKeys(
  id: PublicKey,
  accountData: CpmmPoolState,
  programId: PublicKey = CPMM_PROGRAM_ID,
): CpmmPoolKeys {
  const { publicKey: authority } = getPdaPoolAuthority(programId);

  return {
    id,
    programId,
    authority,
    mintA: accountData.mintA,
    mintB: accountData.mintB,
    mintLp: accountData.mintLp,
    vaultA: accountData.vaultA,
    vaultB: accountData.vaultB,
    configId: accountData.configId,
    observationId: accountData.observationId,
    mintDecimalA: accountData.mintDecimalA,
    mintDecimalB: accountData.mintDecimalB,
    lpDecimals: accountData.lpDecimals,
    mintProgramA: accountData.mintProgramA,
    mintProgramB: accountData.mintProgramB,
    poolCreator: accountData.poolCreator,
    version: 7,
  };
}

/**
 * Compute CPMM swap output amount
 * Uses constant product formula: x * y = k
 *
 * @param amountIn - Input amount (raw, not decimals)
 * @param inputReserve - Current reserve of input token
 * @param outputReserve - Current reserve of output token
 * @param tradeFeeRate - Fee rate in basis points (e.g., 25 = 0.25%)
 * @returns Output amount after fees
 */
export function computeCpmmSwapOutput(
  amountIn: BN,
  inputReserve: BN,
  outputReserve: BN,
  tradeFeeRate: BN,
): { amountOut: BN; fee: BN } {
  // Fee denominator is 1_000_000 (1e6 = 100%)
  const FEE_DENOMINATOR = new BN(1_000_000);

  // Calculate fee
  const fee = amountIn.mul(tradeFeeRate).div(FEE_DENOMINATOR);
  const amountInAfterFee = amountIn.sub(fee);

  // Constant product formula: (x + dx) * (y - dy) = x * y
  // dy = y * dx / (x + dx)
  const numerator = outputReserve.mul(amountInAfterFee);
  const denominator = inputReserve.add(amountInAfterFee);
  const amountOut = numerator.div(denominator);

  return { amountOut, fee };
}

/**
 * Compute minimum output with slippage
 */
export function computeMinAmountOut(
  amountOut: BN,
  slippagePercent: number,
): BN {
  // Slippage is in percentage (e.g., 1 = 1%)
  const slippageBps = Math.floor(slippagePercent * 100); // Convert to basis points
  const slippageMultiplier = 10000 - slippageBps;
  return amountOut.mul(new BN(slippageMultiplier)).div(new BN(10000));
}

/**
 * Determine swap direction based on which token is the base/quote
 * Returns true if swapping mintA -> mintB, false if mintB -> mintA
 */
export function getCpmmSwapDirection(
  poolKeys: CpmmPoolKeys,
  inputMint: PublicKey,
): boolean {
  return inputMint.equals(poolKeys.mintA);
}

/**
 * Get the input/output vaults and mints based on swap direction
 */
export function getCpmmSwapAccounts(
  poolKeys: CpmmPoolKeys,
  inputMint: PublicKey,
): {
  inputVault: PublicKey;
  outputVault: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  inputTokenProgram: PublicKey;
  outputTokenProgram: PublicKey;
} {
  const isAToB = getCpmmSwapDirection(poolKeys, inputMint);

  if (isAToB) {
    return {
      inputVault: poolKeys.vaultA,
      outputVault: poolKeys.vaultB,
      inputMint: poolKeys.mintA,
      outputMint: poolKeys.mintB,
      inputTokenProgram: poolKeys.mintProgramA,
      outputTokenProgram: poolKeys.mintProgramB,
    };
  } else {
    return {
      inputVault: poolKeys.vaultB,
      outputVault: poolKeys.vaultA,
      inputMint: poolKeys.mintB,
      outputMint: poolKeys.mintA,
      inputTokenProgram: poolKeys.mintProgramB,
      outputTokenProgram: poolKeys.mintProgramA,
    };
  }
}

/**
 * Adapter to convert CPMM pool keys to a format compatible with existing AmmV4 filters.
 * This allows reusing the same filter logic for both pool types.
 *
 * @param poolKeys - CPMM pool keys
 * @param quoteMint - The quote token mint (e.g., WSOL)
 * @returns An object with the fields needed by pool filters (baseMint, lpMint, quoteVault, id)
 */
export function adaptCpmmPoolKeysForFilters(
  poolKeys: CpmmPoolKeys,
  quoteMint: PublicKey,
): {
  id: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
} {
  // Determine which mint is quote and which is base
  const isQuoteMintA = poolKeys.mintA.equals(quoteMint);

  return {
    id: poolKeys.id,
    baseMint: isQuoteMintA ? poolKeys.mintB : poolKeys.mintA,
    quoteMint: isQuoteMintA ? poolKeys.mintA : poolKeys.mintB,
    lpMint: poolKeys.mintLp,
    baseVault: isQuoteMintA ? poolKeys.vaultB : poolKeys.vaultA,
    quoteVault: isQuoteMintA ? poolKeys.vaultA : poolKeys.vaultB,
  };
}
