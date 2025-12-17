import { Corp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";

/**
 * Body configuration for spawning creeps
 */
export interface CreepBody {
  /** Number of WORK parts */
  work: number;
  /** Number of CARRY parts */
  carry: number;
  /** Number of MOVE parts */
  move: number;
}

/**
 * Constants for spawning calculations
 */
export const SPAWN_CONSTANTS = {
  /** Energy cost per WORK part */
  WORK_COST: 100,
  /** Energy cost per CARRY part */
  CARRY_COST: 50,
  /** Energy cost per MOVE part */
  MOVE_COST: 50,
  /** Ticks per body part to spawn */
  SPAWN_TIME_PER_PART: 3,
  /** Standard creep lifetime in ticks */
  CREEP_LIFETIME: 1500,
  /** Fixed cost for spawn time (colony resource) */
  SPAWN_TIME_COST: 50
};

/**
 * Pending spawn request from a buyer
 */
export interface SpawnRequest {
  /** ID of the requesting corp */
  buyerCorpId: string;
  /** Body configuration requested */
  body: CreepBody;
  /** When the request was made */
  requestedAt: number;
  /** Price agreed upon */
  agreedPrice: number;
}

/**
 * SpawningCorp sells creep services (work-ticks, carry-ticks) at a spawn location.
 *
 * Economic model:
 * - Buys: energy (to create creeps)
 * - Sells: work-ticks, carry-ticks, move-ticks
 * - Price = (energy cost + spawn time cost) × (1 + margin)
 *
 * Spawning corps don't directly control creeps - they produce them and
 * the buying corp directs them.
 */
export class SpawningCorp extends Corp {
  /** Spawn ID this corp operates */
  readonly spawnId: string;

  /** Position of the spawn */
  private readonly spawnPosition: Position;

  /** Queue of pending spawn requests */
  private spawnQueue: SpawnRequest[] = [];

  /** Current tick for time-based calculations */
  private currentTick: number = 0;

  /** Standard body configuration this corp offers */
  private standardBody: CreepBody = { work: 2, carry: 2, move: 2 };

  constructor(nodeId: string, spawnId: string, position: Position) {
    super("spawning", nodeId);
    this.spawnId = spawnId;
    this.spawnPosition = position;
  }

  /**
   * Get spawn position
   */
  getPosition(): Position {
    return this.spawnPosition;
  }

  /**
   * Calculate energy cost for a body configuration
   */
  calculateBodyEnergyCost(body: CreepBody): number {
    return (
      body.work * SPAWN_CONSTANTS.WORK_COST +
      body.carry * SPAWN_CONSTANTS.CARRY_COST +
      body.move * SPAWN_CONSTANTS.MOVE_COST
    );
  }

  /**
   * Calculate spawn time for a body configuration
   */
  calculateSpawnTime(body: CreepBody): number {
    const totalParts = body.work + body.carry + body.move;
    return totalParts * SPAWN_CONSTANTS.SPAWN_TIME_PER_PART;
  }

  /**
   * Calculate work-ticks a body produces over lifetime
   */
  calculateWorkTicks(body: CreepBody): number {
    return body.work * SPAWN_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Calculate carry-ticks a body produces over lifetime
   */
  calculateCarryTicks(body: CreepBody): number {
    return body.carry * SPAWN_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Calculate move-ticks a body produces over lifetime
   */
  calculateMoveTicks(body: CreepBody): number {
    return body.move * SPAWN_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Get what this corp needs to buy (energy for spawning)
   */
  buys(): Offer[] {
    const energyNeeded = this.calculateBodyEnergyCost(this.standardBody);

    return [
      {
        id: createOfferId(this.id, "energy", this.currentTick),
        corpId: this.id,
        type: "buy",
        resource: "energy",
        quantity: energyNeeded,
        price: 0, // Price determined by seller
        duration: SPAWN_CONSTANTS.CREEP_LIFETIME,
        location: this.spawnPosition
      }
    ];
  }

  /**
   * Get what this corp sells (work-ticks, carry-ticks, move-ticks)
   */
  sells(): Offer[] {
    const body = this.standardBody;
    const energyCost = this.calculateBodyEnergyCost(body);
    const totalInputCost = energyCost + SPAWN_CONSTANTS.SPAWN_TIME_COST;
    const workTicks = this.calculateWorkTicks(body);
    const carryTicks = this.calculateCarryTicks(body);
    const moveTicks = this.calculateMoveTicks(body);

    const offers: Offer[] = [];

    // Sell work-ticks if body has WORK parts
    if (workTicks > 0) {
      // Price proportional to work part ratio
      const workRatio = body.work / (body.work + body.carry + body.move);
      const workPrice = this.getPrice(totalInputCost * workRatio);

      offers.push({
        id: createOfferId(this.id, "work-ticks", this.currentTick),
        corpId: this.id,
        type: "sell",
        resource: "work-ticks",
        quantity: workTicks,
        price: workPrice,
        duration: SPAWN_CONSTANTS.CREEP_LIFETIME,
        location: this.spawnPosition
      });
    }

    // Sell carry-ticks if body has CARRY parts
    if (carryTicks > 0) {
      const carryRatio = body.carry / (body.work + body.carry + body.move);
      const carryPrice = this.getPrice(totalInputCost * carryRatio);

      offers.push({
        id: createOfferId(this.id, "carry-ticks", this.currentTick),
        corpId: this.id,
        type: "sell",
        resource: "carry-ticks",
        quantity: carryTicks,
        price: carryPrice,
        duration: SPAWN_CONSTANTS.CREEP_LIFETIME,
        location: this.spawnPosition
      });
    }

    // Sell move-ticks if body has MOVE parts
    if (moveTicks > 0) {
      const moveRatio = body.move / (body.work + body.carry + body.move);
      const movePrice = this.getPrice(totalInputCost * moveRatio);

      offers.push({
        id: createOfferId(this.id, "move-ticks", this.currentTick),
        corpId: this.id,
        type: "sell",
        resource: "move-ticks",
        quantity: moveTicks,
        price: movePrice,
        duration: SPAWN_CONSTANTS.CREEP_LIFETIME,
        location: this.spawnPosition
      });
    }

    return offers;
  }

  /**
   * Perform work for this tick.
   * In actual implementation, this would:
   * 1. Check spawn queue
   * 2. Start spawning if spawn is available
   * 3. Track spawned creeps
   */
  work(tick: number): void {
    this.currentTick = tick;
    this.lastActivityTick = tick;

    // Process spawn queue (simplified for abstract model)
    this.processSpawnQueue(tick);
  }

  /**
   * Add a spawn request to the queue
   */
  addSpawnRequest(
    buyerCorpId: string,
    body: CreepBody,
    agreedPrice: number
  ): void {
    this.spawnQueue.push({
      buyerCorpId,
      body,
      requestedAt: this.currentTick,
      agreedPrice
    });
  }

  /**
   * Get current spawn queue
   */
  getSpawnQueue(): SpawnRequest[] {
    return [...this.spawnQueue];
  }

  /**
   * Process the spawn queue
   */
  private processSpawnQueue(tick: number): void {
    // In the abstract model, we simulate spawning completion
    // Real implementation would check Game.spawns[this.spawnId].spawning

    // For now, just process oldest request after spawn time
    if (this.spawnQueue.length === 0) return;

    const oldest = this.spawnQueue[0];
    const spawnTime = this.calculateSpawnTime(oldest.body);

    if (tick - oldest.requestedAt >= spawnTime) {
      // Spawn complete - record revenue
      this.recordRevenue(oldest.agreedPrice);
      this.spawnQueue.shift();
    }
  }

  /**
   * Set the standard body configuration this corp offers
   */
  setStandardBody(body: CreepBody): void {
    this.standardBody = body;
  }

  /**
   * Get the standard body configuration
   */
  getStandardBody(): CreepBody {
    return { ...this.standardBody };
  }

  /**
   * Check if spawn is currently busy
   */
  isSpawning(): boolean {
    return this.spawnQueue.length > 0;
  }

  /**
   * Get estimated time until spawn is available
   */
  getSpawnAvailableIn(): number {
    if (this.spawnQueue.length === 0) return 0;

    let totalTime = 0;
    for (const request of this.spawnQueue) {
      totalTime += this.calculateSpawnTime(request.body);
    }

    const elapsed = this.currentTick - this.spawnQueue[0].requestedAt;
    return Math.max(0, totalTime - elapsed);
  }
}

/**
 * Calculate body energy cost (pure function for testing)
 */
export function calculateBodyEnergyCost(body: CreepBody): number {
  return (
    body.work * SPAWN_CONSTANTS.WORK_COST +
    body.carry * SPAWN_CONSTANTS.CARRY_COST +
    body.move * SPAWN_CONSTANTS.MOVE_COST
  );
}

/**
 * Calculate total work-ticks from a body (pure function)
 */
export function calculateWorkTicks(body: CreepBody): number {
  return body.work * SPAWN_CONSTANTS.CREEP_LIFETIME;
}

/**
 * Calculate total carry-ticks from a body (pure function)
 */
export function calculateCarryTicks(body: CreepBody): number {
  return body.carry * SPAWN_CONSTANTS.CREEP_LIFETIME;
}

/**
 * Calculate spawn time for a body (pure function)
 */
export function calculateSpawnTime(body: CreepBody): number {
  const totalParts = body.work + body.carry + body.move;
  return totalParts * SPAWN_CONSTANTS.SPAWN_TIME_PER_PART;
}
