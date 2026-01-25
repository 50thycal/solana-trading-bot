import { PublicKey } from '@solana/web3.js';
import * as BufferLayout from '@solana/buffer-layout';
import BN from 'bn.js';

/**
 * Meteora DLMM Program ID
 * See: https://solscan.io/account/LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo
 */
export const DLMM_PROGRAM_ID = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo');

/**
 * Decoded DLMM LbPair pool state interface
 */
export interface DlmmPoolState {
  discriminator: Buffer;
  parameters: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  lbMint: PublicKey;
  oracle: PublicKey;
  activeId: number;
  binStep: number;
  status: number;
  activationPoint: BN;
  creator: PublicKey;
}

/**
 * Raw decoded layout data (buffers for PublicKeys)
 */
interface RawDlmmLayoutData {
  discriminator: Uint8Array;
  parameters: Uint8Array;
  reserveX: Uint8Array;
  reserveY: Uint8Array;
  tokenXMint: Uint8Array;
  tokenYMint: Uint8Array;
  lbMint: Uint8Array;
  oracle: Uint8Array;
  activeId: number;
  binStep: number;
  status: number;
  padding1: number;
  padding2: number;
  padding3: number;
  padding4: number;
  padding5: number;
  activationPoint: Uint8Array;
  swapCapDeactivatePoint: Uint8Array;
  maxSwappedAmount: Uint8Array;
  lockDurationForVesting: Uint8Array;
  creator: Uint8Array;
}

/**
 * DLMM LbPair account layout
 * Based on Meteora's DLMM program structure (corrected field order)
 *
 * IMPORTANT: Field order based on Meteora DLMM SDK - tokenXMint and tokenYMint
 * come right after discriminator, not after parameters/reserves.
 */
export const DlmmLbPairLayout = BufferLayout.struct<RawDlmmLayoutData>([
  // Account discriminator (8 bytes) - Anchor accounts start with this
  BufferLayout.blob(8, 'discriminator'),

  // Token mints - IMMEDIATELY after discriminator (confirmed from Go SDK)
  BufferLayout.blob(32, 'tokenXMint'),
  BufferLayout.blob(32, 'tokenYMint'),

  // Vault public keys (token accounts, not mints)
  BufferLayout.blob(32, 'reserveX'),   // Token X vault
  BufferLayout.blob(32, 'reserveY'),   // Token Y vault

  // LP mint
  BufferLayout.blob(32, 'lbMint'),

  // Oracle
  BufferLayout.blob(32, 'oracle'),

  // Bin info
  BufferLayout.s32('activeId'),          // Current active bin (signed)
  BufferLayout.u16('binStep'),           // Bin step in basis points

  // Status - 0 = disabled, 1 = enabled
  BufferLayout.u8('status'),

  // Padding for alignment
  BufferLayout.u8('padding1'),
  BufferLayout.u8('padding2'),
  BufferLayout.u8('padding3'),
  BufferLayout.u8('padding4'),
  BufferLayout.u8('padding5'),

  // Activation point (slot or timestamp)
  BufferLayout.blob(8, 'activationPoint'),

  // Swap cap deactivate point
  BufferLayout.blob(8, 'swapCapDeactivatePoint'),

  // Max swapped amount
  BufferLayout.blob(8, 'maxSwappedAmount'),

  // Lock durations
  BufferLayout.blob(8, 'lockDurationForVesting'),

  // Creator public key
  BufferLayout.blob(32, 'creator'),

  // Parameters (moved to end - was incorrectly at position 2)
  BufferLayout.blob(32, 'parameters'),
]);

/**
 * LbPair account discriminator (first 8 bytes)
 * This is sha256("account:LbPair")[0..8] in Anchor
 * Used to identify LbPair accounts vs other DLMM account types
 */
export const LBPAIR_DISCRIMINATOR = Buffer.from([33, 11, 49, 98, 181, 101, 177, 13]);

/**
 * Check if the account data has the LbPair discriminator
 */
export function isLbPairAccount(data: Buffer): boolean {
  if (data.length < 8) return false;
  const discriminator = data.subarray(0, 8);
  return discriminator.equals(LBPAIR_DISCRIMINATOR);
}

/**
 * Decode DLMM pool state from buffer and convert to typed interface
 */
export function decodeDlmmPoolState(data: Buffer): DlmmPoolState {
  const decoded = DlmmLbPairLayout.decode(data);

  return {
    discriminator: Buffer.from(decoded.discriminator),
    parameters: new PublicKey(decoded.parameters),
    reserveX: new PublicKey(decoded.reserveX),
    reserveY: new PublicKey(decoded.reserveY),
    tokenXMint: new PublicKey(decoded.tokenXMint),
    tokenYMint: new PublicKey(decoded.tokenYMint),
    lbMint: new PublicKey(decoded.lbMint),
    oracle: new PublicKey(decoded.oracle),
    activeId: decoded.activeId,
    binStep: decoded.binStep,
    status: decoded.status,
    activationPoint: new BN(decoded.activationPoint, 'le'),
    creator: new PublicKey(decoded.creator),
  };
}

/**
 * Pool keys structure for DLMM pools
 */
export interface DlmmPoolKeys {
  id: PublicKey;
  programId: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  lbMint: PublicKey;
  oracle: PublicKey;
  activeId: number;
  binStep: number;
  status: number;
  creator: PublicKey;
  activationPoint: BN;
  version: 'DLMM';
}

/**
 * DLMM pool status values
 * Status = 0: Pool is disabled
 * Status = 1: Pool is enabled for trading
 * Status = 2: Pool is in bootstrap phase (pre-activation)
 */
export const DLMM_POOL_STATUS = {
  DISABLED: 0,
  ENABLED: 1,
  BOOTSTRAP: 2,
};

/**
 * Check if DLMM pool is enabled for trading
 */
export function isDlmmPoolEnabled(status: number): boolean {
  return status === DLMM_POOL_STATUS.ENABLED;
}

/**
 * Check if DLMM pool has been activated (past activation point)
 * @param activationPoint - The activation timestamp or slot
 * @param currentTimestamp - Current unix timestamp in seconds
 */
export function isDlmmPoolActivated(activationPoint: BN, currentTimestamp: number): boolean {
  // If activation point is 0, pool is immediately active
  if (activationPoint.isZero()) {
    return true;
  }
  // Compare with current timestamp
  return activationPoint.lte(new BN(currentTimestamp));
}

/**
 * Create DLMM pool keys from decoded pool state
 */
export function createDlmmPoolKeys(
  id: PublicKey,
  accountData: DlmmPoolState,
  programId: PublicKey = DLMM_PROGRAM_ID,
): DlmmPoolKeys {
  return {
    id,
    programId,
    tokenXMint: accountData.tokenXMint,
    tokenYMint: accountData.tokenYMint,
    reserveX: accountData.reserveX,
    reserveY: accountData.reserveY,
    lbMint: accountData.lbMint,
    oracle: accountData.oracle,
    activeId: accountData.activeId,
    binStep: accountData.binStep,
    status: accountData.status,
    creator: accountData.creator,
    activationPoint: accountData.activationPoint,
    version: 'DLMM',
  };
}

/**
 * Adapter to convert DLMM pool keys to a format compatible with existing AmmV4 filters.
 * This allows reusing the same filter logic for all pool types.
 *
 * @param poolKeys - DLMM pool keys
 * @param quoteMint - The quote token mint (e.g., WSOL)
 * @returns An object with the fields needed by pool filters (baseMint, lpMint, quoteVault, id)
 */
export function adaptDlmmPoolKeysForFilters(
  poolKeys: DlmmPoolKeys,
  quoteMint: PublicKey,
): {
  id: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  lpMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
} {
  // Determine which token is quote and which is base
  // In DLMM, tokenX and tokenY can be in any order
  const isQuoteX = poolKeys.tokenXMint.equals(quoteMint);

  return {
    id: poolKeys.id,
    baseMint: isQuoteX ? poolKeys.tokenYMint : poolKeys.tokenXMint,
    quoteMint: isQuoteX ? poolKeys.tokenXMint : poolKeys.tokenYMint,
    lpMint: poolKeys.lbMint,
    baseVault: isQuoteX ? poolKeys.reserveY : poolKeys.reserveX,
    quoteVault: isQuoteX ? poolKeys.reserveX : poolKeys.reserveY,
  };
}

/**
 * Get the input/output reserves and mints based on swap direction
 */
export function getDlmmSwapAccounts(
  poolKeys: DlmmPoolKeys,
  inputMint: PublicKey,
): {
  inputReserve: PublicKey;
  outputReserve: PublicKey;
  inputMint: PublicKey;
  outputMint: PublicKey;
  isXToY: boolean;
} {
  const isXToY = inputMint.equals(poolKeys.tokenXMint);

  if (isXToY) {
    return {
      inputReserve: poolKeys.reserveX,
      outputReserve: poolKeys.reserveY,
      inputMint: poolKeys.tokenXMint,
      outputMint: poolKeys.tokenYMint,
      isXToY: true,
    };
  } else {
    return {
      inputReserve: poolKeys.reserveY,
      outputReserve: poolKeys.reserveX,
      inputMint: poolKeys.tokenYMint,
      outputMint: poolKeys.tokenXMint,
      isXToY: false,
    };
  }
}

/**
 * Calculate price from active bin ID
 * DLMM uses a bin-based pricing model where each bin has a fixed price
 * Price = (1 + binStep/10000) ^ activeId
 *
 * @param activeId - The active bin ID (can be negative)
 * @param binStep - The bin step in basis points
 * @returns Price of token Y in terms of token X
 */
export function calculateDlmmPrice(activeId: number, binStep: number): number {
  // Price = (1 + binStep/10000) ^ activeId
  const binStepFactor = 1 + binStep / 10000;
  return Math.pow(binStepFactor, activeId);
}
