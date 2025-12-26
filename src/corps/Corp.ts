import { Position } from "../types/Position";

/**
 * Corp types in the economic system
 */
export type CorpType =
  | "source"
  | "mining"
  | "spawning"
  | "upgrading"
  | "hauling"
  | "building"
  | "bootstrap"
  | "scout";

/**
 * Serialized corp state for persistence
 */
export interface SerializedCorp {
  id: string;
  type: CorpType;
  nodeId: string;
  balance: number;
  totalRevenue: number;
  totalCost: number;
  createdAt: number;
  isActive: boolean;
  lastActivityTick: number;
  // Production tracking for marginal cost pricing
  unitsProduced: number;
  expectedUnitsProduced: number;
  unitsConsumed: number;
  acquisitionCost: number;
  // Planning state
  lastPlannedTick: number;
}

/**
 * Corp is the base class for all economic entities in the colony.
 *
 * A Corp represents a business unit that:
 * - Receives work assignments from FlowEconomy
 * - Maintains a credit balance for cost tracking
 * - Tracks production metrics for efficiency analysis
 *
 * In the flow-based economy:
 * - FlowEconomy calculates optimal resource allocation
 * - Corps receive MinerAssignment/HaulerAssignment/SinkAllocation
 * - Corps execute work based on these assignments
 */
export abstract class Corp {
  /** Unique identifier for this corp */
  readonly id: string;

  /** Type of corp (mining, spawning, etc.) */
  readonly type: CorpType;

  /** Node (territory) this corp operates in */
  readonly nodeId: string;

  /** Current credit balance */
  balance: number = 0;

  /** Total revenue earned over lifetime */
  totalRevenue: number = 0;

  /** Total costs incurred over lifetime */
  totalCost: number = 0;

  /** Tick when corp was created */
  createdAt: number = 0;

  /** Whether corp is currently active (part of a funded chain) */
  isActive: boolean = false;

  /** Last tick this corp performed work */
  lastActivityTick: number = 0;

  /** Units produced (energy harvested, carried, etc.) for marginal cost calculation */
  unitsProduced: number = 0;

  /** Expected units to be produced over lifetime (for amortizing upfront costs) */
  expectedUnitsProduced: number = 0;

  /** Units consumed (energy used) for tracking consumption */
  unitsConsumed: number = 0;

  /** Total acquisition cost for purchased inputs (for middleman corps like hauling) */
  acquisitionCost: number = 0;

  /** Last tick when planning was performed */
  lastPlannedTick: number = 0;

  /** How often to re-run planning (ticks) */
  protected static readonly PLANNING_INTERVAL = 100;

  /** Base margin for cost-plus pricing (10%) */
  private readonly BASE_MARGIN = 0.1;

  /** Maximum wealth discount on margin (5%) */
  private readonly MAX_WEALTH_DISCOUNT = 0.05;

  /** Balance threshold for maximum discount */
  private readonly WEALTH_THRESHOLD = 10000;

  /** Optional custom ID generator for deterministic testing */
  private static idGenerator: ((type: CorpType, nodeId: string) => string) | null = null;

  /** Counter for default sequential IDs in test mode */
  private static idCounter: number = 0;

  constructor(type: CorpType, nodeId: string, customId?: string) {
    this.id = customId ?? this.generateId(type, nodeId);
    this.type = type;
    this.nodeId = nodeId;
  }

  /**
   * Set a custom ID generator for deterministic testing.
   * Pass null to reset to default behavior.
   */
  static setIdGenerator(generator: ((type: CorpType, nodeId: string) => string) | null): void {
    Corp.idGenerator = generator;
    Corp.idCounter = 0;
  }

  /**
   * Reset ID counter (useful between tests)
   */
  static resetIdCounter(): void {
    Corp.idCounter = 0;
  }

  /**
   * Generate a unique ID for this corp
   */
  protected generateId(type: CorpType, nodeId: string): string {
    if (Corp.idGenerator) {
      return Corp.idGenerator(type, nodeId);
    }
    return `${type}-${nodeId}-${Date.now().toString(36)}`;
  }

  /**
   * Generate a deterministic ID (for testing)
   */
  static generateTestId(type: CorpType, nodeId: string): string {
    return `${type}-${nodeId}-${Corp.idCounter++}`;
  }

  /**
   * Get current margin based on wealth.
   * Wealthy corps can afford lower margins, allowing them to undercut competition.
   *
   * - Balance = 0: 10% margin
   * - Balance >= 10000: 5% margin
   */
  getMargin(): number {
    const wealthRatio = Math.min(this.balance / this.WEALTH_THRESHOLD, 1);
    const discount = wealthRatio * this.MAX_WEALTH_DISCOUNT;
    return this.BASE_MARGIN - discount;
  }

  /**
   * Calculate sell price using cost-plus pricing.
   * Price = input cost × (1 + margin)
   */
  getPrice(inputCost: number): number {
    if (inputCost <= 0) return 0;
    return inputCost * (1 + this.getMargin());
  }

  /**
   * Record revenue from a sale
   */
  recordRevenue(amount: number): void {
    if (amount <= 0) return;
    this.balance += amount;
    this.totalRevenue += amount;
  }

  /**
   * Record a cost (reduces balance)
   */
  recordCost(amount: number): void {
    if (amount <= 0) return;
    this.balance -= amount;
    this.totalCost += amount;
  }

  /**
   * Record production of units (for marginal cost calculation)
   */
  recordProduction(units: number): void {
    if (units <= 0) return;
    this.unitsProduced += units;
  }

  /**
   * Record expected production over lifetime (for amortizing upfront costs).
   * Call this when acquiring a long-lived asset (e.g., picking up a new creep).
   * This prevents price spikes during the bootstrapping period.
   */
  recordExpectedProduction(units: number): void {
    if (units <= 0) return;
    this.expectedUnitsProduced += units;
  }

  /**
   * Record consumption of units
   */
  recordConsumption(units: number): void {
    if (units <= 0) return;
    this.unitsConsumed += units;
  }

  /**
   * Record acquisition cost for purchased inputs (middleman corps)
   */
  recordAcquisition(cost: number, units: number): void {
    if (cost <= 0 || units <= 0) return;
    this.acquisitionCost += cost;
    this.unitsProduced += units;
  }

  /**
   * Get marginal cost per unit produced.
   * For producers: totalCost / unitsProduced
   * For middlemen: (acquisitionCost + operatingCost) / unitsProduced
   *
   * Uses the larger of actual or expected production to amortize upfront costs
   * over the full expected lifetime, preventing price spikes during bootstrapping.
   */
  getMarginalCost(): number {
    // Use max of actual and expected production to amortize upfront costs
    const production = Math.max(this.unitsProduced, this.expectedUnitsProduced);
    if (production === 0) return Infinity;
    // Operating cost = totalCost - acquisitionCost (what we paid to produce/transport)
    const operatingCost = this.totalCost - this.acquisitionCost;
    return (this.acquisitionCost + operatingCost) / production;
  }

  /**
   * Get the sell price per unit using marginal cost + margin
   */
  getSellPrice(): number {
    const marginalCost = this.getMarginalCost();
    if (!isFinite(marginalCost)) return 1; // Default price when no production yet
    return this.getPrice(marginalCost);
  }

  /**
   * Get actual ROI based on lifetime revenue and costs
   */
  getActualROI(): number {
    if (this.totalCost === 0) return 0;
    return (this.totalRevenue - this.totalCost) / this.totalCost;
  }

  /**
   * Get profit (lifetime revenue - cost)
   */
  getProfit(): number {
    return this.totalRevenue - this.totalCost;
  }

  /**
   * Check if corp is bankrupt (negative balance below threshold)
   */
  isBankrupt(): boolean {
    return this.balance < -100;
  }

  /**
   * Check if corp is dormant (no activity for extended period)
   */
  isDormant(currentTick: number, threshold: number = 1500): boolean {
    if (this.lastActivityTick === 0) return false;
    return currentTick - this.lastActivityTick > threshold;
  }

  /**
   * Check if corp should be pruned (bankrupt or dormant)
   */
  shouldPrune(currentTick: number): boolean {
    return this.isBankrupt() || this.isDormant(currentTick);
  }

  /**
   * Apply taxation (reduces balance by percentage)
   * Returns the amount taxed
   */
  applyTax(rate: number): number {
    if (this.balance <= 0 || rate <= 0) return 0;
    const taxAmount = this.balance * rate;
    this.balance -= taxAmount;
    return taxAmount;
  }

  /**
   * Activate this corp (part of a funded chain)
   */
  activate(tick: number): void {
    this.isActive = true;
    this.lastActivityTick = tick;
  }

  /**
   * Deactivate this corp
   */
  deactivate(): void {
    this.isActive = false;
  }

  /**
   * Check if planning should be run this tick.
   * Planning is periodic - runs every PLANNING_INTERVAL ticks.
   */
  shouldPlan(tick: number): boolean {
    return tick - this.lastPlannedTick >= Corp.PLANNING_INTERVAL;
  }

  /**
   * Run planning to compute targets. Called periodically, not every tick.
   * Subclasses override this to analyze state and set their targets.
   * Default implementation does nothing.
   */
  plan(tick: number): void {
    this.lastPlannedTick = tick;
  }

  /**
   * Serialize corp state for persistence
   */
  serialize(): SerializedCorp {
    return {
      id: this.id,
      type: this.type,
      nodeId: this.nodeId,
      balance: this.balance,
      totalRevenue: this.totalRevenue,
      totalCost: this.totalCost,
      createdAt: this.createdAt,
      isActive: this.isActive,
      lastActivityTick: this.lastActivityTick,
      unitsProduced: this.unitsProduced,
      expectedUnitsProduced: this.expectedUnitsProduced,
      unitsConsumed: this.unitsConsumed,
      acquisitionCost: this.acquisitionCost,
      lastPlannedTick: this.lastPlannedTick,
    };
  }

  /**
   * Restore corp state from persistence
   */
  deserialize(data: SerializedCorp): void {
    this.balance = data.balance ?? 0;
    this.totalRevenue = data.totalRevenue ?? 0;
    this.totalCost = data.totalCost ?? 0;
    this.createdAt = data.createdAt ?? 0;
    this.isActive = data.isActive ?? false;
    this.lastActivityTick = data.lastActivityTick ?? 0;
    this.unitsProduced = data.unitsProduced ?? 0;
    this.expectedUnitsProduced = data.expectedUnitsProduced ?? 0;
    this.unitsConsumed = data.unitsConsumed ?? 0;
    this.acquisitionCost = data.acquisitionCost ?? 0;
    this.lastPlannedTick = data.lastPlannedTick ?? 0;
  }

  /**
   * Perform work for this tick.
   * Subclasses implement this to perform their specific work.
   */
  abstract work(tick: number): void;

  /**
   * Get the primary position for this corp.
   * Used for distance calculations.
   */
  abstract getPosition(): Position;
}

/**
 * Calculate margin for a given balance (pure function for testing)
 */
export function calculateMargin(
  balance: number,
  baseMargin: number = 0.1,
  maxDiscount: number = 0.05,
  threshold: number = 10000
): number {
  const wealthRatio = Math.min(balance / threshold, 1);
  const discount = wealthRatio * maxDiscount;
  return baseMargin - discount;
}

/**
 * Calculate price with margin (pure function for testing)
 */
export function calculatePrice(inputCost: number, margin: number): number {
  if (inputCost <= 0) return 0;
  return inputCost * (1 + margin);
}

/**
 * Calculate ROI from revenue and cost (pure function)
 */
export function calculateROI(revenue: number, cost: number): number {
  if (cost === 0) return 0;
  return (revenue - cost) / cost;
}
