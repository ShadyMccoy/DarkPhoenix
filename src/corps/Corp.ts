import { Position } from "../types/Position";
import { ChainScene, CorpEconomics } from "./economics";

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
  | "scout"
  | "reservation"
  | "claim"
  | "moving";

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
  public readonly id: string;

  /** Type of corp (mining, spawning, etc.) */
  public readonly type: CorpType;

  /** Node (territory) this corp operates in */
  public readonly nodeId: string;

  /** Current credit balance */
  public balance = 0;

  /** Total revenue earned over lifetime */
  public totalRevenue = 0;

  /** Total costs incurred over lifetime */
  public totalCost = 0;

  /** Tick when corp was created */
  public createdAt = 0;

  /** Whether corp is currently active (part of a funded chain) */
  public isActive = false;

  /** Last tick this corp performed work */
  public lastActivityTick = 0;

  /**
   * RETIRING: the planner has stopped commissioning this corp, but it is kept in
   * the store while it still has living creeps so they finish their work and are
   * never orphaned (see materializeCommissions' hysteresis). A retiring corp runs
   * its existing creeps to natural death/recycle but requests NO new spawns - so
   * the planner's decision to wind the corp down is honoured while its fleet
   * drains. Transient (recomputed each materialize); never serialized.
   */
  public retiring = false;

  /** Units produced (energy harvested, carried, etc.) for marginal cost calculation */
  public unitsProduced = 0;

  /** Expected units to be produced over lifetime (for amortizing upfront costs) */
  public expectedUnitsProduced = 0;

  /** Units consumed (energy used) for tracking consumption */
  public unitsConsumed = 0;

  /**
   * Rolling production-rate meter (in-memory, not serialized).
   * Anchors `unitsProduced` at a tick so {@link productionRate} can report a
   * recent units/tick rate to compare against {@link budgetedRate}. Resets after
   * a global reset, which only costs one window of warm-up.
   */
  private rateAnchorTick = 0;
  private rateAnchorUnits = 0;

  /** Window (ticks) over which the production rate is measured. */
  private static readonly RATE_WINDOW = 100;

  /** Last tick when planning was performed */
  public lastPlannedTick = 0;

  /** How often to re-run planning (ticks) */
  protected static readonly PLANNING_INTERVAL = 100;

  /** Optional custom ID generator for deterministic testing */
  private static idGenerator: ((type: CorpType, nodeId: string) => string) | null = null;

  /** Counter for default sequential IDs in test mode */
  private static idCounter = 0;

  public constructor(type: CorpType, nodeId: string, customId?: string) {
    this.id = customId ?? this.generateId(type, nodeId);
    this.type = type;
    this.nodeId = nodeId;
  }

  /**
   * Set a custom ID generator for deterministic testing.
   * Pass null to reset to default behavior.
   */
  public static setIdGenerator(generator: ((type: CorpType, nodeId: string) => string) | null): void {
    Corp.idGenerator = generator;
    Corp.idCounter = 0;
  }

  /**
   * Reset ID counter (useful between tests)
   */
  public static resetIdCounter(): void {
    Corp.idCounter = 0;
  }

  /**
   * Generate a unique ID for this corp.
   * IDs are deterministic based on type and nodeId to ensure
   * creeps can always find their assigned corp after global resets.
   */
  protected generateId(type: CorpType, nodeId: string): string {
    if (Corp.idGenerator) {
      return Corp.idGenerator(type, nodeId);
    }
    // Deterministic ID: type-nodeId (no timestamp)
    // This ensures creeps can find their corp after global resets
    return `${type}-${nodeId}`;
  }

  /**
   * Generate a deterministic ID (for testing)
   */
  public static generateTestId(type: CorpType, nodeId: string): string {
    return `${type}-${nodeId}-${Corp.idCounter++}`;
  }

  /**
   * Record revenue from a sale
   */
  public recordRevenue(amount: number): void {
    if (amount <= 0) return;
    this.balance += amount;
    this.totalRevenue += amount;
  }

  /**
   * Record a cost (reduces balance)
   */
  public recordCost(amount: number): void {
    if (amount <= 0) return;
    this.balance -= amount;
    this.totalCost += amount;
  }

  /**
   * Record production of units (for marginal cost calculation)
   */
  public recordProduction(units: number): void {
    if (units <= 0) return;
    this.unitsProduced += units;
  }

  /**
   * Record expected production over lifetime (for amortizing upfront costs).
   * Call this when acquiring a long-lived asset (e.g., picking up a new creep).
   * This prevents price spikes during the bootstrapping period.
   */
  public recordExpectedProduction(units: number): void {
    if (units <= 0) return;
    this.expectedUnitsProduced += units;
  }

  /**
   * Record consumption of units
   */
  public recordConsumption(units: number): void {
    if (units <= 0) return;
    this.unitsConsumed += units;
  }

  /**
   * Get actual ROI based on lifetime revenue and costs
   */
  public getActualROI(): number {
    if (this.totalCost === 0) return 0;
    return (this.totalRevenue - this.totalCost) / this.totalCost;
  }

  /**
   * Get profit (lifetime revenue - cost)
   */
  public getProfit(): number {
    return this.totalRevenue - this.totalCost;
  }

  // ===========================================================================
  // BUDGET vs ACTUAL (variance)
  // ===========================================================================
  //
  // Per-corp ROI is not comparable across corp types (a miner's "energy out"
  // and an upgrader's "control points" are different currencies). But a corp's
  // *variance* - how far its actual throughput strays from what the planner
  // commissioned it for - IS a uniform signal, because it compares a corp only
  // against itself. A large negative variance is the outlier worth looking at:
  // a miner the plan budgeted 10 e/tick that delivers 0 is a stalled corp.

  /**
   * Units/tick this corp was commissioned to produce by the planner. Same unit
   * as {@link recordProduction} for this corp type (so variance is unit-free).
   * Default 0 means "off budget" - the corp is excluded from variance (e.g.
   * scouts, bootstrap). Budgeted corps override this from their assignment.
   */
  public budgetedRate(): number {
    return 0;
  }

  /**
   * Recent actual production rate (units/tick), measured over a rolling window.
   * Rolls the window forward once it has aged past {@link RATE_WINDOW}.
   */
  public productionRate(tick: number): number {
    if (this.rateAnchorTick === 0) {
      this.rateAnchorTick = tick;
      this.rateAnchorUnits = this.unitsProduced;
      return 0;
    }
    const elapsed = tick - this.rateAnchorTick;
    const rate = elapsed > 0 ? (this.unitsProduced - this.rateAnchorUnits) / elapsed : 0;
    if (elapsed >= Corp.RATE_WINDOW) {
      this.rateAnchorTick = tick;
      this.rateAnchorUnits = this.unitsProduced;
    }
    return rate;
  }

  /**
   * Variance of actual production against budget: (actual - budget) / budget.
   * Returns null for off-budget corps (no commissioned rate to compare to).
   * -1 = producing nothing of what it was funded for; 0 = on budget; >0 = over.
   */
  public variance(tick: number): number | null {
    const budget = this.budgetedRate();
    if (budget <= 0) return null;
    return (this.productionRate(tick) - budget) / budget;
  }

  /**
   * Check if corp is bankrupt (negative balance below threshold)
   */
  public isBankrupt(): boolean {
    return this.balance < -100;
  }

  /**
   * Check if corp is dormant (no activity for extended period)
   */
  public isDormant(currentTick: number, threshold = 1500): boolean {
    if (this.lastActivityTick === 0) return false;
    return currentTick - this.lastActivityTick > threshold;
  }

  /**
   * Check if corp should be pruned (bankrupt or dormant)
   */
  public shouldPrune(currentTick: number): boolean {
    return this.isBankrupt() || this.isDormant(currentTick);
  }

  /**
   * Activate this corp (part of a funded chain)
   */
  public activate(tick: number): void {
    this.isActive = true;
    this.lastActivityTick = tick;
  }

  /**
   * Deactivate this corp
   */
  public deactivate(): void {
    this.isActive = false;
  }

  /**
   * Check if planning should be run this tick.
   * Planning is periodic - runs every PLANNING_INTERVAL ticks.
   */
  public shouldPlan(tick: number): boolean {
    return tick - this.lastPlannedTick >= Corp.PLANNING_INTERVAL;
  }

  /**
   * Run planning to compute targets. Called periodically, not every tick.
   * Subclasses override this to analyze state and set their targets.
   * Default implementation does nothing.
   */
  public plan(tick: number): void {
    this.lastPlannedTick = tick;
  }

  /**
   * Serialize corp state for persistence
   */
  public serialize(): SerializedCorp {
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
      lastPlannedTick: this.lastPlannedTick
    };
  }

  /**
   * Restore corp state from persistence
   */
  public deserialize(data: SerializedCorp): void {
    this.balance = data.balance ?? 0;
    this.totalRevenue = data.totalRevenue ?? 0;
    this.totalCost = data.totalCost ?? 0;
    this.createdAt = data.createdAt ?? 0;
    this.isActive = data.isActive ?? false;
    this.lastActivityTick = data.lastActivityTick ?? 0;
    this.unitsProduced = data.unitsProduced ?? 0;
    this.expectedUnitsProduced = data.expectedUnitsProduced ?? 0;
    this.unitsConsumed = data.unitsConsumed ?? 0;
    this.lastPlannedTick = data.lastPlannedTick ?? 0;
  }

  /**
   * Project this corp's per-tick economics in a hypothetical scene, with no
   * live game state - the basis for scoring spawn sites, expansions, etc.
   *
   * The default is "contributes nothing"; corps that take part in a production
   * chain (mining, hauling, upgrading, ...) override it with their own body and
   * cost logic. Because the projection comes from the corp, adding a corp type
   * or improving an existing one changes the scores with no separate model to
   * update.
   */
  project(_scene: ChainScene): CorpEconomics {
    return { costPerTick: 0, throughput: 0, spawnPartsPerTick: 0 };
  }

  /**
   * Perform work for this tick.
   * Subclasses implement this to perform their specific work.
   */
  public abstract work(tick: number): void;

  /**
   * Get the primary position for this corp.
   * Used for distance calculations.
   */
  public abstract getPosition(): Position;
}

/**
 * Calculate ROI from revenue and cost (pure function)
 */
export function calculateROI(revenue: number, cost: number): number {
  if (cost === 0) return 0;
  return (revenue - cost) / cost;
}
