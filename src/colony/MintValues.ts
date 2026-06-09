/**
 * MintValues defines how many credits are created for various achievements.
 *
 * This is the primary economic policy lever for the colony:
 * - Higher values encourage more of that activity
 * - Lower values discourage it relative to alternatives
 * - Zero values completely disable that income source
 */
export interface MintValues {
  /** Credits per controller upgrade point (RCL < 8) */
  rclUpgrade: number;

  /** Credits per controller upgrade point (RCL 8, GCL only) */
  gclUpgrade: number;

  /** Credits for establishing a remote energy source */
  remoteSourceTap: number;

  /** Credits for claiming a new room */
  roomClaim: number;

  /** Credits for completing a container */
  containerBuilt: number;

  /** Credits for completing an extension */
  extensionBuilt: number;

  /** Credits for completing a road */
  roadBuilt: number;

  /** Credits for completing a storage */
  storageBuilt: number;

  /** Credits for killing an enemy creep */
  enemyKilled: number;

  /** Credits for completing a tower */
  towerBuilt: number;

  /** Credits for completing a link */
  linkBuilt: number;
}

/**
 * Default mint values - balanced for steady early-game progression
 */
export const DEFAULT_MINT_VALUES: MintValues = {
  rclUpgrade: 1000,
  gclUpgrade: 300,
  remoteSourceTap: 500,
  roomClaim: 5000,
  containerBuilt: 100,
  extensionBuilt: 200,
  roadBuilt: 10,
  storageBuilt: 1000,
  enemyKilled: 200,
  towerBuilt: 500,
  linkBuilt: 300
};

/**
 * Aggressive expansion mint values - encourages remote mining
 */
export const EXPANSION_MINT_VALUES: MintValues = {
  ...DEFAULT_MINT_VALUES,
  remoteSourceTap: 1000,
  roomClaim: 10000,
  containerBuilt: 200
};

/**
 * Defensive mint values - encourages military activity
 */
export const DEFENSIVE_MINT_VALUES: MintValues = {
  ...DEFAULT_MINT_VALUES,
  enemyKilled: 500,
  towerBuilt: 1000
};

/**
 * Get mint value for a specific achievement type
 */
export function getMintValue(values: MintValues, achievement: keyof MintValues): number {
  return values[achievement] ?? 0;
}

/**
 * Calculate total mint value for an achievement with quantity
 */
export function calculateMint(values: MintValues, achievement: keyof MintValues, quantity = 1): number {
  return getMintValue(values, achievement) * quantity;
}

/**
 * Create custom mint values by overriding defaults
 */
export function createMintValues(overrides: Partial<MintValues>): MintValues {
  return {
    ...DEFAULT_MINT_VALUES,
    ...overrides
  };
}
