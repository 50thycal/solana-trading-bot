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
 *
 * Note: DLMM pools use Position NFTs instead of LP tokens, so lbMint is
 * derived from the pool account itself (PDA). The oracle field is the
 * price oracle account.
 */
export interface DlmmPoolState {
  discriminator: Buffer;
  reserveX: PublicKey;
  reserveY: PublicKey;
  tokenXMint: PublicKey;
  tokenYMint: PublicKey;
  oracle: PublicKey;
  activeId: number;
  binStep: number;
  status: number;
  activationPoint: BN;
  creator: PublicKey;
  // The pool account address itself serves as the "lbMint" for filter compatibility
  // This is set during createDlmmPoolKeys, not during decoding
}

/**
 * DLMM LbPair account byte offsets (based on Meteora DLMM IDL v0.8.5)
 *
 * The LbPair account has a complex structure. We use direct offset-based reading
 * for robustness, as the exact sizes of intermediate fields (like RewardInfo) can vary.
 *
 * Verified essential field offsets:
 * - discriminator: 0-7 (8 bytes)
 * - staticParameters: 8-41 (34 bytes)
 * - variableParameters: 42-73 (32 bytes)
 * - bumpSeed: 74 (1 byte)
 * - binStepSeed: 75-76 (2 bytes)
 * - pairType: 77 (1 byte)
 * - activeId: 78-81 (4 bytes, i32)
 * - binStep: 82-83 (2 bytes, u16)
 * - status: 84 (1 byte)
 * - requireBaseFactorSeed: 85 (1 byte)
 * - baseFactorSeed: 86-87 (2 bytes)
 * - activationType: 88 (1 byte)
 * - creatorPoolOnOffControl: 89 (1 byte)
 * - tokenXMint: 90-121 (32 bytes) ***
 * - tokenYMint: 122-153 (32 bytes) ***
 * - reserveX: 154-185 (32 bytes)
 * - reserveY: 186-217 (32 bytes)
 */
export const DLMM_OFFSETS = {
  DISCRIMINATOR: 0,
  ACTIVE_ID: 78,
  BIN_STEP: 82,
  STATUS: 84,
  TOKEN_X_MINT: 90,
  TOKEN_Y_MINT: 122,
  RESERVE_X: 154,
  RESERVE_Y: 186,
  // Fields after reserveY require offset calculation through complex structs:
  // protocolFee (16) + padding1 (32) + rewardInfos (2 x 128 = 256) = 304 bytes
  // So oracle starts at 186 + 32 + 304 = 522
  ORACLE: 522,
  // After oracle: binArrayBitmap (128) + lastUpdatedAt (8) + padding2 (32) +
  // preActivationSwapAddress (32) + baseKey (32) = 232 bytes
  // So activationPoint at 522 + 32 + 232 = 786
  ACTIVATION_POINT: 786,
  // After activationPoint (8) + preActivationDuration (8) + padding3 (8) + padding4 (8) = 32 bytes
  // So creator at 786 + 8 + 32 = 826
  CREATOR: 826,
} as const;

/**
 * Minimum LbPair account size required for decoding
 * We need at least up to the end of creator field (826 + 32 = 858 bytes)
 */
export const DLMM_MIN_ACCOUNT_SIZE = 858;

/**
 * Minimal layout for the fixed-position fields we need from LbPair
 * This reads only the first 218 bytes which contain all essential trading fields.
 */
interface RawDlmmEssentialData {
  discriminator: Uint8Array;
  staticParameters: Uint8Array;
  variableParameters: Uint8Array;
  bumpSeed: number;
  binStepSeed: Uint8Array;
  pairType: number;
  activeId: number;
  binStep: number;
  status: number;
  requireBaseFactorSeed: number;
  baseFactorSeed: Uint8Array;
  activationType: number;
  creatorPoolOnOffControl: number;
  tokenXMint: Uint8Array;
  tokenYMint: Uint8Array;
  reserveX: Uint8Array;
  reserveY: Uint8Array;
}

/**
 * DLMM LbPair essential layout (first 218 bytes)
 * Contains all fields needed for pool detection and trading.
 * The full account is ~10KB+ but we only need these fields.
 */
export const DlmmLbPairLayout = BufferLayout.struct<RawDlmmEssentialData>([
  // Account discriminator (8 bytes) - offset 0-7
  BufferLayout.blob(8, 'discriminator'),

  // StaticParameters struct (34 bytes) - offset 8-41
  BufferLayout.blob(34, 'staticParameters'),

  // VariableParameters struct (32 bytes) - offset 42-73
  BufferLayout.blob(32, 'variableParameters'),

  // bump_seed (1 byte) - offset 74
  BufferLayout.u8('bumpSeed'),

  // bin_step_seed (2 bytes) - offset 75-76
  BufferLayout.blob(2, 'binStepSeed'),

  // pair_type (1 byte) - offset 77
  BufferLayout.u8('pairType'),

  // active_id (i32, 4 bytes) - offset 78-81
  BufferLayout.s32('activeId'),

  // bin_step (u16, 2 bytes) - offset 82-83
  BufferLayout.u16('binStep'),

  // status (u8, 1 byte) - offset 84
  // 0 = disabled, 1 = enabled, 2 = bootstrap
  BufferLayout.u8('status'),

  // require_base_factor_seed (1 byte) - offset 85
  BufferLayout.u8('requireBaseFactorSeed'),

  // base_factor_seed (2 bytes) - offset 86-87
  BufferLayout.blob(2, 'baseFactorSeed'),

  // activation_type (1 byte) - offset 88
  BufferLayout.u8('activationType'),

  // creator_pool_on_off_control (1 byte) - offset 89
  BufferLayout.u8('creatorPoolOnOffControl'),

  // token_x_mint (32 bytes) - offset 90-121 *** TOKEN MINTS ***
  BufferLayout.blob(32, 'tokenXMint'),

  // token_y_mint (32 bytes) - offset 122-153
  BufferLayout.blob(32, 'tokenYMint'),

  // reserve_x (32 bytes) - offset 154-185
  BufferLayout.blob(32, 'reserveX'),

  // reserve_y (32 bytes) - offset 186-217
  BufferLayout.blob(32, 'reserveY'),
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
 *
 * Uses a combination of buffer-layout for structured fields (first 218 bytes)
 * and direct offset reading for fields further in the account.
 *
 * Key offsets (based on Meteora DLMM IDL v0.8.5):
 * - tokenXMint: offset 90
 * - tokenYMint: offset 122
 * - reserveX: offset 154
 * - reserveY: offset 186
 * - oracle: offset ~522 (after protocolFee, padding, rewardInfos)
 * - activationPoint: offset ~786
 * - creator: offset ~826
 */
export function decodeDlmmPoolState(data: Buffer): DlmmPoolState {
  // Decode essential fields using the layout (first 218 bytes)
  const decoded = DlmmLbPairLayout.decode(data);

  // Read fields that are further into the account using direct offsets
  // These offsets may need adjustment if the RewardInfo size differs
  let oracle = PublicKey.default;
  let activationPoint = new BN(0);
  let creator = PublicKey.default;

  try {
    // Only read these if the account is large enough
    if (data.length >= DLMM_OFFSETS.ORACLE + 32) {
      oracle = new PublicKey(data.subarray(DLMM_OFFSETS.ORACLE, DLMM_OFFSETS.ORACLE + 32));
    }
    if (data.length >= DLMM_OFFSETS.ACTIVATION_POINT + 8) {
      activationPoint = new BN(data.subarray(DLMM_OFFSETS.ACTIVATION_POINT, DLMM_OFFSETS.ACTIVATION_POINT + 8), 'le');
    }
    if (data.length >= DLMM_OFFSETS.CREATOR + 32) {
      creator = new PublicKey(data.subarray(DLMM_OFFSETS.CREATOR, DLMM_OFFSETS.CREATOR + 32));
    }
  } catch (e) {
    // If reading additional fields fails, use defaults
    // The essential fields (tokenXMint, tokenYMint, status) are still valid
  }

  return {
    discriminator: Buffer.from(decoded.discriminator),
    reserveX: new PublicKey(decoded.reserveX),
    reserveY: new PublicKey(decoded.reserveY),
    tokenXMint: new PublicKey(decoded.tokenXMint),
    tokenYMint: new PublicKey(decoded.tokenYMint),
    oracle,
    activeId: decoded.activeId,
    binStep: decoded.binStep,
    status: decoded.status,
    activationPoint,
    creator,
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
 *
 * Note: DLMM uses Position NFTs instead of traditional LP tokens.
 * The lbMint field is set to the pool ID for filter compatibility,
 * since there's no separate LP token mint in DLMM.
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
    // DLMM uses Position NFTs, not LP tokens. Use pool ID as placeholder for filter compatibility.
    lbMint: id,
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
