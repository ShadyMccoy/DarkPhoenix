/**
 * Position in the game world for location-based calculations.
 * Abstract from Screeps RoomPosition.
 */
export interface Position {
  x: number;
  y: number;
  roomName: string;
}

/**
 * An Offer represents a corp's willingness to buy or sell a resource.
 *
 * Offers are posted each tick and matched by the ChainPlanner to form
 * viable production chains.
 */
export interface Offer {
  /** Unique identifier for this offer */
  id: string;

  /** The corp making this offer */
  corpId: string;

  /** Whether this is a buy or sell offer */
  type: "buy" | "sell";

  /** Resource type being offered (energy, work-ticks, carry-ticks, rcl-progress, etc.) */
  resource: string;

  /** Quantity available or needed */
  quantity: number;

  /** Price per unit (for sells: cost + margin) */
  price: number;

  /** Duration in ticks this offer is valid */
  duration: number;

  /** Where the resource is located (for distance calculations) */
  location?: Position;
}

/**
 * Standard resource types in the economic system
 */
export type ResourceType =
  | "energy"
  | "work-ticks"
  | "carry-ticks"
  | "move-ticks"
  | "haul-demand"
  | "rcl-progress"
  | "spawn-time";

/**
 * HAUL capacity per CARRY part (with 1:1 MOVE on roads).
 *
 * Derivation:
 * - Each CARRY part holds 50 energy
 * - Round trip = 2 × distance ticks (on roads with 1:1 MOVE)
 * - Throughput = 50 / (2 × distance) energy/tick
 * - HAUL capacity = throughput × distance = 50/2 = 25
 */
export const HAUL_PER_CARRY = 25;

/**
 * Calculate the per-tick rate of an offer
 */
export function perTick(offer: Offer): number {
  if (offer.duration <= 0) return 0;
  return offer.quantity / offer.duration;
}

/**
 * Calculate the unit price of an offer
 */
export function unitPrice(offer: Offer): number {
  if (offer.quantity <= 0) return 0;
  return offer.price / offer.quantity;
}

/**
 * Calculate Manhattan distance between two positions.
 * Returns Infinity if in different rooms.
 */
export function manhattanDistance(a: Position, b: Position): number {
  if (a.roomName !== b.roomName) {
    // Cross-room distance: estimate based on room name parsing
    return estimateCrossRoomDistance(a, b);
  }
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Estimate distance between positions in different rooms.
 * Uses room coordinate parsing for multi-room distance.
 */
export function estimateCrossRoomDistance(a: Position, b: Position): number {
  const aCoords = parseRoomName(a.roomName);
  const bCoords = parseRoomName(b.roomName);

  if (!aCoords || !bCoords) return Infinity;

  // Each room is 50 tiles, add in-room distances
  const roomDist =
    (Math.abs(aCoords.x - bCoords.x) + Math.abs(aCoords.y - bCoords.y)) * 50;
  const inRoomDist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  return roomDist + inRoomDist;
}

/**
 * Parse room name into coordinates (e.g., "W1N2" -> { x: -1, y: 2 })
 */
export function parseRoomName(
  roomName: string
): { x: number; y: number } | null {
  const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return null;

  const x = match[1] === "W" ? -parseInt(match[2], 10) : parseInt(match[2], 10);
  const y = match[3] === "N" ? parseInt(match[4], 10) : -parseInt(match[4], 10);

  return { x, y };
}

/**
 * Abstract resource types that don't require physical hauling.
 * These include labor-time resources that are delivered by creep movement.
 */
const ABSTRACT_RESOURCES = new Set([
  "work-ticks",
  "carry-ticks",
  "move-ticks",
  "haul-demand",
  "spawn-time",
  "rcl-progress",
]);

/**
 * Resources where distance affects effective work time rather than hauling cost.
 * For these resources, the "landed cost" is based on reduced productivity due to travel.
 */
const CREEP_DELIVERY_RESOURCES = new Set([
  "spawn-capacity",
]);

/**
 * Default creep lifetime in ticks (Screeps constant).
 * Used for landed cost calculations.
 */
const CREEP_LIFETIME = 1500;

/**
 * Calculate the productivity factor for a creep based on travel distance.
 *
 * This is the fraction of lifetime spent working (not traveling).
 * - Same location: factor = 1.0 (100% productive)
 * - 750 tiles away: factor = 0.5 (50% productive)
 * - 1500 tiles away: factor ≈ 0 (no productive time)
 *
 * @param spawnLocation Where the creep is spawned
 * @param workLocation Where the creep will work
 * @param creepLifetime Optional custom lifetime (default: CREEP_LIFETIME)
 * @returns Productivity factor (0 to 1)
 */
export function creepProductivityFactor(
  spawnLocation: Position,
  workLocation: Position,
  creepLifetime: number = CREEP_LIFETIME
): number {
  const travelTime = manhattanDistance(spawnLocation, workLocation);

  if (travelTime === Infinity || travelTime >= creepLifetime) {
    return 0;
  }

  return (creepLifetime - travelTime) / creepLifetime;
}

/**
 * Calculate how much raw spawn-capacity a buyer needs to purchase
 * to receive a desired amount of effective work at their location.
 *
 * This is the BUYER'S perspective: "I need X effective work, how much do I buy?"
 *
 * Example:
 * - Buyer needs 10,000 effective work-ticks at their source
 * - Spawn is 750 tiles away (50% productivity)
 * - Buyer must purchase 20,000 raw work-ticks
 *
 * @param effectiveQuantityNeeded Effective work the buyer needs
 * @param spawnLocation Where the creep is spawned
 * @param workLocation Where the creep will work (buyer's location)
 * @param creepLifetime Optional custom lifetime (default: CREEP_LIFETIME)
 * @returns Raw quantity buyer must purchase (Infinity if unreachable)
 */
export function rawQuantityForEffectiveWork(
  effectiveQuantityNeeded: number,
  spawnLocation: Position,
  workLocation: Position,
  creepLifetime: number = CREEP_LIFETIME
): number {
  const factor = creepProductivityFactor(spawnLocation, workLocation, creepLifetime);

  if (factor <= 0) {
    return Infinity; // Can't get any effective work from this spawn
  }

  return effectiveQuantityNeeded / factor;
}

/**
 * Calculate the effective quantity a buyer receives from a spawn-capacity offer.
 *
 * This is the BUYER'S perspective: "If I buy this offer, how much effective work do I get?"
 *
 * Example:
 * - Spawn offers 20,000 work-ticks of capacity
 * - Spawn is 750 tiles away (50% productivity)
 * - Buyer receives 10,000 effective work-ticks
 *
 * @param rawQuantity Raw spawn-capacity quantity in the offer
 * @param spawnLocation Where the creep is spawned
 * @param workLocation Where the creep will work (buyer's location)
 * @param creepLifetime Optional custom lifetime (default: CREEP_LIFETIME)
 * @returns Effective quantity buyer receives (0 if unreachable)
 */
export function effectiveQuantityFromCreep(
  rawQuantity: number,
  spawnLocation: Position,
  workLocation: Position,
  creepLifetime: number = CREEP_LIFETIME
): number {
  const factor = creepProductivityFactor(spawnLocation, workLocation, creepLifetime);
  return rawQuantity * factor;
}

/**
 * Calculate the landed cost for creep-based resources (spawn-capacity).
 *
 * For creeps, the "landed cost" factors in reduced effective work time due to
 * travel distance. A creep from a farther spawn spends more time walking and
 * less time working, so the cost per unit of productive work is higher.
 *
 * Formula: landedCost = basePrice / productivityFactor
 *
 * This scales the price inversely with productivity:
 * - A creep that walks 100 ticks has 1400 work ticks → 1.07x price multiplier
 * - A creep that walks 300 ticks has 1200 work ticks → 1.25x price multiplier
 * - A creep that walks 750 ticks has 750 work ticks → 2.0x price multiplier
 *
 * @param basePrice The base spawn-capacity price
 * @param spawnLocation Where the creep is spawned
 * @param workLocation Where the creep will work (buyer's location)
 * @param creepLifetime Optional custom lifetime (default: CREEP_LIFETIME)
 * @returns The landed cost accounting for travel time penalty
 */
export function landedCostForCreep(
  basePrice: number,
  spawnLocation: Position,
  workLocation: Position,
  creepLifetime: number = CREEP_LIFETIME
): number {
  const factor = creepProductivityFactor(spawnLocation, workLocation, creepLifetime);

  if (factor <= 0) {
    return Infinity; // Can't reach the work location
  }

  // Price scales inversely with productivity
  // If factor = 1.0 (local), price unchanged
  // If factor = 0.5 (remote), price doubles
  return basePrice / factor;
}

/**
 * Calculate effective price including distance penalty.
 * Hauling resources costs money, so distant offers are more expensive.
 *
 * Handles three categories of resources:
 * 1. Abstract resources (work-ticks, etc.) - no distance penalty
 * 2. Creep delivery resources (spawn-capacity) - travel time penalty
 * 3. Physical resources (energy) - hauling cost penalty
 *
 * @param offer The sell offer
 * @param buyerLocation Where the buyer needs the resource
 * @param haulingCostPerTile Cost per tile of distance (default: 0.01 credits/tile)
 */
export function effectivePrice(
  offer: Offer,
  buyerLocation: Position,
  haulingCostPerTile: number = 0.01
): number {
  if (!offer.location) return offer.price;

  // Abstract resources don't require physical hauling
  if (ABSTRACT_RESOURCES.has(offer.resource)) {
    return offer.price;
  }

  // Creep delivery resources use travel time penalty instead of hauling cost
  if (CREEP_DELIVERY_RESOURCES.has(offer.resource)) {
    return landedCostForCreep(offer.price, offer.location, buyerLocation);
  }

  const distance = manhattanDistance(offer.location, buyerLocation);
  if (distance === Infinity) {
    return Infinity; // Can't haul across unreachable rooms
  }

  const haulingCost = distance * haulingCostPerTile * offer.quantity;
  return offer.price + haulingCost;
}

/**
 * Check if two offers can potentially match (opposite types, same resource)
 */
export function canMatch(buyOffer: Offer, sellOffer: Offer): boolean {
  return (
    buyOffer.type === "buy" &&
    sellOffer.type === "sell" &&
    buyOffer.resource === sellOffer.resource
  );
}

/**
 * Create a unique offer ID
 */
export function createOfferId(corpId: string, resource: string, tick: number): string {
  return `${corpId}-${resource}-${tick}`;
}

/**
 * Sort offers by effective price (cheapest first)
 */
export function sortByEffectivePrice(
  offers: Offer[],
  buyerLocation: Position
): Offer[] {
  return [...offers].sort(
    (a, b) => effectivePrice(a, buyerLocation) - effectivePrice(b, buyerLocation)
  );
}
