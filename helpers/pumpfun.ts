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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import BN from 'bn.js';
import { logger } from './logger';

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
 * System Program ID
 */
const SYSTEM_PROGRAM = SystemProgram.programId;

/**
 * WSOL Mint Address
 */
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

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
}

/**
 * Result of a pump.fun transaction
 */
export interface PumpFunTxResult {
  success: boolean;
  signature?: string;
  error?: string;
  tokensReceived?: number;
  solReceived?: number;
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
  mint: PublicKey
): PublicKey {
  return getAssociatedTokenAddressSync(mint, bondingCurve, true);
}

/**
 * Decode bonding curve state from account data
 *
 * Bonding curve account layout (approx):
 * - 8 bytes: discriminator
 * - 8 bytes: virtualTokenReserves (u64)
 * - 8 bytes: virtualSolReserves (u64)
 * - 8 bytes: realTokenReserves (u64)
 * - 8 bytes: realSolReserves (u64)
 * - 8 bytes: tokenTotalSupply (u64)
 * - 1 byte: complete (bool)
 */
export function decodeBondingCurveState(data: Buffer): BondingCurveState | null {
  try {
    if (data.length < 49) {
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

    return {
      virtualTokenReserves,
      virtualSolReserves,
      realTokenReserves,
      realSolReserves,
      tokenTotalSupply,
      complete,
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
 * Uses the constant product formula:
 * tokens_out = virtual_token_reserves - (virtual_token_reserves * virtual_sol_reserves) / (virtual_sol_reserves + sol_in)
 *
 * @param state - Current bonding curve state
 * @param solIn - Amount of SOL to spend (in lamports)
 * @returns Expected tokens out (in smallest units)
 */
export function calculateBuyTokensOut(state: BondingCurveState, solIn: BN): BN {
  // K = virtualTokenReserves * virtualSolReserves
  const k = state.virtualTokenReserves.mul(state.virtualSolReserves);

  // new_sol_reserves = virtualSolReserves + solIn
  const newSolReserves = state.virtualSolReserves.add(solIn);

  // new_token_reserves = K / new_sol_reserves
  const newTokenReserves = k.div(newSolReserves);

  // tokens_out = virtualTokenReserves - new_token_reserves
  const tokensOut = state.virtualTokenReserves.sub(newTokenReserves);

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
 * Build the buy instruction for pump.fun
 *
 * pump.fun Buy instruction accounts:
 * 0: global
 * 1: feeRecipient
 * 2: mint
 * 3: bondingCurve
 * 4: associatedBondingCurve
 * 5: associatedUser (user's token account)
 * 6: user
 * 7: systemProgram
 * 8: tokenProgram
 * 9: rent (deprecated but may still be needed)
 * 10: eventAuthority
 * 11: program
 */
function buildBuyInstruction(
  mint: PublicKey,
  bondingCurve: PublicKey,
  associatedBondingCurve: PublicKey,
  userTokenAccount: PublicKey,
  user: PublicKey,
  amountLamports: BN,
  maxTokenAmount: BN
): TransactionInstruction {
  // Buy instruction discriminator (first 8 bytes of sha256("global:buy"))
  const discriminator = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

  // Instruction data: discriminator + amount (u64) + maxSolCost (u64)
  const data = Buffer.alloc(24);
  discriminator.copy(data, 0);
  amountLamports.toArrayLike(Buffer, 'le', 8).copy(data, 8);
  maxTokenAmount.toArrayLike(Buffer, 'le', 8).copy(data, 16);

  const keys = [
    { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
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
 * pump.fun Sell instruction accounts:
 * 0: global
 * 1: feeRecipient
 * 2: mint
 * 3: bondingCurve
 * 4: associatedBondingCurve
 * 5: associatedUser (user's token account)
 * 6: user
 * 7: systemProgram
 * 8: associatedTokenProgram
 * 9: tokenProgram
 * 10: eventAuthority
 * 11: program
 */
function buildSellInstruction(
  mint: PublicKey,
  bondingCurve: PublicKey,
  associatedBondingCurve: PublicKey,
  userTokenAccount: PublicKey,
  user: PublicKey,
  tokenAmount: BN,
  minSolOutput: BN
): TransactionInstruction {
  // Sell instruction discriminator (first 8 bytes of sha256("global:sell"))
  const discriminator = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

  // Instruction data: discriminator + amount (u64) + minSolOutput (u64)
  const data = Buffer.alloc(24);
  discriminator.copy(data, 0);
  tokenAmount.toArrayLike(Buffer, 'le', 8).copy(data, 8);
  minSolOutput.toArrayLike(Buffer, 'le', 8).copy(data, 16);

  const keys = [
    { pubkey: PUMP_FUN_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_FUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_FUN_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_FUN_PROGRAM_ID, isSigner: false, isWritable: false },
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
  } = params;

  try {
    // Get bonding curve state
    const state = await getBondingCurveState(connection, bondingCurve);
    if (!state) {
      return {
        success: false,
        error: 'Failed to get bonding curve state',
      };
    }

    // Check if bonding curve is complete (graduated)
    if (state.complete) {
      return {
        success: false,
        error: 'Token has graduated from bonding curve',
      };
    }

    // Calculate expected tokens out
    const amountLamports = new BN(Math.floor(amountSol * LAMPORTS_PER_SOL));
    const expectedTokens = calculateBuyTokensOut(state, amountLamports);

    // Apply slippage - minimum tokens we'll accept
    const slippageMultiplier = (10000 - slippageBps) / 10000;
    const minTokensOut = new BN(Math.floor(expectedTokens.toNumber() * slippageMultiplier));

    logger.debug(
      {
        mint: mint.toString(),
        amountSol,
        expectedTokens: expectedTokens.toString(),
        minTokensOut: minTokensOut.toString(),
        slippageBps,
      },
      'Preparing pump.fun buy'
    );

    // Get or create user token account
    const userTokenAccount = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    const associatedBondingCurve = deriveAssociatedBondingCurve(bondingCurve, mint);

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
    if (!userTokenAccountInfo) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          userTokenAccount,
          wallet.publicKey,
          mint
        )
      );
    }

    // Add buy instruction
    transaction.add(
      buildBuyInstruction(
        mint,
        bondingCurve,
        associatedBondingCurve,
        userTokenAccount,
        wallet.publicKey,
        amountLamports,
        minTokensOut
      )
    );

    // Get recent blockhash and sign
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    // Send and confirm
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    logger.info(
      {
        mint: mint.toString(),
        signature,
        amountSol,
        expectedTokens: expectedTokens.toString(),
      },
      'pump.fun buy successful'
    );

    return {
      success: true,
      signature,
      tokensReceived: expectedTokens.toNumber(),
    };
  } catch (error) {
    logger.error({ error, mint: mint.toString() }, 'pump.fun buy failed');
    return {
      success: false,
      error: String(error),
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
  } = params;

  try {
    // Get bonding curve state
    const state = await getBondingCurveState(connection, bondingCurve);
    if (!state) {
      return {
        success: false,
        error: 'Failed to get bonding curve state',
      };
    }

    // Note: Can still sell after graduation, but price is different
    const tokenAmountBN = new BN(tokenAmount);
    const expectedSol = calculateSellSolOut(state, tokenAmountBN);

    // Apply slippage - minimum SOL we'll accept
    const slippageMultiplier = (10000 - slippageBps) / 10000;
    const minSolOut = new BN(Math.floor(expectedSol.toNumber() * slippageMultiplier));

    logger.debug(
      {
        mint: mint.toString(),
        tokenAmount,
        expectedSol: expectedSol.toString(),
        minSolOut: minSolOut.toString(),
        slippageBps,
      },
      'Preparing pump.fun sell'
    );

    const userTokenAccount = getAssociatedTokenAddressSync(mint, wallet.publicKey);
    const associatedBondingCurve = deriveAssociatedBondingCurve(bondingCurve, mint);

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
        minSolOut
      )
    );

    // Get recent blockhash and sign
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = wallet.publicKey;
    transaction.sign(wallet);

    // Send and confirm
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });

    await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed'
    );

    logger.info(
      {
        mint: mint.toString(),
        signature,
        tokenAmount,
        expectedSol: expectedSol.toString(),
      },
      'pump.fun sell successful'
    );

    return {
      success: true,
      signature,
      solReceived: expectedSol.toNumber(),
    };
  } catch (error) {
    logger.error({ error, mint: mint.toString() }, 'pump.fun sell failed');
    return {
      success: false,
      error: String(error),
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
