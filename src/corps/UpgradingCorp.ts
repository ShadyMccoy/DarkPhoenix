import { Corp } from "./Corp";
import { Offer, Position, createOfferId } from "../market/Offer";

/**
 * Constants for upgrading calculations
 */
export const UPGRADING_CONSTANTS = {
  /** Upgrade points per WORK part per tick (at RCL < 8) */
  UPGRADE_POWER: 1,
  /** Energy consumed per upgrade point */
  ENERGY_PER_UPGRADE: 1,
  /** Standard creep lifetime in ticks */
  CREEP_LIFETIME: 1500,
  /** Optimal WORK parts for upgrading */
  OPTIMAL_WORK_PARTS: 15,
  /** Maximum upgrade points per tick at RCL 8 */
  MAX_UPGRADE_RCL8: 15
};

/**
 * Upgrading statistics for performance tracking
 */
export interface UpgradingStats {
  /** Total upgrade points produced over lifetime */
  totalUpgradePoints: number;
  /** Upgrade points produced this tick */
  upgradePointsThisTick: number;
  /** Total energy consumed */
  totalEnergyConsumed: number;
  /** Ticks of active upgrading */
  activeTicks: number;
}

/**
 * UpgradingCorp buys energy and work-ticks at a controller and produces RCL progress.
 * This is the "sink" in the economic system - RCL progress triggers credit minting.
 *
 * Economic model:
 * - Buys: energy (consumed for upgrading), work-ticks (upgrader creep)
 * - Sells: rcl-progress (the Colony buys this and mints credits)
 * - Price = (energy cost + work-ticks cost) × (1 + margin)
 *
 * The Colony pays for rcl-progress at mint value, which funds the entire chain.
 */
export class UpgradingCorp extends Corp {
  /** Controller ID this corp upgrades */
  readonly controllerId: string;

  /** Position where upgrading occurs (near controller) */
  private readonly controllerPosition: Position;

  /** Current controller level */
  private controllerLevel: number;

  /** Current tick for time-based calculations */
  private currentTick: number = 0;

  /** Upgrading statistics */
  private stats: UpgradingStats = {
    totalUpgradePoints: 0,
    upgradePointsThisTick: 0,
    totalEnergyConsumed: 0,
    activeTicks: 0
  };

  /** Work parts currently assigned */
  private assignedWorkParts: number = 0;

  /** Input costs for pricing */
  private energyInputCost: number = 0;
  private workTicksInputCost: number = 0;

  constructor(
    nodeId: string,
    controllerPosition: Position,
    controllerLevel: number = 1,
    customId?: string
  ) {
    super("upgrading", nodeId, customId);
    this.controllerId = `controller-${nodeId}`;
    this.controllerPosition = controllerPosition;
    this.controllerLevel = controllerLevel;
  }

  /**
   * Get controller position
   */
  getPosition(): Position {
    return this.controllerPosition;
  }

  /**
   * Get controller level
   */
  getControllerLevel(): number {
    return this.controllerLevel;
  }

  /**
   * Set controller level
   */
  setControllerLevel(level: number): void {
    this.controllerLevel = Math.max(1, Math.min(8, level));
  }

  /**
   * Calculate upgrade points per tick with given work parts
   */
  calculateUpgradeRate(workParts: number): number {
    const baseRate = workParts * UPGRADING_CONSTANTS.UPGRADE_POWER;

    // At RCL 8, upgrading is capped
    if (this.controllerLevel >= 8) {
      return Math.min(baseRate, UPGRADING_CONSTANTS.MAX_UPGRADE_RCL8);
    }

    return baseRate;
  }

  /**
   * Calculate total upgrade points over a creep lifetime
   */
  calculateExpectedOutput(workParts: number = UPGRADING_CONSTANTS.OPTIMAL_WORK_PARTS): number {
    const rate = this.calculateUpgradeRate(workParts);
    return rate * UPGRADING_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Calculate energy needed for expected output
   */
  calculateEnergyNeeded(workParts: number = UPGRADING_CONSTANTS.OPTIMAL_WORK_PARTS): number {
    const output = this.calculateExpectedOutput(workParts);
    return output * UPGRADING_CONSTANTS.ENERGY_PER_UPGRADE;
  }

  /**
   * Calculate work-ticks needed
   */
  calculateRequiredWorkTicks(workParts: number = UPGRADING_CONSTANTS.OPTIMAL_WORK_PARTS): number {
    return workParts * UPGRADING_CONSTANTS.CREEP_LIFETIME;
  }

  /**
   * Get what this corp needs to buy
   */
  buys(): Offer[] {
    const energyNeeded = this.calculateEnergyNeeded();
    const workTicksNeeded = this.calculateRequiredWorkTicks();

    return [
      // Buy energy at controller
      {
        id: createOfferId(this.id, "energy", this.currentTick),
        corpId: this.id,
        type: "buy",
        resource: "energy",
        quantity: energyNeeded,
        price: 0, // Price determined by seller
        duration: UPGRADING_CONSTANTS.CREEP_LIFETIME,
        location: this.controllerPosition
      },
      // Buy work-ticks for upgrading
      {
        id: createOfferId(this.id, "work-ticks", this.currentTick),
        corpId: this.id,
        type: "buy",
        resource: "work-ticks",
        quantity: workTicksNeeded,
        price: 0, // Price determined by seller
        duration: UPGRADING_CONSTANTS.CREEP_LIFETIME,
        location: this.controllerPosition
      }
    ];
  }

  /**
   * Get what this corp sells (RCL progress)
   */
  sells(): Offer[] {
    const expectedOutput = this.calculateExpectedOutput();
    const totalInputCost = this.energyInputCost + this.workTicksInputCost;

    return [
      {
        id: createOfferId(this.id, "rcl-progress", this.currentTick),
        corpId: this.id,
        type: "sell",
        resource: "rcl-progress",
        quantity: expectedOutput,
        price: this.getPrice(totalInputCost),
        duration: UPGRADING_CONSTANTS.CREEP_LIFETIME,
        location: this.controllerPosition
      }
    ];
  }

  /**
   * Set input costs for pricing
   */
  setInputCosts(energyCost: number, workTicksCost: number): void {
    this.energyInputCost = Math.max(0, energyCost);
    this.workTicksInputCost = Math.max(0, workTicksCost);
  }

  /**
   * Get total input cost
   */
  getTotalInputCost(): number {
    return this.energyInputCost + this.workTicksInputCost;
  }

  /**
   * Assign work parts (from purchased creep)
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
   * Perform work for this tick.
   * In actual implementation, this would direct upgrader creeps.
   */
  work(tick: number): void {
    this.currentTick = tick;
    this.lastActivityTick = tick;

    // Simulate upgrading if we have work parts assigned
    if (this.assignedWorkParts > 0) {
      const upgradePoints = this.calculateUpgradeRate(this.assignedWorkParts);
      const energyConsumed = upgradePoints * UPGRADING_CONSTANTS.ENERGY_PER_UPGRADE;

      this.stats.upgradePointsThisTick = upgradePoints;
      this.stats.totalUpgradePoints += upgradePoints;
      this.stats.totalEnergyConsumed += energyConsumed;
      this.stats.activeTicks++;
    } else {
      this.stats.upgradePointsThisTick = 0;
    }
  }

  /**
   * Get upgrade work performed this tick.
   * Used by Colony to mint credits.
   */
  getUpgradeWorkThisTick(): number {
    return this.stats.upgradePointsThisTick;
  }

  /**
   * Record upgrade completion and receive payment
   */
  recordUpgrade(upgradePoints: number, payment: number): void {
    if (upgradePoints > 0) {
      this.stats.totalUpgradePoints += upgradePoints;
      this.recordRevenue(payment);
    }
  }

  /**
   * Get upgrading statistics
   */
  getStats(): UpgradingStats {
    return { ...this.stats };
  }

  /**
   * Calculate efficiency (actual vs theoretical maximum)
   */
  getEfficiency(): number {
    if (this.stats.activeTicks === 0) return 0;

    const maxRate = this.calculateUpgradeRate(this.assignedWorkParts);
    const maxPossible = maxRate * this.stats.activeTicks;

    if (maxPossible === 0) return 0;
    return this.stats.totalUpgradePoints / maxPossible;
  }

  /**
   * Check if upgrading is at maximum capacity
   */
  isAtMaxCapacity(): boolean {
    if (this.controllerLevel < 8) return false;
    return this.assignedWorkParts >= UPGRADING_CONSTANTS.MAX_UPGRADE_RCL8;
  }

  /**
   * Calculate optimal work parts for current RCL
   */
  getOptimalWorkParts(): number {
    if (this.controllerLevel >= 8) {
      return UPGRADING_CONSTANTS.MAX_UPGRADE_RCL8;
    }
    return UPGRADING_CONSTANTS.OPTIMAL_WORK_PARTS;
  }
}

/**
 * Calculate expected upgrade output (pure function for testing)
 */
export function calculateExpectedUpgradeOutput(
  workParts: number,
  controllerLevel: number = 1,
  creepLifetime: number = UPGRADING_CONSTANTS.CREEP_LIFETIME
): number {
  let rate = workParts * UPGRADING_CONSTANTS.UPGRADE_POWER;

  if (controllerLevel >= 8) {
    rate = Math.min(rate, UPGRADING_CONSTANTS.MAX_UPGRADE_RCL8);
  }

  return rate * creepLifetime;
}

/**
 * Calculate energy needed for upgrading (pure function)
 */
export function calculateUpgradeEnergyNeeded(
  workParts: number,
  controllerLevel: number = 1,
  creepLifetime: number = UPGRADING_CONSTANTS.CREEP_LIFETIME
): number {
  const output = calculateExpectedUpgradeOutput(workParts, controllerLevel, creepLifetime);
  return output * UPGRADING_CONSTANTS.ENERGY_PER_UPGRADE;
}

/**
 * Calculate upgrade efficiency (pure function)
 */
export function calculateUpgradeEfficiency(
  actualPoints: number,
  activeTicks: number,
  workParts: number,
  controllerLevel: number = 1
): number {
  if (activeTicks === 0 || workParts === 0) return 0;

  let maxRate = workParts * UPGRADING_CONSTANTS.UPGRADE_POWER;
  if (controllerLevel >= 8) {
    maxRate = Math.min(maxRate, UPGRADING_CONSTANTS.MAX_UPGRADE_RCL8);
  }

  const maxPossible = maxRate * activeTicks;
  if (maxPossible === 0) return 0;

  return actualPoints / maxPossible;
}
