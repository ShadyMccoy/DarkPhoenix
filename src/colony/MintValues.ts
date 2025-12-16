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
  rcl_upgrade: number;

  /** Credits per controller upgrade point (RCL 8, GCL only) */
  gcl_upgrade: number;

  /** Credits for establishing a remote energy source */
  remote_source_tap: number;

  /** Credits for claiming a new room */
  room_claim: number;

  /** Credits for completing a container */
  container_built: number;

  /** Credits for completing an extension */
  extension_built: number;

  /** Credits for completing a road */
  road_built: number;

  /** Credits for completing a storage */
  storage_built: number;

  /** Credits for killing an enemy creep */
  enemy_killed: number;

  /** Credits for completing a tower */
  tower_built: number;

  /** Credits for completing a link */
  link_built: number;
}

/**
 * Default mint values - balanced for steady early-game progression
 */
export const DEFAULT_MINT_VALUES: MintValues = {
  rcl_upgrade: 1000,
  gcl_upgrade: 300,
  remote_source_tap: 500,
  room_claim: 5000,
  container_built: 100,
  extension_built: 200,
  road_built: 10,
  storage_built: 1000,
  enemy_killed: 200,
  tower_built: 500,
  link_built: 300
};

/**
 * Aggressive expansion mint values - encourages remote mining
 */
export const EXPANSION_MINT_VALUES: MintValues = {
  ...DEFAULT_MINT_VALUES,
  remote_source_tap: 1000,
  room_claim: 10000,
  container_built: 200
};

/**
 * Defensive mint values - encourages military activity
 */
export const DEFENSIVE_MINT_VALUES: MintValues = {
  ...DEFAULT_MINT_VALUES,
  enemy_killed: 500,
  tower_built: 1000
};

/**
 * Get mint value for a specific achievement type
 */
export function getMintValue(
  values: MintValues,
  achievement: keyof MintValues
): number {
  return values[achievement] ?? 0;
}

/**
 * Calculate total mint value for an achievement with quantity
 */
export function calculateMint(
  values: MintValues,
  achievement: keyof MintValues,
  quantity: number = 1
): number {
  return getMintValue(values, achievement) * quantity;
}

/**
 * Create custom mint values by overriding defaults
 */
export function createMintValues(
  overrides: Partial<MintValues>
): MintValues {
  return {
    ...DEFAULT_MINT_VALUES,
    ...overrides
  };
}
