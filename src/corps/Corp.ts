import { Offer, Position } from "../market/Offer";

/**
 * Corp types in the economic system
 */
export type CorpType =
  | "mining"
  | "spawning"
  | "upgrading"
  | "hauling"
  | "building";

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
}

/**
 * Corp is the base class for all economic entities in the colony.
 *
 * A Corp represents a business unit that:
 * - Posts buy/sell offers for resources
 * - Maintains a credit balance
 * - Uses cost-plus pricing with margin based on wealth
 * - Tracks ROI for performance evaluation
 *
 * Corps compete within the market by:
 * - Wealthy corps have lower margins (undercut competition)
 * - Corps with negative ROI eventually go bankrupt
 * - Successful corps accumulate wealth and grow
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

  /** Base margin for cost-plus pricing (10%) */
  private readonly BASE_MARGIN = 0.1;

  /** Maximum wealth discount on margin (5%) */
  private readonly MAX_WEALTH_DISCOUNT = 0.05;

  /** Balance threshold for maximum discount */
  private readonly WEALTH_THRESHOLD = 10000;

  constructor(type: CorpType, nodeId: string) {
    this.id = this.generateId(type, nodeId);
    this.type = type;
    this.nodeId = nodeId;
  }

  /**
   * Generate a unique ID for this corp
   */
  protected generateId(type: CorpType, nodeId: string): string {
    return `${type}-${nodeId}-${Date.now().toString(36)}`;
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
      lastActivityTick: this.lastActivityTick
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
  }

  /**
   * Get sell offers this corp is making.
   * Each corp type implements this based on what it produces.
   */
  abstract sells(): Offer[];

  /**
   * Get buy offers (what this corp needs as inputs).
   * Each corp type implements this based on its requirements.
   */
  abstract buys(): Offer[];

  /**
   * Perform work for this tick.
   * Each corp type implements its specific behavior.
   */
  abstract work(tick: number): void;

  /**
   * Get the primary position for this corp.
   * Used for distance calculations in offer matching.
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
