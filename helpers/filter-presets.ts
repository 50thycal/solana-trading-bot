/**
 * Filter Preset Definitions
 *
 * Presets provide pre-configured filter settings for different risk tolerances:
 * - strict: Maximum safety, recommended for beginners
 * - balanced: Good safety with more opportunities
 * - aggressive: More opportunities but higher risk
 * - custom: Use individual CHECK_IF_* flags from .env
 */

export type FilterPresetName = 'strict' | 'balanced' | 'aggressive' | 'custom';

export interface FilterPreset {
  name: FilterPresetName;
  description: string;
  checkIfBurned: boolean;
  checkIfMintIsRenounced: boolean;
  checkIfFreezable: boolean;
  checkIfMutable: boolean;
  checkIfSocials: boolean;
  minPoolSize: string;
  maxPoolSize: string;
}

/**
 * Strict preset - Maximum safety
 * All safety checks enabled, narrow pool size range
 */
export const PRESET_STRICT: FilterPreset = {
  name: 'strict',
  description: 'Maximum safety - all filters enabled, narrow pool range',
  checkIfBurned: true,
  checkIfMintIsRenounced: true,
  checkIfFreezable: true,
  checkIfMutable: true,
  checkIfSocials: true,
  minPoolSize: '5',
  maxPoolSize: '50',
};

/**
 * Balanced preset - Good safety with more opportunities
 * Core safety checks enabled, wider pool size range
 */
export const PRESET_BALANCED: FilterPreset = {
  name: 'balanced',
  description: 'Good safety with more opportunities - core filters, wider pool range',
  checkIfBurned: true,
  checkIfMintIsRenounced: true,
  checkIfFreezable: true,
  checkIfMutable: false,  // Optional - many legitimate tokens are mutable
  checkIfSocials: false,  // Optional - some good tokens lack socials initially
  minPoolSize: '2',
  maxPoolSize: '100',
};

/**
 * Aggressive preset - More opportunities but higher risk
 * Only essential safety checks, very wide pool size range
 */
export const PRESET_AGGRESSIVE: FilterPreset = {
  name: 'aggressive',
  description: 'More opportunities, higher risk - minimal filters, wide pool range',
  checkIfBurned: false,   // Optional for aggressive trading
  checkIfMintIsRenounced: true,
  checkIfFreezable: true,
  checkIfMutable: false,
  checkIfSocials: false,
  minPoolSize: '1',
  maxPoolSize: '500',
};

/**
 * All available presets
 */
export const FILTER_PRESETS: Record<FilterPresetName, FilterPreset> = {
  strict: PRESET_STRICT,
  balanced: PRESET_BALANCED,
  aggressive: PRESET_AGGRESSIVE,
  custom: {
    name: 'custom',
    description: 'Use individual CHECK_IF_* flags from environment variables',
    // These values are placeholders - actual values come from .env
    checkIfBurned: true,
    checkIfMintIsRenounced: true,
    checkIfFreezable: true,
    checkIfMutable: true,
    checkIfSocials: true,
    minPoolSize: '5',
    maxPoolSize: '50',
  },
};

/**
 * Get a filter preset by name
 */
export function getFilterPreset(name: FilterPresetName): FilterPreset {
  const preset = FILTER_PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown filter preset: ${name}. Valid presets are: ${Object.keys(FILTER_PRESETS).join(', ')}`);
  }
  return preset;
}

/**
 * Resolve filter settings based on preset and optional overrides.
 * If preset is 'custom', uses the provided overrides directly.
 * Otherwise, applies preset values with optional overrides.
 */
export interface ResolvedFilterSettings {
  checkIfBurned: boolean;
  checkIfMintIsRenounced: boolean;
  checkIfFreezable: boolean;
  checkIfMutable: boolean;
  checkIfSocials: boolean;
  minPoolSize: string;
  maxPoolSize: string;
}

export interface FilterOverrides {
  checkIfBurned?: boolean;
  checkIfMintIsRenounced?: boolean;
  checkIfFreezable?: boolean;
  checkIfMutable?: boolean;
  checkIfSocials?: boolean;
  minPoolSize?: string;
  maxPoolSize?: string;
}

/**
 * Resolve filter settings based on preset name and overrides
 * @param presetName - The preset to use ('strict', 'balanced', 'aggressive', 'custom')
 * @param overrides - Override values (used as-is for 'custom' preset)
 */
export function resolveFilterSettings(
  presetName: FilterPresetName,
  overrides: FilterOverrides = {}
): ResolvedFilterSettings {
  // For custom preset, use overrides directly (with defaults)
  if (presetName === 'custom') {
    return {
      checkIfBurned: overrides.checkIfBurned ?? true,
      checkIfMintIsRenounced: overrides.checkIfMintIsRenounced ?? true,
      checkIfFreezable: overrides.checkIfFreezable ?? true,
      checkIfMutable: overrides.checkIfMutable ?? true,
      checkIfSocials: overrides.checkIfSocials ?? true,
      minPoolSize: overrides.minPoolSize ?? '5',
      maxPoolSize: overrides.maxPoolSize ?? '50',
    };
  }

  // For named presets, start with preset values
  const preset = getFilterPreset(presetName);

  return {
    checkIfBurned: preset.checkIfBurned,
    checkIfMintIsRenounced: preset.checkIfMintIsRenounced,
    checkIfFreezable: preset.checkIfFreezable,
    checkIfMutable: preset.checkIfMutable,
    checkIfSocials: preset.checkIfSocials,
    minPoolSize: preset.minPoolSize,
    maxPoolSize: preset.maxPoolSize,
  };
}
