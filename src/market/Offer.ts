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
 * Calculate effective price including distance penalty.
 * Hauling resources costs money, so distant offers are more expensive.
 *
 * Note: Abstract resources (work-ticks, etc.) don't incur hauling costs
 * since they represent labor delivered by creep movement, not physical goods.
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
