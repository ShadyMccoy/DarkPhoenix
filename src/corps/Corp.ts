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
  | "scout"
  | "reservation"
  | "claim"
  | "moving";

/**
 * Serialized corp state for persistence.
 *
 * Only lifecycle metadata and the production meter survive resets - the old
 * money-accounting fields (balance / totalRevenue / totalCost / isActive /
 * unitsConsumed / expectedUnitsProduced) were removed: nothing read them to
 * make a decision (corp lifecycle is driven by materializeCommissions +
 * hasLiveCreeps), so they were pure serialized dead weight.
 */
export interface SerializedCorp {
  id: string;
  type: CorpType;
  nodeId: string;
  createdAt: number;
  lastActivityTick: number;
  /** Units produced (for the variance-vs-budget meter) */
  unitsProduced: number;
  /** Planning state */
  lastPlannedTick: number;
}

/**
 * Corp is the base class for all economic entities in the colony.
 *
 * A Corp represents a business unit that:
 * - Receives work assignments from the CorpPlanner / FlowEconomy
 * - Tracks production throughput for the variance-vs-budget meter
 *
 * In the flow-based economy:
 * - The planner calculates optimal resource allocation
 * - Corps receive MinerAssignment/HaulerAssignment/SinkAllocation
 * - Corps execute work based on these assignments
 *
 * Corp lifecycle (creation / retirement / removal) is driven by
 * materializeCommissions + hasLiveCreeps, NOT by any per-corp balance or ROI.
 */
export abstract class Corp {
  /** Unique identifier for this corp */
  public readonly id: string;

  /** Type of corp (mining, spawning, etc.) */
  public readonly type: CorpType;

  /** Node (territory) this corp operates in */
  public readonly nodeId: string;

  /** Tick when corp was created */
  public createdAt = 0;

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

  /** Units produced (energy harvested, carried, etc.) for the variance meter */
  public unitsProduced = 0;

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
   * Record production of units (for the variance-vs-budget meter)
   */
  public recordProduction(units: number): void {
    if (units <= 0) return;
    this.unitsProduced += units;
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
      createdAt: this.createdAt,
      lastActivityTick: this.lastActivityTick,
      unitsProduced: this.unitsProduced,
      lastPlannedTick: this.lastPlannedTick
    };
  }

  /**
   * Restore corp state from persistence
   */
  public deserialize(data: SerializedCorp): void {
    this.createdAt = data.createdAt ?? 0;
    this.lastActivityTick = data.lastActivityTick ?? 0;
    this.unitsProduced = data.unitsProduced ?? 0;
    this.lastPlannedTick = data.lastPlannedTick ?? 0;
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
