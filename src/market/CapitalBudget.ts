/**
 * @fileoverview CapitalBudget - Tracks capital allocation and spending for corps.
 *
 * In the forward capital flow model, corps receive capital from:
 * 1. Investment contracts (goal corps like upgraders)
 * 2. Sub-contracts (intermediate corps like haulers)
 *
 * This module tracks:
 * - Capital received from upstream buyers
 * - Capital committed to downstream suppliers
 * - Available capital for new contracts
 *
 * Key insight: A corp's "buying power" is limited by the capital
 * they have from upstream contracts, not by infinite demand.
 *
 * @module market/CapitalBudget
 */

import { InvestmentContract, SubContract, remainingBudget } from "./InvestmentContract";

/**
 * Capital source - where the capital came from.
 */
export interface CapitalSource {
  /** Type of source */
  type: "investment" | "sub-contract";

  /** Source contract ID */
  contractId: string;

  /** Amount of capital from this source */
  amount: number;

  /** Amount already spent from this source */
  spent: number;

  /** Resource that must be produced to earn this capital */
  requiredResource: string;

  /** Units that must be delivered */
  requiredQuantity: number;

  /** Units delivered so far */
  deliveredQuantity: number;
}

/**
 * Capital commitment - how capital is allocated to suppliers.
 */
export interface CapitalCommitment {
  /** Sub-contract ID */
  contractId: string;

  /** Supplier corp ID */
  supplierId: string;

  /** Resource being purchased */
  resource: string;

  /** Total committed amount */
  amount: number;

  /** Amount paid so far */
  paid: number;

  /** Linked capital source */
  sourceId: string;
}

/**
 * CapitalBudget tracks a corp's capital allocation.
 */
export class CapitalBudget {
  /** Corp ID this budget belongs to */
  readonly corpId: string;

  /** Capital sources */
  private sources: Map<string, CapitalSource> = new Map();

  /** Capital commitments to suppliers */
  private commitments: Map<string, CapitalCommitment> = new Map();

  constructor(corpId: string) {
    this.corpId = corpId;
  }

  // ===========================================================================
  // Capital Sources
  // ===========================================================================

  /**
   * Add capital from an investment contract.
   */
  addInvestmentCapital(investment: InvestmentContract): void {
    const source: CapitalSource = {
      type: "investment",
      contractId: investment.id,
      amount: remainingBudget(investment),
      spent: 0,
      requiredResource: investment.resource,
      requiredQuantity: remainingBudget(investment) / investment.ratePerUnit,
      deliveredQuantity: 0
    };
    this.sources.set(investment.id, source);
  }

  /**
   * Add capital from a sub-contract (as seller).
   */
  addSubContractCapital(contract: SubContract): void {
    const remainingPayment = contract.price - contract.paid;
    const remainingQuantity = contract.quantity - contract.delivered;

    const source: CapitalSource = {
      type: "sub-contract",
      contractId: contract.id,
      amount: remainingPayment,
      spent: 0,
      requiredResource: contract.resource,
      requiredQuantity: remainingQuantity,
      deliveredQuantity: 0
    };
    this.sources.set(contract.id, source);
  }

  /**
   * Get total capital available (not yet committed).
   */
  getAvailableCapital(): number {
    let total = 0;
    for (const source of this.sources.values()) {
      total += source.amount - source.spent;
    }
    return total;
  }

  /**
   * Get total capital from all sources (including committed).
   */
  getTotalCapital(): number {
    let total = 0;
    for (const source of this.sources.values()) {
      total += source.amount;
    }
    return total;
  }

  /**
   * Get capital committed to suppliers.
   */
  getCommittedCapital(): number {
    let total = 0;
    for (const commitment of this.commitments.values()) {
      total += commitment.amount - commitment.paid;
    }
    return total;
  }

  // ===========================================================================
  // Capital Allocation
  // ===========================================================================

  /**
   * Commit capital to a supplier.
   * Returns true if successful, false if insufficient capital.
   */
  commitToSupplier(
    contractId: string,
    supplierId: string,
    resource: string,
    amount: number
  ): boolean {
    const available = this.getAvailableCapital();
    if (amount > available) {
      return false;
    }

    // Find a source to draw from
    const sourceId = this.findSourceForSpending(amount);
    if (!sourceId) return false;

    const source = this.sources.get(sourceId);
    if (!source) return false;

    // Record spending from source
    source.spent += amount;

    // Record commitment
    const commitment: CapitalCommitment = {
      contractId,
      supplierId,
      resource,
      amount,
      paid: 0,
      sourceId
    };
    this.commitments.set(contractId, commitment);

    return true;
  }

  /**
   * Find a source with enough remaining capital.
   */
  private findSourceForSpending(amount: number): string | null {
    for (const [id, source] of this.sources) {
      const remaining = source.amount - source.spent;
      if (remaining >= amount) {
        return id;
      }
    }

    // Try combining sources (pro-rata)
    let available = 0;
    for (const source of this.sources.values()) {
      available += source.amount - source.spent;
    }
    if (available >= amount) {
      // Return first source - spending will be distributed
      for (const [id, source] of this.sources) {
        if (source.amount - source.spent > 0) {
          return id;
        }
      }
    }

    return null;
  }

  /**
   * Record payment to a supplier.
   */
  recordPayment(contractId: string, amount: number): void {
    const commitment = this.commitments.get(contractId);
    if (!commitment) return;

    commitment.paid = Math.min(commitment.paid + amount, commitment.amount);
  }

  /**
   * Record delivery of our product (earns capital from source).
   */
  recordDelivery(sourceId: string, units: number): number {
    const source = this.sources.get(sourceId);
    if (!source) return 0;

    source.deliveredQuantity += units;

    // Capital is earned proportionally to delivery
    const deliveryRatio = source.requiredQuantity > 0
      ? source.deliveredQuantity / source.requiredQuantity
      : 0;
    const earnedCapital = source.amount * deliveryRatio;

    return earnedCapital;
  }

  // ===========================================================================
  // Budget Queries
  // ===========================================================================

  /**
   * Get maximum we can bid for a resource.
   * This is the available capital that can be spent on suppliers.
   */
  getMaxBid(resource: string): number {
    // Available capital can be spent on any supplier
    return this.getAvailableCapital();
  }

  /**
   * Get budget for a specific supplier type/resource.
   */
  getBudgetFor(resource: string): number {
    // For now, all available capital can be used for any resource
    // Future: could prioritize based on production requirements
    return this.getAvailableCapital();
  }

  /**
   * Check if we can afford a purchase.
   */
  canAfford(amount: number): boolean {
    return amount <= this.getAvailableCapital();
  }

  /**
   * Get required output to fully earn capital.
   */
  getRequiredOutput(): { resource: string; quantity: number }[] {
    const requirements: { resource: string; quantity: number }[] = [];

    for (const source of this.sources.values()) {
      const remaining = source.requiredQuantity - source.deliveredQuantity;
      if (remaining > 0) {
        requirements.push({
          resource: source.requiredResource,
          quantity: remaining
        });
      }
    }

    return requirements;
  }

  // ===========================================================================
  // Serialization
  // ===========================================================================

  /**
   * Serialize budget state.
   */
  serialize(): SerializedCapitalBudget {
    return {
      corpId: this.corpId,
      sources: Array.from(this.sources.values()),
      commitments: Array.from(this.commitments.values())
    };
  }

  /**
   * Restore budget state.
   */
  deserialize(data: SerializedCapitalBudget): void {
    this.sources.clear();
    this.commitments.clear();

    for (const source of data.sources) {
      this.sources.set(source.contractId, source);
    }

    for (const commitment of data.commitments) {
      this.commitments.set(commitment.contractId, commitment);
    }
  }

  /**
   * Clear all capital (for testing or reset).
   */
  clear(): void {
    this.sources.clear();
    this.commitments.clear();
  }

  /**
   * Get summary for debugging.
   */
  getSummary(): {
    totalCapital: number;
    availableCapital: number;
    committedCapital: number;
    sourceCount: number;
    commitmentCount: number;
  } {
    return {
      totalCapital: this.getTotalCapital(),
      availableCapital: this.getAvailableCapital(),
      committedCapital: this.getCommittedCapital(),
      sourceCount: this.sources.size,
      commitmentCount: this.commitments.size
    };
  }
}

/**
 * Serialized budget state.
 */
export interface SerializedCapitalBudget {
  corpId: string;
  sources: CapitalSource[];
  commitments: CapitalCommitment[];
}

/**
 * Global registry of capital budgets by corp ID.
 */
const budgetRegistry: Map<string, CapitalBudget> = new Map();

/**
 * Get or create a capital budget for a corp.
 */
export function getCapitalBudget(corpId: string): CapitalBudget {
  let budget = budgetRegistry.get(corpId);
  if (!budget) {
    budget = new CapitalBudget(corpId);
    budgetRegistry.set(corpId, budget);
  }
  return budget;
}

/**
 * Clear all capital budgets (for testing).
 */
export function clearAllBudgets(): void {
  budgetRegistry.clear();
}

/**
 * Get all corps with capital budgets.
 */
export function getCorpsWithCapital(): string[] {
  return Array.from(budgetRegistry.keys()).filter(
    corpId => budgetRegistry.get(corpId)!.getAvailableCapital() > 0
  );
}

/**
 * Distribute investment capital to recipient corps.
 * Called by InvestmentPlanner after creating investments.
 */
export function distributeInvestmentCapital(
  investments: InvestmentContract[]
): void {
  for (const investment of investments) {
    const budget = getCapitalBudget(investment.recipientCorpId);
    budget.addInvestmentCapital(investment);
  }
}

/**
 * Distribute sub-contract capital.
 * Called when sub-contracts are created.
 */
export function distributeSubContractCapital(
  contracts: SubContract[]
): void {
  for (const contract of contracts) {
    const budget = getCapitalBudget(contract.sellerId);
    budget.addSubContractCapital(contract);
  }
}
