import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getMint,
  getTransferFeeConfig,
  calculateEpochFee,
} from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from './logger';
import {
  verifyBuyTransaction,
  verifySellTransaction,
  getPreTxTokenBalance,
  getPreTxSolBalance,
  VerificationMethod,
} from './tx-verifier';

/**
 * pump.fun Program ID
 */
export const PUMP_FUN_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/**
 * pump.fun Global Account - stores fee configuration
 */
export const PUMP_FUN_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');

/**
 * pump.fun Fee Recipient
 */
export const PUMP_FUN_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');

/**
 * pump.fun Event Authority
 */
export const PUMP_FUN_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

/**
 * pump.fun Fee Program ID
 * Used for fee configuration and volume tracking
 */
export const PUMP_FUN_FEE_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');

/**
 * System Program ID
 */
const SYSTEM_PROGRAM = SystemProgram.programId;

/**
 * WSOL Mint Address
 */
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * ATA rent exemption amount in lamports (standard for a token account).
 */
const ATA_RENT_LAMPORTS = 2039280;

/**
 * Total pump.fun fee in basis points (protocol 95 + creator 30 = 125 bps).
 *
 * The BuyExactSolIn instruction deducts fees from `spendable_sol_in` before
 * computing the swap.  The on-chain quote formula is:
 *
 *   net_sol = floor(spendable_sol_in * 10_000 / (10_000 + total_fee_bps))
 *   tokens_out = floor((net_sol - 1) * virt_token_reserves
 *                      / (virt_sol_reserves + net_sol - 1))
 *
 * The client must use the SAME net_sol for its expected-tokens estimate,
 * otherwise minTokensOut will be set too high and the program returns
 * error 6024 (Overflow) when the on-chain tokens_out < minTokensOut.
 *
 * Source: pump-fun/pump-public-docs  IDL docs for buy_exact_sol_in.
 */
const PUMP_FUN_TOTAL_FEE_BPS = 125;

/**
 * Safety margin added to fee estimates (configurable via env, default 10000 lamports = 0.00001 SOL).
 */
const FEE_SAFETY_MARGIN_LAMPORTS = Number(process.env.FEE_SAFETY_MARGIN_LAMPORTS || 10000);

/**
 * Compute expected maximum SOL outflow for a buy transaction.
 * Includes trade amount + slippage, ATA rent (if needed), and fees.
 */
interface OutflowEstimate {
  maxSolCostLamports: number;
  ataRentLamports: number;
  feeBufferLamports: number;
  totalExpectedOutflow: number;
}

function computeExpectedOutflow(
  amountLamports: number,
  slippageBps: number,
  computeUnitLimit: number,
  computeUnitPrice: number,
  ataExists: boolean,
): OutflowEstimate {
  const slippageMultiplier = (10000 + slippageBps) / 10000;
  const maxSolCostLamports = Math.ceil(amountLamports * slippageMultiplier);
  const ataRentLamports = ataExists ? 0 : ATA_RENT_LAMPORTS;

  // Base fee (5000 lamports/sig) + priority fee + safety margin
  const baseFee = 5000;
  const priorityFee = Math.ceil((computeUnitPrice * computeUnitLimit) / 1_000_000);
  const feeBufferLamports = baseFee + priorityFee + FEE_SAFETY_MARGIN_LAMPORTS;

  return {
    maxSolCostLamports,
    ataRentLamports,
    feeBufferLamports,
    totalExpectedOutflow: maxSolCostLamports + ataRentLamports + feeBufferLamports,
  };
}

/**
 * Bonding curve state structure
 */
export interface BondingCurveState {
  virtualTokenReserves: BN;
  virtualSolReserves: BN;
  realTokenReserves: BN;
  realSolReserves: BN;
  tokenTotalSupply: BN;
  complete: boolean;
  creator: PublicKey;
}

/**
 * Parameters for buying on pump.fun
 */
export interface PumpFunBuyParams {
  connection: Connection;
  wallet: Keypair;
  mint: PublicKey;
  bondingCurve: PublicKey;
  amountSol: number;
  slippageBps: number;
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  isToken2022?: boolean;
}

/**
 * Parameters for selling on pump.fun
 */
export interface PumpFunSellParams {
  connection: Connection;
  wallet: Keypair;
  mint: PublicKey;
  bondingCurve: PublicKey;
  tokenAmount: number;
  slippageBps: number;
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  isToken2022?: boolean;
}

/**
 * Result of a pump.fun transaction
 */
export interface PumpFunTxResult {
  success: boolean;
  signature?: string;
  error?: string;

  // Token amounts (for buys)
  tokensReceived?: number;      // Actual verified (or expected as fallback)
  expectedTokens?: number;      // Always the calculated expected amount

  // SOL amounts (for sells) - all in SOL, not lamports
  solReceived?: number;         // Actual verified (or expected as fallback)
  expectedSol?: number;         // Always the calculated expected amount

  // SOL tracking (for buys) - how much SOL was actually deducted
  actualSolSpent?: number;              // Pre - post SOL balance (includes gas)
  instructionAmountLamports?: number;   // What was encoded in the buy instruction

  // Verification metadata
  actualVerified: boolean;      // Whether the amount was verified post-tx
  verificationMethod?: VerificationMethod;  // How verification was performed
  slippagePercent?: number;     // Actual slippage vs expected
}

/**
 * Derive the bonding curve PDA for a mint
 *
 * @param mint - The token mint address
 * @returns The bonding curve PDA
 */
export function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  );
  return bondingCurve;
}

/**
 * Derive the associated bonding curve token account
 *
 * @param bondingCurve - The bonding curve PDA
 * @param mint - The token mint address
 * @returns The associated token account for the bonding curve
 */
export function deriveAssociatedBondingCurve(
  bondingCurve: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  return getAssociatedTokenAddressSync(mint, bondingCurve, true, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/**
 * Derive the creator vault PDA
 * Seeds: ["creator-vault", creator]
 *
 * @param creator - The token creator wallet
 * @returns The creator vault PDA
 */
export function deriveCreatorVault(creator: PublicKey): PublicKey {
  const [creatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  );
  return creatorVault;
}

/**
 * Derive the global volume accumulator PDA
 * Seeds: ["global_volume_accumulator"]
 *
 * @returns The global volume accumulator PDA
 */
export function deriveGlobalVolumeAccumulator(): PublicKey {
  const [globalVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from('global_volume_accumulator')],
    PUMP_FUN_PROGRAM_ID
  );
  return globalVolumeAccumulator;
}

/**
 * Derive the user volume accumulator PDA
 * Seeds: ["user_volume_accumulator", user]
 *
 * @param user - The user wallet
 * @returns The user volume accumulator PDA
 */
export function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  const [userVolumeAccumulator] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  );
  return userVolumeAccumulator;
}

/**
 * Derive the fee config PDA
 * Seeds: ["fee_config", pump_program_id]
 * Owned by: Fee Program
 *
 * @returns The fee config PDA
 */
export function deriveFeeConfig(): PublicKey {
  const [feeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee_config'), PUMP_FUN_PROGRAM_ID.toBuffer()],
    PUMP_FUN_FEE_PROGRAM_ID
  );
  return feeConfig;
}

/**
 * Decode bonding curve state from account data
 *
 * Bonding curve account layout:
 * - 8 bytes: discriminator
 * - 8 bytes: virtualTokenReserves (u64)
 * - 8 bytes: virtualSolReserves (u64)
 * - 8 bytes: realTokenReserves (u64)
 * - 8 bytes: realSolReserves (u64)
 * - 8 bytes: tokenTotalSupply (u64)
 * - 1 byte: complete (bool)
 * - 32 bytes: creator (Pubkey)
 *
 * Total: 8 + 40 + 1 + 32 = 81 bytes minimum
 */
export function decodeBondingCurveState(data: Buffer): BondingCurveState | null {
  try {
    if (data.length < 81) {
      logger.debug({ dataLength: data.length }, 'Bonding curve data too short');
      return null;
    }

    // Skip discriminator (8 bytes)
    const offset = 8;

    const virtualTokenReserves = new BN(data.slice(offset, offset + 8), 'le');
    const virtualSolReserves = new BN(data.slice(offset + 8, offset + 16), 'le');
    const realTokenReserves = new BN(data.slice(offset + 16, offset + 24), 'le');
    const realSolReserves = new BN(data.slice(offset + 24, offset + 32), 'le');
    const tokenTotalSupply = new BN(data.slice(offset + 32, offset + 40), 'le');
    const complete = data[offset + 40] === 1;
    const creator = new PublicKey(data.slice(offset + 41, offset + 41 + 32));

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
      creator,
    };
  } catch (error) {
    logger.debug({ error }, 'Failed to decode bonding curve state');
    return null;
  }
}

/**
 * Get the bonding curve state for a token
 *
 * @param connection - Solana connection
 * @param bondingCurve - The bonding curve PDA
 * @returns BondingCurveState or null if not found
 */
export async function getBondingCurveState(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<BondingCurveState | null> {
  try {
    const accountInfo = await connection.getAccountInfo(bondingCurve);
    if (!accountInfo) {
      return null;
    }
    return decodeBondingCurveState(accountInfo.data);
  } catch (error) {
    logger.debug({ bondingCurve: bondingCurve.toString(), error }, 'Failed to get bonding curve state');
    return null;
  }
}

/**
 * Calculate tokens out for a given SOL input (buy)
 *
 * Uses the on-chain pump.fun formula which subtracts 1 from net_sol before
 * applying the constant-product AMM calculation:
 *
 *   effective_sol = net_sol - 1
 *   tokens_out = floor(effective_sol * virt_token_reserves
 *                      / (virt_sol_reserves + effective_sol))
 *
 * The -1 adjustment matches the on-chain Rust code.  Without it, we
 * overestimate tokens_out by a small amount, which can cause minTokensOut
 * to exceed the program's computed output → BuySlippageBelowMinTokensOut.
 *
 * @param state - Current bonding curve state
 * @param solIn - Net SOL after fee deduction (in lamports)
 * @returns Expected tokens out (in smallest units)
 */
export function calculateBuyTokensOut(state: BondingCurveState, solIn: BN): BN {
  // On-chain uses (net_sol - 1) before the AMM formula
  const effectiveSol = solIn.sub(new BN(1));
  if (effectiveSol.isZero() || effectiveSol.isNeg()) {
    return new BN(0);
  }

  // tokens_out = floor(effective_sol * vT / (vS + effective_sol))
  const tokensOut = effectiveSol
    .mul(state.virtualTokenReserves)
    .div(state.virtualSolReserves.add(effectiveSol));

  return tokensOut;
}

/**
 * Calculate SOL out for a given token input (sell)
 *
 * Uses the constant product formula:
 * sol_out = virtual_sol_reserves - (virtual_token_reserves * virtual_sol_reserves) / (virtual_token_reserves + tokens_in)
 *
 * @param state - Current bonding curve state
 * @param tokensIn - Amount of tokens to sell (in smallest units)
 * @returns Expected SOL out (in lamports)
 */
export function calculateSellSolOut(state: BondingCurveState, tokensIn: BN): BN {
  // K = virtualTokenReserves * virtualSolReserves
  const k = state.virtualTokenReserves.mul(state.virtualSolReserves);

  // new_token_reserves = virtualTokenReserves + tokensIn
  const newTokenReserves = state.virtualTokenReserves.add(tokensIn);

  // new_sol_reserves = K / new_token_reserves
  const newSolReserves = k.div(newTokenReserves);

  // sol_out = virtualSolReserves - new_sol_reserves
  const solOut = state.virtualSolReserves.sub(newSolReserves);

  return solOut;
}

/**
 * Calculate the current price in SOL per token
 *
 * @param state - Current bonding curve state
 * @returns Price in SOL per token
 */
export function calculatePrice(state: BondingCurveState): number {
  // Price = virtualSolReserves / virtualTokenReserves
  const price = state.virtualSolReserves.toNumber() / state.virtualTokenReserves.toNumber();
  return price;
}

/**
 * Calculate market cap in SOL
 *
 * @param state - Current bonding curve state
 * @returns Market cap in SOL
 */
export function calculateMarketCapSol(state: BondingCurveState): number {
  const price = calculatePrice(state);
  const supply = state.tokenTotalSupply.toNumber() / 1e6; // Assuming 6 decimals
  return (price * supply) / LAMPORTS_PER_SOL;
}

/**
 * Build the buy instruction for pump.fun using BuyExactSolIn semantics.
 *
 * BuyExactSolIn spends an exact amount of SOL and accepts at least minTokensOut
 * tokens.  This is more robust than the older Buy (exact-tokens-out) instruction
 * because the program computes the token output from the current on-chain
 * bonding-curve state rather than requiring a caller-specified token count that
 * may exceed available reserves after competing buys.
 *
 * pump.fun BuyExactSolIn instruction accounts (16 total):
 * 0: global
 * 1: fee_recipient
 * 2: mint
 * 3: bonding_curve
 * 4: associated_bonding_curve
 * 5: associated_user (user's token account)
 * 6: user
 * 7: system_program
 * 8: token_program
 * 9: creator_vault (mutable)
 * 10: event_authority
 * 11: program
 * 12: global_volume_accumulator (NOT mutable — read-only per pump.fun IDL)
 * 13: user_volume_accumulator (mutable)
 * 14: fee_config (NOT mutable)
 * 15: fee_program (NOT mutable)
 */
/**
 * Derive the bonding curve V2 PDA for Token-2022 mints.
 * Seeds: ["bonding-curve-v2", mint]
 */
function deriveBondingCurveV2(mint: PublicKey): PublicKey {
  const [bondingCurveV2] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBuffer()],
    PUMP_FUN_PROGRAM_ID
  );
  return bondingCurveV2;
}

function buildBuyExactSolInInstruction(
  mint: PublicKey,
  bondingCurve: PublicKey,
  associatedBondingCurve: PublicKey,
  userTokenAccount: PublicKey,
  user: PublicKey,
  solAmount: BN,
  minTokensOut: BN,
  tokenProgramId: PublicKey,
  creatorVault: PublicKey,
  globalVolumeAccumulator: PublicKey,
  userVolumeAccumulator: PublicKey,
  feeConfig: PublicKey,
): TransactionInstruction {
  // BuyExactSolIn instruction discriminator (first 8 bytes of sha256("global:buy_exact_sol_in"))
  // Full sha256: 38fc74089edfcd5f315a3e4ee4aa3e277a742f39750fc3bb47ca6ed5fd6b8d26
  // Verified: echo -n "global:buy_exact_sol_in" | sha256sum
  const discriminator = Buffer.from([56, 252, 116, 8, 158, 223, 205, 95]);

  // Instruction data: discriminator (8) + spendable_sol_in (8) + min_tokens_out (8) = 24 bytes.
  //
  // The IDL defines a third arg track_volume (OptionBool), but the working
  // reference SDK (Erbsensuppee/pumpfun-pumpswap-sdk) uses 24-byte "compat"
  // encoding that OMITS track_volume entirely.  When track_volume is included
  // (26 bytes with [0x01, 0x01]), the program enters a volume-tracking code
  // path that triggers an arithmetic overflow at lib.rs:463 on most tokens.
  // Omitting it lets the program use its default path which works correctly.
  const data = Buffer.alloc(24);
  discriminator.copy(data, 0);
  solAmount.toArrayLike(Buffer, 'le', 8).copy(data, 8);
  minTokensOut.toArrayLike(Buffer, 'le', 8).copy(data, 16);

  const keys = [
    // 0: global
    { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
    // 1: fee_recipient
    { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
    // 2: mint
    { pubkey: mint, isSigner: false, isWritable: false },
    // 3: bonding_curve
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    // 4: associated_bonding_curve
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    // 5: associated_user (user's token account)
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    // 6: user
    { pubkey: user, isSigner: true, isWritable: true },
    // 7: system_program
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    // 8: token_program
    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    // 9: creator_vault (mutable)
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    // 10: event_authority
    { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    // 11: program
    { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    // 12: global_volume_accumulator (NOT mutable — read-only per IDL)
    { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
    // 13: user_volume_accumulator (mutable)
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    // 14: fee_config (NOT mutable)
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    // 15: fee_program (NOT mutable)
    { pubkey: PUMP_FUN_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
    // 16: bonding_curve_v2 (optional remaining account, read-only)
    // The reference SDK includes this for all tokens when V2_ACCOUNT_MODE is "on".
    { pubkey: deriveBondingCurveV2(mint), isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Build the sell instruction for pump.fun
 *
 * pump.fun Sell instruction accounts (14 total):
 * 0: global
 * 1: fee_recipient
 * 2: mint
 * 3: bonding_curve
 * 4: associated_bonding_curve
 * 5: associated_user (user's token account)
 * 6: user
 * 7: system_program
 * 8: creator_vault (mutable) — NOTE: swapped with token_program vs buy
 * 9: token_program
 * 10: event_authority
 * 11: program
 * 12: fee_config (NOT mutable)
 * 13: fee_program (NOT mutable)
 */
function buildSellInstruction(
  mint: PublicKey,
  bondingCurve: PublicKey,
  associatedBondingCurve: PublicKey,
  userTokenAccount: PublicKey,
  user: PublicKey,
  tokenAmount: BN,
  minSolOutput: BN,
  tokenProgramId: PublicKey,
  creatorVault: PublicKey,
  feeConfig: PublicKey,
): TransactionInstruction {
  // Sell instruction discriminator (first 8 bytes of sha256("global:sell"))
  // Full sha256: 33e685a4017f83ad96d0efcd4fb626bca6f4d46e11c32fd23e5f5198ed6a62eb
  // Verified: echo -n "global:sell" | sha256sum
  const discriminator = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

  // Instruction data: discriminator + amount (u64) + minSolOutput (u64)
  const data = Buffer.alloc(24);
  discriminator.copy(data, 0);
  tokenAmount.toArrayLike(Buffer, 'le', 8).copy(data, 8);
  minSolOutput.toArrayLike(Buffer, 'le', 8).copy(data, 16);

  const keys = [
    // 0: global
    { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
    // 1: fee_recipient
    { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
    // 2: mint
    { pubkey: mint, isSigner: false, isWritable: false },
    // 3: bonding_curve
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    // 4: associated_bonding_curve
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    // 5: associated_user (user's token account)
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    // 6: user
    { pubkey: user, isSigner: true, isWritable: true },
    // 7: system_program
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    // 8: creator_vault (mutable) — NOTE: position 8 in sell, position 9 in buy
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    // 9: token_program — NOTE: position 9 in sell, position 8 in buy
    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    // 10: event_authority
    { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    // 11: program
    { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
    // 12: fee_config (NOT mutable)
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    // 13: fee_program (NOT mutable)
    { pubkey: PUMP_FUN_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PUMP_FUN_PROGRAM_ID,
    keys,
    data,
  });
}

/**
 * Buy tokens on pump.fun bonding curve
 *
 * @param params - Buy parameters
 * @returns Transaction result
 */
export async function buyOnPumpFun(params: PumpFunBuyParams): Promise<PumpFunTxResult> {
  const {
    connection,
    wallet,
    mint,
    bondingCurve,
    amountSol,
    slippageBps,
    computeUnitLimit = 100000,
    computeUnitPrice = 100000,
    isToken2022 = false,
  } = params;

  // Determine token program ID based on token type
  const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  try {
    // Get bonding curve state
    const state = await getBondingCurveState(connection, bondingCurve);
    if (!state) {
      return {
        success: false,
        error: 'Failed to get bonding curve state',
        actualVerified: false,
      };
    }

    // Check if bonding curve is complete (graduated)
    if (state.complete) {
      return {
        success: false,
        error: 'Token has graduated from bonding curve',
        actualVerified: false,
      };
    }

    // Extract creator from bonding curve state for PDA derivation
    const creator = state.creator;

    // Calculate expected tokens out
    const amountLamports = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));

    // ─── Fee-adjusted quote (mirrors on-chain formula exactly) ──────────
    // The BuyExactSolIn program deducts protocol + creator fees from
    // spendable_sol_in BEFORE computing the swap.  On-chain formula:
    //
    //   net_sol = floor(spendable_sol_in * 10_000 / (10_000 + fee_bps))
    //   verify: net_sol + ceil(protocol_fee) + ceil(creator_fee) <= spendable
    //   tokens_out = floor((net_sol - 1) * vT / (vS + net_sol - 1))
    //
    const PROTOCOL_FEE_BPS = 95;
    const CREATOR_FEE_BPS = 30;
    let netSolForQuote = amountLamports
      .mul(new BN(10000))
      .div(new BN(10000 + PUMP_FUN_TOTAL_FEE_BPS));

    // On-chain fee verification: net_sol + ceil(protocol_fee) + ceil(creator_fee) <= spendable
    // If rounding causes overshoot, adjust netSol down.
    if (!netSolForQuote.isZero()) {
      const ceilProtocolFee = netSolForQuote.mul(new BN(PROTOCOL_FEE_BPS)).add(new BN(9999)).div(new BN(10000));
      const ceilCreatorFee = netSolForQuote.mul(new BN(CREATOR_FEE_BPS)).add(new BN(9999)).div(new BN(10000));
      const totalWithFees = netSolForQuote.add(ceilProtocolFee).add(ceilCreatorFee);
      if (totalWithFees.gt(amountLamports)) {
        netSolForQuote = netSolForQuote.sub(totalWithFees.sub(amountLamports));
      }
    }

    // calculateBuyTokensOut now uses the on-chain formula with (netSol - 1)
    const expectedTokens = calculateBuyTokensOut(state, netSolForQuote);

    // Cap by real token reserves (can't buy more than what the curve holds)
    const realTokenReservesCap = state.realTokenReserves;
    const cappedExpectedTokens = expectedTokens.gt(realTokenReservesCap) ? realTokenReservesCap : expectedTokens;

    // Guard: reject if bonding curve returns zero or negative tokens
    if (cappedExpectedTokens.isZero() || cappedExpectedTokens.isNeg()) {
      return {
        success: false,
        error: `Bonding curve returned ${cappedExpectedTokens.toString()} tokens for ${amountSol} SOL (netSol=${netSolForQuote.toString()}) — curve may be empty or corrupted`,
        actualVerified: false,
      };
    }

    // ─── Token-2022 transfer fee deduction ──────────────────────────────
    // For Token-2022 mints, the on-chain TransferChecked withholds a fee
    // from the transferred tokens.  We must subtract this from our expected
    // tokens BEFORE applying slippage, otherwise minTokensOut is set higher
    // than the user will actually receive.
    let minTokensOutBase = cappedExpectedTokens;
    if (isToken2022) {
      try {
        const mintInfo = await getMint(connection, mint, 'confirmed', tokenProgramId);
        const transferFeeConfig = getTransferFeeConfig(mintInfo);
        if (transferFeeConfig) {
          const epochInfo = await connection.getEpochInfo('confirmed');
          const feeWithheld = new BN(
            calculateEpochFee(transferFeeConfig, BigInt(epochInfo.epoch), BigInt(cappedExpectedTokens.toString())).toString()
          );
          minTokensOutBase = cappedExpectedTokens.sub(feeWithheld);
          logger.debug(
            {
              transferFeeWithheld: feeWithheld.toString(),
              tokensAfterFee: minTokensOutBase.toString(),
              epoch: epochInfo.epoch,
            },
            'Token-2022 transfer fee applied to expected tokens'
          );
        }
      } catch (err) {
        logger.debug({ error: String(err) }, 'Failed to read Token-2022 transfer fee config, proceeding without adjustment');
      }
    }

    // Apply slippage DOWNWARD on expected tokens
    const minTokensOut = minTokensOutBase
      .mul(new BN(10000 - slippageBps))
      .div(new BN(10000));

    // Guard: a zero minTokensOut means the program will accept 0 tokens — a total
    // SOL loss with no token credit.
    if (minTokensOut.isZero()) {
      return {
        success: false,
        error: `minTokensOut collapsed to zero (slippageBps=${slippageBps}, expectedTokens=${cappedExpectedTokens.toString()}). Buy rejected to prevent zero-token settlement.`,
        actualVerified: false,
      };
    }

    // Get or create user token account (using correct token program)
    const userTokenAccount = getAssociatedTokenAddressSync(
      mint,
      wallet.publicKey,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const associatedBondingCurve = deriveAssociatedBondingCurve(bondingCurve, mint, tokenProgramId);

    // Derive new PDAs for buy instruction
    const creatorVault = deriveCreatorVault(creator);
    const globalVolumeAccumulator = deriveGlobalVolumeAccumulator();
    const userVolumeAccumulator = deriveUserVolumeAccumulator(wallet.publicKey);
    const feeConfig = deriveFeeConfig();

    logger.debug(
      {
        mint: mint.toString(),
        amountSol,
        solAmountLamports: amountLamports.toString(),
        netSolForQuote: netSolForQuote.toString(),
        feeBps: PUMP_FUN_TOTAL_FEE_BPS,
        expectedTokens: cappedExpectedTokens.toString(),
        minTokensOutBase: minTokensOutBase.toString(),
        minTokensOut: minTokensOut.toString(),
        slippageBps,
        isToken2022,
        tokenProgramId: tokenProgramId.toString(),
        creator: creator.toString(),
        creatorVault: creatorVault.toString(),
        globalVolumeAccumulator: globalVolumeAccumulator.toString(),
        userVolumeAccumulator: userVolumeAccumulator.toString(),
        feeConfig: feeConfig.toString(),
        instructionDataBytes: 24,
      },
      'Preparing pump.fun buy (BuyExactSolIn, 24-byte compat encoding)'
    );

    // Build transaction
    const transaction = new Transaction();

    // Add compute budget instructions
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })
    );
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice })
    );

    // Check if user token account exists, create if not
    const userTokenAccountInfo = await connection.getAccountInfo(userTokenAccount);
    const ataExists = userTokenAccountInfo !== null;
    if (!ataExists) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userTokenAccount,
          wallet.publicKey,
          mint,
          tokenProgramId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // OUTFLOW GUARD: Verify wallet can cover the full transaction cost
    // With BuyExactSolIn the SOL cost is exactly amountLamports (no slippage
    // on the SOL side), so pass slippageBps=0 to get the accurate outflow.
    // ═══════════════════════════════════════════════════════════════════════
    const outflow = computeExpectedOutflow(
      amountLamports.toNumber(),
      0,
      computeUnitLimit,
      computeUnitPrice,
      ataExists,
    );

    const preSolBalanceForGuard = await getPreTxSolBalance(connection, wallet.publicKey);

    logger.info(
      {
        mint: mint.toString(),
        tradeAmountLamports: amountLamports.toNumber(),
        maxSolCostLamports: outflow.maxSolCostLamports,
        ataRentLamports: outflow.ataRentLamports,
        feeBufferLamports: outflow.feeBufferLamports,
        totalExpectedOutflow: outflow.totalExpectedOutflow,
        totalExpectedOutflowSol: (outflow.totalExpectedOutflow / LAMPORTS_PER_SOL).toFixed(6),
        walletBalanceLamports: preSolBalanceForGuard,
        walletBalanceSol: (preSolBalanceForGuard / LAMPORTS_PER_SOL).toFixed(6),
        expectedTokens: cappedExpectedTokens.toString(),
        minTokensOut: minTokensOut.toString(),
        ataExists,
      },
      '[pump.fun] Outflow breakdown (BuyExactSolIn)',
    );

    if (preSolBalanceForGuard < outflow.totalExpectedOutflow) {
      const shortfall = (outflow.totalExpectedOutflow - preSolBalanceForGuard) / LAMPORTS_PER_SOL;
      return {
        success: false,
        error: `Outflow guard rejected: wallet ${(preSolBalanceForGuard / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
               `< required ${(outflow.totalExpectedOutflow / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
               `(trade: ${(outflow.maxSolCostLamports / LAMPORTS_PER_SOL).toFixed(6)}, ` +
               `ATA: ${(outflow.ataRentLamports / LAMPORTS_PER_SOL).toFixed(6)}, ` +
               `fees: ${(outflow.feeBufferLamports / LAMPORTS_PER_SOL).toFixed(6)}, ` +
               `shortfall: ${shortfall.toFixed(6)} SOL)`,
        actualVerified: false,
      };
    }

    // Add buy instruction (BuyExactSolIn)
    // solAmount    = amountLamports (exact SOL to spend)
    // minTokensOut = expectedTokens × (1 - slippage) (minimum tokens to accept)
    transaction.add(
      buildBuyExactSolInInstruction(
        mint,
        bondingCurve,
        associatedBondingCurve,
        userTokenAccount,
        wallet.publicKey,
        amountLamports,
        minTokensOut,
        tokenProgramId,
        creatorVault,
        globalVolumeAccumulator,
        userVolumeAccumulator,
        feeConfig,
      )
    );

    // Get recent blockhash and sign
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    // Capture pre-tx balances for verification
    const preTokenBalance = await getPreTxTokenBalance(
      connection,
      wallet.publicKey,
      mint,
      tokenProgramId,
    );
    // Reuse the balance from outflow guard (fetched moments ago) to avoid extra RPC call
    const preSolBalance = preSolBalanceForGuard;

    // Send and confirm
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const buyConfirmResult = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    // Check if transaction failed on-chain (e.g. slippage exceeded, insufficient funds)
    if (buyConfirmResult.value.err) {
      logger.error(
        { mint: mint.toString(), signature, err: JSON.stringify(buyConfirmResult.value.err) },
        'pump.fun buy transaction failed on-chain'
      );
      return {
        success: false,
        signature,
        error: `Transaction failed on-chain: ${JSON.stringify(buyConfirmResult.value.err)}`,
        actualVerified: false,
      };
    }

    // Verify actual tokens received
    const verification = await verifyBuyTransaction({
      connection,
      signature,
      wallet: wallet.publicKey,
      mint,
      expectedTokens: cappedExpectedTokens.toNumber(),
      tokenProgramId,
      preBalance: preTokenBalance,
    });

    // Use actual tokens if verification succeeded, otherwise fall back to expected
    const actualTokensReceived = verification.actualTokensReceived ?? cappedExpectedTokens.toNumber();

    // Calculate actual SOL spent by comparing pre/post balance
    let actualSolSpent: number | undefined;
    if (preSolBalance > 0) {
      const postSolBalance = await getPreTxSolBalance(connection, wallet.publicKey);
      if (postSolBalance !== null) {
        actualSolSpent = (preSolBalance - postSolBalance) / LAMPORTS_PER_SOL;

        // Sanity check: actualSolSpent should not exceed the expected outflow by more than
        // 20%. A significantly higher value means the balance snapshot captured wallet
        // changes from a concurrent transaction (e.g., a race-condition double-buy) rather
        // than just this transaction. Log a loud warning so the anomaly is visible.
        const expectedMaxSpendSol = outflow.totalExpectedOutflow / LAMPORTS_PER_SOL;
        if (actualSolSpent > expectedMaxSpendSol * 1.2) {
          logger.warn(
            {
              mint: mint.toString(),
              actualSolSpent: actualSolSpent.toFixed(6),
              expectedMaxSpend: expectedMaxSpendSol.toFixed(6),
              ratio: (actualSolSpent / expectedMaxSpendSol).toFixed(2),
            },
            '[pump.fun] SPEND ANOMALY: actualSolSpent exceeds expected outflow by >20%. ' +
            'A concurrent transaction may have been captured in the balance delta. ' +
            'Check for double-buy race conditions.',
          );
        }
      }
    }

    logger.info(
      {
        mint: mint.toString(),
        signature,
        amountSol,
        actualSolSpent: actualSolSpent?.toFixed(6),
        expectedTokens: cappedExpectedTokens.toString(),
        actualTokens: actualTokensReceived,
        verified: verification.success,
        verificationMethod: verification.verificationMethod,
        slippagePercent: verification.tokenSlippagePercent?.toFixed(2),
      },
      'pump.fun buy successful'
    );

    return {
      success: true,
      signature,
      tokensReceived: actualTokensReceived,
      expectedTokens: cappedExpectedTokens.toNumber(),
      actualSolSpent,
      instructionAmountLamports: amountLamports.toNumber(),
      actualVerified: verification.success,
      verificationMethod: verification.verificationMethod,
      slippagePercent: verification.tokenSlippagePercent,
    };
  } catch (error) {
    logger.error({ error, mint: mint.toString() }, 'pump.fun buy failed');
    return {
      success: false,
      error: String(error),
      actualVerified: false,
    };
  }
}

/**
 * Sell tokens on pump.fun bonding curve
 *
 * @param params - Sell parameters
 * @returns Transaction result
 */
export async function sellOnPumpFun(params: PumpFunSellParams): Promise<PumpFunTxResult> {
  const {
    connection,
    wallet,
    mint,
    bondingCurve,
    tokenAmount,
    slippageBps,
    computeUnitLimit = 100000,
    computeUnitPrice = 100000,
    isToken2022 = false,
  } = params;

  // Determine token program ID based on token type
  const tokenProgramId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  try {
    // Get bonding curve state
    const state = await getBondingCurveState(connection, bondingCurve);
    if (!state) {
      return {
        success: false,
        error: 'Failed to get bonding curve state',
        actualVerified: false,
      };
    }

    // Note: Can still sell after graduation, but price is different
    const tokenAmountBN = new BN(tokenAmount);
    const expectedSol = calculateSellSolOut(state, tokenAmountBN);

    // Apply slippage - minimum SOL we'll accept.
    // BN-native integer arithmetic avoids float64 precision loss.
    const minSolOut = expectedSol
      .mul(new BN(10000 - slippageBps))
      .div(new BN(10000));

    // Derive PDAs needed for the sell instruction
    const creatorVault = deriveCreatorVault(state.creator);
    const feeConfig = deriveFeeConfig();

    logger.debug(
      {
        mint: mint.toString(),
        tokenAmount,
        expectedSol: expectedSol.toString(),
        minSolOut: minSolOut.toString(),
        slippageBps,
        isToken2022,
        tokenProgramId: tokenProgramId.toString(),
        creator: state.creator.toString(),
        creatorVault: creatorVault.toString(),
        feeConfig: feeConfig.toString(),
      },
      'Preparing pump.fun sell'
    );

    const userTokenAccount = getAssociatedTokenAddressSync(
      mint,
      wallet.publicKey,
      false,
      tokenProgramId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const associatedBondingCurve = deriveAssociatedBondingCurve(bondingCurve, mint, tokenProgramId);

    // Build transaction
    const transaction = new Transaction();

    // Add compute budget instructions
    transaction.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit })
    );
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: computeUnitPrice })
    );

    // Add sell instruction
    transaction.add(
      buildSellInstruction(
        mint,
        bondingCurve,
        associatedBondingCurve,
        userTokenAccount,
        wallet.publicKey,
        tokenAmountBN,
        minSolOut,
        tokenProgramId,
        creatorVault,
        feeConfig,
      )
    );

    // Get recent blockhash and sign
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    // Capture pre-tx SOL balance for verification
    const preSolBalance = await getPreTxSolBalance(connection, wallet.publicKey);

    // Send and confirm
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    const confirmResult = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    // Check if transaction failed on-chain (e.g. insufficient tokens, slippage exceeded)
    if (confirmResult.value.err) {
      logger.error(
        { mint: mint.toString(), signature, err: JSON.stringify(confirmResult.value.err) },
        'pump.fun sell transaction failed on-chain'
      );
      return {
        success: false,
        signature,
        error: `Transaction failed on-chain: ${JSON.stringify(confirmResult.value.err)}`,
        actualVerified: false,
      };
    }

    // Verify actual SOL received
    // Note: expectedSol is in lamports (from calculateSellSolOut), but verifySellTransaction
    // expects and returns SOL. Convert here for consistency.
    const expectedSolInSol = expectedSol.toNumber() / LAMPORTS_PER_SOL;

    const verification = await verifySellTransaction({
      connection,
      signature,
      wallet: wallet.publicKey,
      expectedSol: expectedSolInSol,
      preBalance: preSolBalance,
    });

    // Use actual SOL if verification succeeded, otherwise fall back to expected
    // verification.actualSolReceived is already in SOL (not lamports)
    const actualSolReceived = verification.actualSolReceived ?? expectedSolInSol;

    logger.info(
      {
        mint: mint.toString(),
        signature,
        tokenAmount,
        expectedSol: expectedSolInSol.toFixed(6),
        actualSol: actualSolReceived.toFixed(6),
        verified: verification.success,
        verificationMethod: verification.verificationMethod,
        slippagePercent: verification.solSlippagePercent?.toFixed(2),
      },
      'pump.fun sell successful'
    );

    return {
      success: true,
      signature,
      solReceived: actualSolReceived,
      expectedSol: expectedSolInSol,
      actualVerified: verification.success,
      verificationMethod: verification.verificationMethod,
      slippagePercent: verification.solSlippagePercent,
    };
  } catch (error) {
    logger.error({ error, mint: mint.toString() }, 'pump.fun sell failed');
    return {
      success: false,
      error: String(error),
      actualVerified: false,
    };
  }
}

/**
 * Check if a token is on the pump.fun bonding curve
 *
 * @param connection - Solana connection
 * @param mint - Token mint address
 * @returns true if token is on bonding curve, false otherwise
 */
export async function isOnBondingCurve(
  connection: Connection,
  mint: PublicKey
): Promise<boolean> {
  const bondingCurve = deriveBondingCurve(mint);
  const state = await getBondingCurveState(connection, bondingCurve);
  return state !== null && !state.complete;
}

/**
 * Check if a token has graduated from pump.fun to Raydium
 *
 * @param connection - Solana connection
 * @param mint - Token mint address
 * @returns true if graduated, false if still on bonding curve or not a pump.fun token
 */
export async function hasGraduated(
  connection: Connection,
  mint: PublicKey
): Promise<boolean> {
  const bondingCurve = deriveBondingCurve(mint);
  const state = await getBondingCurveState(connection, bondingCurve);
  return state !== null && state.complete;
}

/**
 * Get the graduation progress (how close to $69k market cap)
 *
 * @param state - Bonding curve state
 * @returns Progress as a percentage (0-100)
 */
export function getGraduationProgress(state: BondingCurveState): number {
  // pump.fun graduates at approximately $69k market cap
  // This is roughly 400 SOL in the curve
  const GRADUATION_SOL_THRESHOLD = 400 * LAMPORTS_PER_SOL;

  const currentSol = state.realSolReserves.toNumber();
  const progress = (currentSol / GRADUATION_SOL_THRESHOLD) * 100;

  return Math.min(100, progress);
}
