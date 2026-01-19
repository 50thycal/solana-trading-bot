import { logger } from '../helpers';
import { getStateStore } from '../persistence';

/**
 * Blacklist manager for blocking known scam tokens and creators.
 * Uses SQLite persistence via StateStore (Phase 3).
 *
 * Maintains in-memory Sets for fast lookup while persisting to SQLite.
 */
export class Blacklist {
  private tokenMints: Set<string> = new Set();
  private creatorAddresses: Set<string> = new Set();
  private initialized: boolean = false;

  constructor() {}

  /**
   * Initialize blacklist by loading from SQLite database
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      await this.load();
      this.initialized = true;
      logger.info(
        {
          tokenMints: this.tokenMints.size,
          creatorAddresses: this.creatorAddresses.size,
        },
        'Blacklist initialized',
      );
    } catch (error) {
      logger.warn({ error }, 'Failed to load blacklist, starting with empty list');
      this.initialized = true;
    }
  }

  /**
   * Load blacklist from SQLite database
   */
  private async load(): Promise<void> {
    const stateStore = getStateStore();
    if (!stateStore) {
      logger.warn('State store not initialized, blacklist will be empty');
      return;
    }

    // Load tokens
    const tokens = stateStore.getBlacklistedTokens();
    this.tokenMints = new Set(tokens);

    // Load creators
    const creators = stateStore.getBlacklistedCreators();
    this.creatorAddresses = new Set(creators);
  }

  /**
   * Check if a token mint is blacklisted
   */
  isTokenBlacklisted(mint: string): boolean {
    return this.tokenMints.has(mint);
  }

  /**
   * Check if a creator address is blacklisted
   */
  isCreatorBlacklisted(address: string): boolean {
    return this.creatorAddresses.has(address);
  }

  /**
   * Check if either token mint or creator is blacklisted
   */
  isBlacklisted(tokenMint: string, creatorAddress?: string): boolean {
    if (this.tokenMints.has(tokenMint)) {
      logger.debug({ tokenMint }, 'Token is blacklisted');
      return true;
    }

    if (creatorAddress && this.creatorAddresses.has(creatorAddress)) {
      logger.debug({ creatorAddress }, 'Creator is blacklisted');
      return true;
    }

    return false;
  }

  /**
   * Add a token mint to the blacklist
   */
  async addToken(mint: string, reason?: string): Promise<void> {
    if (this.tokenMints.has(mint)) {
      return;
    }

    // Add to in-memory set
    this.tokenMints.add(mint);

    // Persist to SQLite
    const stateStore = getStateStore();
    if (stateStore) {
      stateStore.addToBlacklist({
        address: mint,
        type: 'token',
        reason,
      });
    }

    logger.info({ mint, reason }, 'Added token to blacklist');
  }

  /**
   * Add a creator address to the blacklist
   */
  async addCreator(address: string, reason?: string): Promise<void> {
    if (this.creatorAddresses.has(address)) {
      return;
    }

    // Add to in-memory set
    this.creatorAddresses.add(address);

    // Persist to SQLite
    const stateStore = getStateStore();
    if (stateStore) {
      stateStore.addToBlacklist({
        address,
        type: 'creator',
        reason,
      });
    }

    logger.info({ address, reason }, 'Added creator to blacklist');
  }

  /**
   * Remove a token mint from the blacklist
   */
  async removeToken(mint: string): Promise<boolean> {
    if (!this.tokenMints.has(mint)) {
      return false;
    }

    // Remove from in-memory set
    this.tokenMints.delete(mint);

    // Remove from SQLite
    const stateStore = getStateStore();
    if (stateStore) {
      stateStore.removeFromBlacklist(mint);
    }

    logger.info({ mint }, 'Removed token from blacklist');
    return true;
  }

  /**
   * Remove a creator address from the blacklist
   */
  async removeCreator(address: string): Promise<boolean> {
    if (!this.creatorAddresses.has(address)) {
      return false;
    }

    // Remove from in-memory set
    this.creatorAddresses.delete(address);

    // Remove from SQLite
    const stateStore = getStateStore();
    if (stateStore) {
      stateStore.removeFromBlacklist(address);
    }

    logger.info({ address }, 'Removed creator from blacklist');
    return true;
  }

  /**
   * Get all blacklisted token mints
   */
  getTokenMints(): string[] {
    return Array.from(this.tokenMints);
  }

  /**
   * Get all blacklisted creator addresses
   */
  getCreatorAddresses(): string[] {
    return Array.from(this.creatorAddresses);
  }

  /**
   * Get blacklist statistics
   */
  getStats(): { tokenMints: number; creatorAddresses: number } {
    return {
      tokenMints: this.tokenMints.size,
      creatorAddresses: this.creatorAddresses.size,
    };
  }

  /**
   * Reload blacklist from database (useful for runtime updates)
   */
  async reload(): Promise<void> {
    await this.load();
    logger.info(
      {
        tokenMints: this.tokenMints.size,
        creatorAddresses: this.creatorAddresses.size,
      },
      'Blacklist reloaded',
    );
  }
}

/**
 * Singleton instance
 */
let blacklistInstance: Blacklist | null = null;

/**
 * Get the blacklist instance (creates if not exists)
 */
export function getBlacklist(): Blacklist {
  if (!blacklistInstance) {
    blacklistInstance = new Blacklist();
  }
  return blacklistInstance;
}
