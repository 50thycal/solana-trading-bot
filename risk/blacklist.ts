import fs from 'fs';
import path from 'path';
import { logger } from '../helpers';
import { getConfig } from '../helpers/config-validator';

/**
 * Blacklist data structure stored in JSON
 */
interface BlacklistData {
  tokenMints: string[];
  creatorAddresses: string[];
}

/**
 * Blacklist manager for blocking known scam tokens and creators.
 * Persists to JSON file in data directory.
 */
export class Blacklist {
  private tokenMints: Set<string> = new Set();
  private creatorAddresses: Set<string> = new Set();
  private filePath: string;
  private initialized: boolean = false;

  constructor() {
    const config = getConfig();
    this.filePath = path.join(config.dataDir, 'blacklist.json');
  }

  /**
   * Initialize blacklist by loading from JSON file
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
   * Load blacklist from JSON file
   */
  private async load(): Promise<void> {
    try {
      // Ensure data directory exists
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (!fs.existsSync(this.filePath)) {
        // Create empty blacklist file
        await this.save();
        return;
      }

      const data = fs.readFileSync(this.filePath, 'utf-8');
      const parsed: BlacklistData = JSON.parse(data);

      this.tokenMints = new Set(parsed.tokenMints || []);
      this.creatorAddresses = new Set(parsed.creatorAddresses || []);
    } catch (error) {
      throw new Error(`Failed to load blacklist: ${error}`);
    }
  }

  /**
   * Save blacklist to JSON file
   */
  private async save(): Promise<void> {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: BlacklistData = {
        tokenMints: Array.from(this.tokenMints),
        creatorAddresses: Array.from(this.creatorAddresses),
      };

      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error({ error }, 'Failed to save blacklist');
    }
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

    this.tokenMints.add(mint);
    await this.save();
    logger.info({ mint, reason }, 'Added token to blacklist');
  }

  /**
   * Add a creator address to the blacklist
   */
  async addCreator(address: string, reason?: string): Promise<void> {
    if (this.creatorAddresses.has(address)) {
      return;
    }

    this.creatorAddresses.add(address);
    await this.save();
    logger.info({ address, reason }, 'Added creator to blacklist');
  }

  /**
   * Remove a token mint from the blacklist
   */
  async removeToken(mint: string): Promise<boolean> {
    if (!this.tokenMints.has(mint)) {
      return false;
    }

    this.tokenMints.delete(mint);
    await this.save();
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

    this.creatorAddresses.delete(address);
    await this.save();
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
   * Reload blacklist from file (useful for runtime updates)
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
