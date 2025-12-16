import { Corp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";

/**
 * Constants for mining calculations
 */
export const MINING_CONSTANTS = {
  /** Energy harvested per WORK part per tick */
  HARVEST_POWER: 2,
  /** Standard source regeneration amount */
  SOURCE_CAPACITY: 3000,
  /** Ticks between source regeneration */
  SOURCE_REGEN_TICKS: 300,
  /** Standard creep lifetime in ticks */
  CREEP_LIFETIME: 1500,
  /** Optimal WORK parts for saturating a source */
  OPTIMAL_WORK_PARTS: 5
};

/**
 * Mining statistics for performance tracking
 */
export interface MiningStats {
  /** Total energy harvested over lifetime */
  totalHarvested: number;
  /** Energy harvested this tick */
  harvestedThisTick: number;
  /** Average harvest rate per tick */
  averageRate: number;
  /** Ticks of active mining */
  activeTicks: number;
}

/**
 * MiningCorp buys work-ticks at a source and sells energy at that location.
 *
 * Economic model:
 * - Buys: work-ticks (needs a harvester creep)
 * - Sells: energy at source position
 * - Price = input cost × (1 + margin)
 *
 * A MiningCorp operates one source. Multiple sources = multiple MiningCorps.
 */
export class MiningCorp extends Corp {
  /** Source ID this corp mines */
  readonly sourceId: string;

  /** Position where harvesting occurs */
  private readonly harvestPosition: Position;

  /** Source capacity (energy per regeneration) */
  private readonly sourceCapacity: number;

  /** Current tick for time-based calculations */
  private currentTick: number = 0;

  /** Mining statistics */
  private stats: MiningStats = {
    totalHarvested: 0,
    harvestedThisTick: 0,
    averageRate: 0,
    activeTicks: 0
  };

  /** Work parts currently assigned (from purchased work-ticks) */
  private assignedWorkParts: number = 0;

  /** Input cost for pricing (cost of work-ticks) */
  private inputCost: number = 0;

  constructor(
    nodeId: string,
    sourceId: string,
    harvestPosition: Position,
    sourceCapacity: number = MINING_CONSTANTS.SOURCE_CAPACITY
  ) {
    super("mining", nodeId);
    this.sourceId = sourceId;
    this.harvestPosition = harvestPosition;
    this.sourceCapacity = sourceCapacity;
  }

  /**
   * Get harvest position
   */
  getPosition(): Position {
    return this.harvestPosition;
  }

  /**
   * Calculate expected energy output over a creep lifetime
   */
  calculateExpectedOutput(workParts: number = MINING_CONSTANTS.OPTIMAL_WORK_PARTS): number {
    // Energy per tick = min(workParts × HARVEST_POWER, source/regen)
    const harvestRate = workParts * MINING_CONSTANTS.HARVEST_POWER;
    const sourceRate = this.sourceCapacity / MINING_CONSTANTS.SOURCE_REGEN_TICKS;
    const effectiveRate = Math.min(harvestRate, sourceRate);

    return effectiveRate * MINING_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Calculate work-ticks needed to optimally harvest this source
   */
  calculateRequiredWorkTicks(): number {
    return MINING_CONSTANTS.OPTIMAL_WORK_PARTS * MINING_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Get what this corp needs to buy (work-ticks for harvesting)
   */
  buys(): Offer[] {
    const workTicksNeeded = this.calculateRequiredWorkTicks();

    return [
      {
        id: createOfferId(this.id, "work-ticks", this.currentTick),
        corpId: this.id,
        type: "buy",
        resource: "work-ticks",
        quantity: workTicksNeeded,
        price: 0, // Price determined by seller
        duration: MINING_CONSTANTS.CREEP_LIFETIME,
        location: this.harvestPosition
      }
    ];
  }

  /**
   * Get what this corp sells (energy at source)
   */
  sells(): Offer[] {
    const expectedOutput = this.calculateExpectedOutput();

    return [
      {
        id: createOfferId(this.id, "energy", this.currentTick),
        corpId: this.id,
        type: "sell",
        resource: "energy",
        quantity: expectedOutput,
        price: this.getPrice(this.inputCost),
        duration: MINING_CONSTANTS.CREEP_LIFETIME,
        location: this.harvestPosition
      }
    ];
  }

  /**
   * Set input cost (from purchased work-ticks)
   * This affects the sell price
   */
  setInputCost(cost: number): void {
    this.inputCost = Math.max(0, cost);
  }

  /**
   * Get current input cost
   */
  getInputCost(): number {
    return this.inputCost;
  }

  /**
   * Assign work parts (from a purchased creep)
   */
  assignWorkParts(parts: number): void {
    this.assignedWorkParts = Math.max(0, parts);
  }

  /**
   * Get assigned work parts
   */
  getAssignedWorkParts(): number {
    return this.assignedWorkParts;
  }

  /**
   * Calculate current harvest rate based on assigned work parts
   */
  getCurrentHarvestRate(): number {
    if (this.assignedWorkParts === 0) return 0;

    const harvestRate = this.assignedWorkParts * MINING_CONSTANTS.HARVEST_POWER;
    const sourceRate = this.sourceCapacity / MINING_CONSTANTS.SOURCE_REGEN_TICKS;
    return Math.min(harvestRate, sourceRate);
  }

  /**
   * Perform work for this tick.
   * In actual implementation, this would direct the harvester creep.
   */
  work(tick: number): void {
    this.currentTick = tick;
    this.lastActivityTick = tick;

    // Simulate harvesting if we have work parts assigned
    if (this.assignedWorkParts > 0) {
      const harvested = this.getCurrentHarvestRate();
      this.stats.harvestedThisTick = harvested;
      this.stats.totalHarvested += harvested;
      this.stats.activeTicks++;
      this.stats.averageRate = this.stats.totalHarvested / this.stats.activeTicks;
    } else {
      this.stats.harvestedThisTick = 0;
    }
  }

  /**
   * Record energy delivery and receive payment
   */
  recordDelivery(energyAmount: number, payment: number): void {
    if (energyAmount > 0) {
      this.stats.totalHarvested += energyAmount;
      this.recordRevenue(payment);
    }
  }

  /**
   * Get mining statistics
   */
  getStats(): MiningStats {
    return { ...this.stats };
  }

  /**
   * Get source capacity
   */
  getSourceCapacity(): number {
    return this.sourceCapacity;
  }

  /**
   * Get energy harvested this tick
   */
  getHarvestedThisTick(): number {
    return this.stats.harvestedThisTick;
  }

  /**
   * Calculate efficiency (actual vs theoretical maximum)
   */
  getEfficiency(): number {
    if (this.stats.activeTicks === 0) return 0;

    const maxRate = this.sourceCapacity / MINING_CONSTANTS.SOURCE_REGEN_TICKS;
    const maxPossible = maxRate * this.stats.activeTicks;

    if (maxPossible === 0) return 0;
    return this.stats.totalHarvested / maxPossible;
  }

  /**
   * Check if source is being optimally mined
   */
  isOptimallyMined(): boolean {
    return this.assignedWorkParts >= MINING_CONSTANTS.OPTIMAL_WORK_PARTS;
  }
}

/**
 * Calculate expected energy output (pure function for testing)
 */
export function calculateExpectedOutput(
  workParts: number,
  sourceCapacity: number = MINING_CONSTANTS.SOURCE_CAPACITY,
  creepLifetime: number = MINING_CONSTANTS.CREEP_LIFETIME
): number {
  const harvestRate = workParts * MINING_CONSTANTS.HARVEST_POWER;
  const sourceRate = sourceCapacity / MINING_CONSTANTS.SOURCE_REGEN_TICKS;
  const effectiveRate = Math.min(harvestRate, sourceRate);
  return effectiveRate * creepLifetime;
}

/**
 * Calculate optimal work parts for a source (pure function)
 */
export function calculateOptimalWorkParts(
  sourceCapacity: number = MINING_CONSTANTS.SOURCE_CAPACITY
): number {
  const sourceRate = sourceCapacity / MINING_CONSTANTS.SOURCE_REGEN_TICKS;
  return Math.ceil(sourceRate / MINING_CONSTANTS.HARVEST_POWER);
}

/**
 * Calculate mining efficiency (pure function)
 */
export function calculateMiningEfficiency(
  actualHarvested: number,
  activeTicks: number,
  sourceCapacity: number = MINING_CONSTANTS.SOURCE_CAPACITY
): number {
  if (activeTicks === 0) return 0;
  const maxRate = sourceCapacity / MINING_CONSTANTS.SOURCE_REGEN_TICKS;
  const maxPossible = maxRate * activeTicks;
  if (maxPossible === 0) return 0;
  return actualHarvested / maxPossible;
}
