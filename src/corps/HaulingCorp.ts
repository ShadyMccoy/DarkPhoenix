import { Corp } from "./Corp";
import { Offer, Position, createOfferId, manhattanDistance } from "../market/Offer";

/**
 * Constants for hauling calculations
 */
export const HAULING_CONSTANTS = {
  /** Capacity per CARRY part */
  CARRY_CAPACITY: 50,
  /** Standard creep lifetime in ticks */
  CREEP_LIFETIME: 1500,
  /** Ticks per tile movement (on road) */
  MOVE_TICKS_ROAD: 1,
  /** Ticks per tile movement (on plain) */
  MOVE_TICKS_PLAIN: 2,
  /** Default move ticks per tile (average terrain) */
  MOVE_TICKS_DEFAULT: 1.5,
  /** Optimal CARRY parts for a hauler */
  OPTIMAL_CARRY_PARTS: 10
};

/**
 * Hauling statistics for performance tracking
 */
export interface HaulingStats {
  /** Total energy transported over lifetime */
  totalTransported: number;
  /** Energy transported this tick */
  transportedThisTick: number;
  /** Number of complete trips */
  tripCount: number;
  /** Average energy per trip */
  averagePerTrip: number;
}

/**
 * HaulingCorp buys energy at one location and sells it at another.
 * This is arbitrage - the value add is transportation.
 *
 * Economic model:
 * - Buys: energy (at source), carry-ticks (for transport capacity)
 * - Sells: energy (at destination, higher value due to location)
 * - Price = (energy cost + carry-ticks cost) × (1 + margin)
 *
 * The profit comes from energy being worth more at destination
 * (closer to where it's needed, e.g., controller or spawn).
 */
export class HaulingCorp extends Corp {
  /** Source position (where to pick up) */
  private readonly fromLocation: Position;

  /** Destination position (where to deliver) */
  private readonly toLocation: Position;

  /** Distance between source and destination */
  private readonly distance: number;

  /** Current tick for time-based calculations */
  private currentTick: number = 0;

  /** Hauling statistics */
  private stats: HaulingStats = {
    totalTransported: 0,
    transportedThisTick: 0,
    tripCount: 0,
    averagePerTrip: 0
  };

  /** Carry parts currently assigned */
  private assignedCarryParts: number = 0;

  /** Input costs for pricing */
  private energyInputCost: number = 0;
  private carryTicksInputCost: number = 0;

  constructor(nodeId: string, fromLocation: Position, toLocation: Position) {
    super("hauling", nodeId);
    this.fromLocation = fromLocation;
    this.toLocation = toLocation;
    this.distance = manhattanDistance(fromLocation, toLocation);
  }

  /**
   * Get primary position (destination where we deliver)
   */
  getPosition(): Position {
    return this.toLocation;
  }

  /**
   * Get source position
   */
  getFromLocation(): Position {
    return this.fromLocation;
  }

  /**
   * Get destination position
   */
  getToLocation(): Position {
    return this.toLocation;
  }

  /**
   * Get distance between source and destination
   */
  getDistance(): number {
    return this.distance;
  }

  /**
   * Calculate round trip time (ticks per trip)
   */
  calculateRoundTripTime(moveTicksPerTile: number = HAULING_CONSTANTS.MOVE_TICKS_DEFAULT): number {
    return Math.ceil(this.distance * 2 * moveTicksPerTile);
  }

  /**
   * Calculate trips possible in a creep lifetime
   */
  calculateTripsPerLifetime(
    moveTicksPerTile: number = HAULING_CONSTANTS.MOVE_TICKS_DEFAULT
  ): number {
    const roundTripTime = this.calculateRoundTripTime(moveTicksPerTile);
    if (roundTripTime === 0) return HAULING_CONSTANTS.CREEP_LIFETIME; // Same location
    return Math.floor(HAULING_CONSTANTS.CREEP_LIFETIME / roundTripTime);
  }

  /**
   * Calculate total energy that can be transported per lifetime
   */
  calculateThroughput(
    carryParts: number = HAULING_CONSTANTS.OPTIMAL_CARRY_PARTS,
    moveTicksPerTile: number = HAULING_CONSTANTS.MOVE_TICKS_DEFAULT
  ): number {
    const capacity = carryParts * HAULING_CONSTANTS.CARRY_CAPACITY;
    const trips = this.calculateTripsPerLifetime(moveTicksPerTile);
    return capacity * trips;
  }

  /**
   * Calculate carry-ticks needed
   */
  calculateRequiredCarryTicks(): number {
    return HAULING_CONSTANTS.OPTIMAL_CARRY_PARTS * HAULING_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Get what this corp needs to buy
   */
  buys(): Offer[] {
    const throughput = this.calculateThroughput();
    const carryTicksNeeded = this.calculateRequiredCarryTicks();

    return [
      // Buy energy at source
      {
        id: createOfferId(this.id, "energy-source", this.currentTick),
        corpId: this.id,
        type: "buy",
        resource: "energy",
        quantity: throughput,
        price: 0, // Price determined by seller
        duration: HAULING_CONSTANTS.CREEP_LIFETIME,
        location: this.fromLocation
      },
      // Buy carry-ticks for transport
      {
        id: createOfferId(this.id, "carry-ticks", this.currentTick),
        corpId: this.id,
        type: "buy",
        resource: "carry-ticks",
        quantity: carryTicksNeeded,
        price: 0, // Price determined by seller
        duration: HAULING_CONSTANTS.CREEP_LIFETIME,
        location: this.fromLocation // Carrier starts at source
      }
    ];
  }

  /**
   * Get what this corp sells (energy at destination)
   */
  sells(): Offer[] {
    const throughput = this.calculateThroughput();
    const totalInputCost = this.energyInputCost + this.carryTicksInputCost;

    return [
      {
        id: createOfferId(this.id, "energy", this.currentTick),
        corpId: this.id,
        type: "sell",
        resource: "energy",
        quantity: throughput,
        price: this.getPrice(totalInputCost),
        duration: HAULING_CONSTANTS.CREEP_LIFETIME,
        location: this.toLocation
      }
    ];
  }

  /**
   * Set input costs for pricing
   */
  setInputCosts(energyCost: number, carryTicksCost: number): void {
    this.energyInputCost = Math.max(0, energyCost);
    this.carryTicksInputCost = Math.max(0, carryTicksCost);
  }

  /**
   * Get total input cost
   */
  getTotalInputCost(): number {
    return this.energyInputCost + this.carryTicksInputCost;
  }

  /**
   * Assign carry parts (from purchased creep)
   */
  assignCarryParts(parts: number): void {
    this.assignedCarryParts = Math.max(0, parts);
  }

  /**
   * Get assigned carry parts
   */
  getAssignedCarryParts(): number {
    return this.assignedCarryParts;
  }

  /**
   * Calculate current carry capacity
   */
  getCurrentCapacity(): number {
    return this.assignedCarryParts * HAULING_CONSTANTS.CARRY_CAPACITY;
  }

  /**
   * Perform work for this tick.
   * In actual implementation, this would direct hauler creeps.
   */
  work(tick: number): void {
    this.currentTick = tick;
    this.lastActivityTick = tick;

    // Reset per-tick stats
    this.stats.transportedThisTick = 0;
  }

  /**
   * Record a completed delivery
   */
  recordDelivery(energyAmount: number, payment: number): void {
    if (energyAmount > 0) {
      this.stats.transportedThisTick += energyAmount;
      this.stats.totalTransported += energyAmount;
      this.stats.tripCount++;
      this.stats.averagePerTrip =
        this.stats.totalTransported / this.stats.tripCount;
      this.recordRevenue(payment);
    }
  }

  /**
   * Get hauling statistics
   */
  getStats(): HaulingStats {
    return { ...this.stats };
  }

  /**
   * Get energy transported this tick
   */
  getTransportedThisTick(): number {
    return this.stats.transportedThisTick;
  }

  /**
   * Calculate hauling efficiency (actual vs theoretical maximum)
   */
  getEfficiency(): number {
    if (this.stats.tripCount === 0) return 0;

    const expectedPerTrip =
      this.assignedCarryParts * HAULING_CONSTANTS.CARRY_CAPACITY;
    if (expectedPerTrip === 0) return 0;

    return this.stats.averagePerTrip / expectedPerTrip;
  }

  /**
   * Check if route is profitable (destination value > source cost + transport)
   */
  isProfitable(destinationValuePerEnergy: number, sourceValuePerEnergy: number): boolean {
    const throughput = this.calculateThroughput();
    if (throughput === 0) return false;

    const transportCostPerUnit = this.carryTicksInputCost / throughput;
    const totalCostPerUnit = sourceValuePerEnergy + transportCostPerUnit;

    return destinationValuePerEnergy > totalCostPerUnit * (1 + this.getMargin());
  }
}

/**
 * Calculate hauling throughput (pure function for testing)
 */
export function calculateHaulingThroughput(
  carryParts: number,
  distance: number,
  moveTicksPerTile: number = HAULING_CONSTANTS.MOVE_TICKS_DEFAULT,
  creepLifetime: number = HAULING_CONSTANTS.CREEP_LIFETIME
): number {
  const capacity = carryParts * HAULING_CONSTANTS.CARRY_CAPACITY;
  const roundTripTime = Math.ceil(distance * 2 * moveTicksPerTile);
  if (roundTripTime === 0) return capacity * creepLifetime;
  const trips = Math.floor(creepLifetime / roundTripTime);
  return capacity * trips;
}

/**
 * Calculate round trip time (pure function)
 */
export function calculateRoundTripTime(
  distance: number,
  moveTicksPerTile: number = HAULING_CONSTANTS.MOVE_TICKS_DEFAULT
): number {
  return Math.ceil(distance * 2 * moveTicksPerTile);
}

/**
 * Calculate trips per lifetime (pure function)
 */
export function calculateTripsPerLifetime(
  distance: number,
  moveTicksPerTile: number = HAULING_CONSTANTS.MOVE_TICKS_DEFAULT,
  creepLifetime: number = HAULING_CONSTANTS.CREEP_LIFETIME
): number {
  const roundTripTime = calculateRoundTripTime(distance, moveTicksPerTile);
  if (roundTripTime === 0) return creepLifetime;
  return Math.floor(creepLifetime / roundTripTime);
}
