/**
 * @fileoverview InvestmentPlanner - Forward capital flow planning.
 *
 * This planner implements the BankCorp model where capital flows forward
 * from investment to production, rather than tracing backwards from demand.
 *
 * Planning Flow:
 * 1. Survey: Bank identifies investment opportunities (goals)
 * 2. Allocate: Bank creates investment contracts with budget
 * 3. Cascade: Corps with capital contract suppliers
 * 4. Execute: Work is performed, money flows to workers
 *
 * @module planning/InvestmentPlanner
 */

import { Position } from "../market/Offer";
import { AnyCorpState, getCorpPosition as getStatePosition } from "../corps/CorpState";
import { calculateMargin } from "../corps/Corp";
import { getMintValue, MintValues } from "../colony/MintValues";
import { project, CorpProjection } from "./projections";
import {
  InvestmentContract,
  InvestmentOpportunity,
  InvestmentGoalType,
  CapitalAllocation,
  SubContract,
  InvestmentPerformance,
  createInvestmentContract,
  createCapitalAllocation,
  commitCapital,
  createSubContract,
  remainingBudget,
  isInvestmentActive,
  suggestInvestmentRate
} from "../market/InvestmentContract";

/**
 * Supply chain segment representing one step in the capital cascade.
 */
export interface CapitalChainSegment {
  /** Corp ID */
  corpId: string;

  /** Corp type */
  corpType: string;

  /** Resource produced */
  resource: string;

  /** Quantity contracted */
  quantity: number;

  /** Capital received (from buyer) */
  capitalReceived: number;

  /** Capital spent (to suppliers) */
  capitalSpent: number;

  /** Margin earned */
  marginEarned: number;
}

/**
 * Complete capital chain from investment to raw production.
 */
export interface CapitalChain {
  /** Unique chain ID */
  id: string;

  /** Investment contract that funds this chain */
  investmentId: string;

  /** Segments from goal corp down to source */
  segments: CapitalChainSegment[];

  /** Total capital allocated */
  totalCapital: number;

  /** Expected output */
  expectedOutput: number;

  /** Expected mint value */
  expectedMintValue: number;

  /** Expected ROI */
  expectedROI: number;
}

/**
 * Investment portfolio - all current investments and their performance.
 */
export interface InvestmentPortfolio {
  /** Active investment contracts */
  activeInvestments: InvestmentContract[];

  /** Capital chains being executed */
  activeChains: CapitalChain[];

  /** Historical performance by goal type */
  performanceByGoalType: Map<InvestmentGoalType, InvestmentPerformance[]>;

  /** Total capital deployed */
  totalDeployed: number;

  /** Total returns (mint value) */
  totalReturns: number;

  /** Portfolio ROI */
  portfolioROI: number;
}

/**
 * Result of the investment planning phase.
 */
export interface InvestmentPlanResult {
  /** Investment contracts created */
  investments: InvestmentContract[];

  /** Capital chains built */
  chains: CapitalChain[];

  /** Sub-contracts created for the supply chain */
  subContracts: SubContract[];

  /** Total budget allocated */
  totalBudget: number;

  /** Unallocated budget (if any) */
  remainingBudget: number;
}

/**
 * InvestmentPlanner implements forward capital flow.
 *
 * Instead of tracing backwards from unlimited demand, this planner:
 * 1. Takes a budget from the treasury
 * 2. Identifies goal corps (upgraders, builders)
 * 3. Creates investment contracts allocating capital to goals
 * 4. Each goal corp then has capital to contract suppliers
 * 5. Capital cascades down the supply chain
 */
export class InvestmentPlanner {
  /** Registered corp states */
  private corpStates: Map<string, AnyCorpState> = new Map();

  /** Cached projections */
  private projectionCache: Map<string, CorpProjection> = new Map();

  /** Mint values for calculating ROI */
  private mintValues: MintValues;

  /** Current tick */
  private currentTick: number = 0;

  /** Historical performance for ROI optimization */
  private performanceHistory: InvestmentPerformance[] = [];

  /** Active investment contracts */
  private activeInvestments: InvestmentContract[] = [];

  /** Active sub-contracts */
  private activeSubContracts: SubContract[] = [];

  constructor(mintValues: MintValues) {
    this.mintValues = mintValues;
  }

  /**
   * Register corp states for planning.
   */
  registerCorpStates(states: AnyCorpState[], tick: number): void {
    this.corpStates.clear();
    this.projectionCache.clear();
    this.currentTick = tick;

    for (const state of states) {
      this.corpStates.set(state.id, state);
    }
  }

  /**
   * Get projection for a corp (cached).
   */
  private getProjection(corpId: string): CorpProjection | null {
    const cached = this.projectionCache.get(corpId);
    if (cached) return cached;

    const state = this.corpStates.get(corpId);
    if (!state) return null;

    const projection = project(state, this.currentTick);
    this.projectionCache.set(corpId, projection);
    return projection;
  }

  /**
   * Main planning entry point: allocate budget to investments.
   *
   * @param budget - Total credits available for investment
   * @param tick - Current game tick
   * @returns Investment plan with contracts and chains
   */
  plan(budget: number, tick: number): InvestmentPlanResult {
    this.currentTick = tick;

    // Clean up expired investments and contracts
    this.pruneExpired(tick);

    // 1. Find investment opportunities (goal corps)
    const opportunities = this.findOpportunities();

    // 2. Rank opportunities by expected ROI
    const rankedOpportunities = this.rankByROI(opportunities);

    // 3. Allocate budget to opportunities
    const { investments, remainingBudget: budgetLeft } = this.allocateBudget(
      rankedOpportunities,
      budget,
      tick
    );

    // 4. Build capital chains for each investment
    const chains: CapitalChain[] = [];
    const subContracts: SubContract[] = [];

    for (const investment of investments) {
      const chainResult = this.buildCapitalChain(investment, tick);
      if (chainResult) {
        chains.push(chainResult.chain);
        subContracts.push(...chainResult.subContracts);
      }
    }

    // Store active investments
    this.activeInvestments.push(...investments);
    this.activeSubContracts.push(...subContracts);

    return {
      investments,
      chains,
      subContracts,
      totalBudget: budget - budgetLeft,
      remainingBudget: budgetLeft
    };
  }

  /**
   * Find investment opportunities (goal corps that mint value).
   */
  private findOpportunities(): InvestmentOpportunity[] {
    const opportunities: InvestmentOpportunity[] = [];

    for (const [corpId, state] of this.corpStates) {
      // Only upgrading and building corps are investment targets
      if (state.type !== "upgrading" && state.type !== "building") {
        continue;
      }

      const projection = this.getProjection(corpId);
      if (!projection) continue;

      // Find sell offers for mintable resources
      for (const offer of projection.sells) {
        const goalType = this.resourceToGoalType(offer.resource);
        if (!goalType) continue;

        const position = getStatePosition(state);
        if (!position) continue;

        // Estimate supply chain cost
        const supplyChainCost = this.estimateSupplyChainCost(corpId);
        const mintValuePerUnit = this.getMintValueForResource(offer.resource);

        // Calculate historical or estimated ROI
        const historicalROI = this.getHistoricalROI(corpId, goalType);

        opportunities.push({
          corpId,
          goalType,
          position,
          maxThroughput: offer.quantity,
          historicalROI,
          suggestedRate: suggestInvestmentRate(mintValuePerUnit, supplyChainCost),
          suggestedBudget: offer.quantity * suggestInvestmentRate(mintValuePerUnit, supplyChainCost),
          supplyChainDepth: this.estimateSupplyChainDepth(corpId)
        });
      }
    }

    return opportunities;
  }

  /**
   * Convert resource type to goal type.
   */
  private resourceToGoalType(resource: string): InvestmentGoalType | null {
    switch (resource) {
      case "rcl-progress":
        return "rcl-progress";
      case "gcl-progress":
        return "gcl-progress";
      case "construction-progress":
        return "construction";
      default:
        return null;
    }
  }

  /**
   * Get mint value for a resource type.
   */
  private getMintValueForResource(resource: string): number {
    switch (resource) {
      case "rcl-progress":
        return getMintValue(this.mintValues, "rcl_upgrade");
      case "gcl-progress":
        return getMintValue(this.mintValues, "gcl_upgrade");
      default:
        return 0;
    }
  }

  /**
   * Get historical ROI for a corp/goal type combination.
   */
  private getHistoricalROI(corpId: string, goalType: InvestmentGoalType): number {
    const history = this.performanceHistory.filter(
      p => p.recipientCorpId === corpId && p.goalType === goalType
    );

    if (history.length === 0) {
      // No history - use default estimate
      return 0.2; // 20% expected ROI
    }

    // Weight recent performance more heavily
    let weightedROI = 0;
    let totalWeight = 0;
    for (let i = 0; i < history.length; i++) {
      const weight = i + 1; // More recent = higher weight
      weightedROI += history[i].roi * weight;
      totalWeight += weight;
    }

    return weightedROI / totalWeight;
  }

  /**
   * Estimate supply chain cost for a goal corp.
   * Traces what the corp needs and sums supplier prices.
   */
  private estimateSupplyChainCost(goalCorpId: string): number {
    const projection = this.getProjection(goalCorpId);
    if (!projection) return Infinity;

    let totalCost = 0;

    for (const buyOffer of projection.buys) {
      // Find cheapest supplier for this resource
      const supplierCost = this.findCheapestSupplier(buyOffer.resource, buyOffer.quantity);
      totalCost += supplierCost;
    }

    return totalCost;
  }

  /**
   * Find cheapest supplier for a resource.
   */
  private findCheapestSupplier(resource: string, quantity: number): number {
    let cheapestCost = Infinity;

    for (const [corpId, state] of this.corpStates) {
      const projection = this.getProjection(corpId);
      if (!projection) continue;

      for (const offer of projection.sells) {
        if (offer.resource !== resource) continue;
        if (offer.quantity < quantity) continue;

        const pricePerUnit = offer.price / offer.quantity;
        const totalCost = pricePerUnit * quantity;

        if (totalCost < cheapestCost) {
          cheapestCost = totalCost;
        }
      }
    }

    return cheapestCost === Infinity ? quantity : cheapestCost;
  }

  /**
   * Estimate supply chain depth for prioritization.
   */
  private estimateSupplyChainDepth(goalCorpId: string): number {
    const visited = new Set<string>();
    return this.traceDepth(goalCorpId, visited);
  }

  private traceDepth(corpId: string, visited: Set<string>): number {
    if (visited.has(corpId)) return 0;
    visited.add(corpId);

    const projection = this.getProjection(corpId);
    if (!projection || projection.buys.length === 0) {
      return 1; // Leaf node
    }

    let maxChildDepth = 0;
    for (const buyOffer of projection.buys) {
      // Find a supplier and trace their depth
      for (const [supplierId, _] of this.corpStates) {
        const supplierProjection = this.getProjection(supplierId);
        if (!supplierProjection) continue;

        const hasResource = supplierProjection.sells.some(
          s => s.resource === buyOffer.resource
        );
        if (hasResource) {
          const childDepth = this.traceDepth(supplierId, visited);
          maxChildDepth = Math.max(maxChildDepth, childDepth);
        }
      }
    }

    return 1 + maxChildDepth;
  }

  /**
   * Rank opportunities by expected ROI.
   */
  private rankByROI(opportunities: InvestmentOpportunity[]): InvestmentOpportunity[] {
    return [...opportunities].sort((a, b) => b.historicalROI - a.historicalROI);
  }

  /**
   * Allocate budget to opportunities.
   */
  private allocateBudget(
    opportunities: InvestmentOpportunity[],
    budget: number,
    tick: number
  ): { investments: InvestmentContract[]; remainingBudget: number } {
    const investments: InvestmentContract[] = [];
    let remaining = budget;

    for (const opportunity of opportunities) {
      if (remaining <= 0) break;

      // Allocate up to suggested budget or remaining, whichever is smaller
      const allocation = Math.min(opportunity.suggestedBudget, remaining);

      if (allocation < 100) {
        // Minimum investment threshold
        continue;
      }

      const investment = createInvestmentContract(
        "bank", // Bank ID
        opportunity.corpId,
        opportunity.goalType,
        this.goalTypeToResource(opportunity.goalType),
        opportunity.suggestedRate,
        allocation,
        1500, // One creep lifetime
        tick,
        1, // Priority
        opportunity.historicalROI
      );

      investments.push(investment);
      remaining -= allocation;
    }

    return { investments, remainingBudget: remaining };
  }

  /**
   * Convert goal type to resource.
   */
  private goalTypeToResource(goalType: InvestmentGoalType): string {
    switch (goalType) {
      case "rcl-progress":
        return "rcl-progress";
      case "gcl-progress":
        return "gcl-progress";
      case "construction":
        return "construction-progress";
      case "defense":
        return "defense-value";
    }
  }

  /**
   * Build a capital chain for an investment.
   * This cascades capital down through the supply chain.
   */
  private buildCapitalChain(
    investment: InvestmentContract,
    tick: number
  ): { chain: CapitalChain; subContracts: SubContract[] } | null {
    const recipientState = this.corpStates.get(investment.recipientCorpId);
    if (!recipientState) return null;

    const segments: CapitalChainSegment[] = [];
    const subContracts: SubContract[] = [];

    // Create capital allocation for the recipient
    const allocation = createCapitalAllocation(investment.recipientCorpId, [investment]);

    // Build the chain recursively
    const result = this.cascadeCapital(
      investment.recipientCorpId,
      allocation,
      investment.id,
      tick,
      new Set<string>()
    );

    if (!result.success) return null;

    segments.push(...result.segments);
    subContracts.push(...result.subContracts);

    // Calculate expected output and ROI
    const expectedOutput = investment.maxBudget / investment.ratePerUnit;
    const mintValuePerUnit = this.getMintValueForResource(investment.resource);
    const expectedMintValue = expectedOutput * mintValuePerUnit;
    const expectedROI = investment.maxBudget > 0
      ? (expectedMintValue - investment.maxBudget) / investment.maxBudget
      : 0;

    const chain: CapitalChain = {
      id: `chain-${investment.id}`,
      investmentId: investment.id,
      segments,
      totalCapital: investment.maxBudget,
      expectedOutput,
      expectedMintValue,
      expectedROI
    };

    return { chain, subContracts };
  }

  /**
   * Cascade capital down through suppliers.
   */
  private cascadeCapital(
    corpId: string,
    allocation: CapitalAllocation,
    investmentId: string,
    tick: number,
    visited: Set<string>
  ): {
    success: boolean;
    segments: CapitalChainSegment[];
    subContracts: SubContract[];
  } {
    if (visited.has(corpId)) {
      return { success: false, segments: [], subContracts: [] };
    }
    visited.add(corpId);

    const state = this.corpStates.get(corpId);
    if (!state) {
      return { success: false, segments: [], subContracts: [] };
    }

    const projection = this.getProjection(corpId);
    if (!projection) {
      return { success: false, segments: [], subContracts: [] };
    }

    const segments: CapitalChainSegment[] = [];
    const subContracts: SubContract[] = [];

    // Calculate how much capital this corp needs for its suppliers
    let capitalSpent = 0;

    for (const buyOffer of projection.buys) {
      // Find a supplier
      const supplier = this.findBestSupplier(buyOffer.resource, buyOffer.quantity);
      if (!supplier) continue;

      // Check if we have enough capital
      if (!commitCapital(allocation, supplier.cost)) {
        // Not enough capital - scale down
        const scaleFactor = allocation.availableCapital / supplier.cost;
        if (scaleFactor < 0.1) continue; // Too little to be useful

        supplier.quantity *= scaleFactor;
        supplier.cost *= scaleFactor;
        commitCapital(allocation, supplier.cost);
      }

      // Create sub-contract
      const subContract = createSubContract(
        corpId,
        supplier.corpId,
        buyOffer.resource,
        supplier.quantity,
        supplier.cost,
        1500,
        tick,
        investmentId
      );
      subContracts.push(subContract);

      // Create allocation for supplier
      const supplierAllocation = createCapitalAllocation(supplier.corpId, []);
      supplierAllocation.totalCapital = supplier.cost;
      supplierAllocation.availableCapital = supplier.cost;

      // Recurse to supplier
      const supplierResult = this.cascadeCapital(
        supplier.corpId,
        supplierAllocation,
        investmentId,
        tick,
        visited
      );

      if (supplierResult.success) {
        segments.push(...supplierResult.segments);
        subContracts.push(...supplierResult.subContracts);
      }

      capitalSpent += supplier.cost;
    }

    // Add segment for this corp
    const margin = calculateMargin(state.balance);
    const capitalReceived = allocation.totalCapital;
    const marginEarned = capitalReceived - capitalSpent;

    // Determine output resource from sells
    const sellResource = projection.sells.length > 0
      ? projection.sells[0].resource
      : "unknown";
    const quantity = projection.sells.length > 0
      ? projection.sells[0].quantity
      : 0;

    segments.push({
      corpId,
      corpType: state.type,
      resource: sellResource,
      quantity,
      capitalReceived,
      capitalSpent,
      marginEarned
    });

    return { success: true, segments, subContracts };
  }

  /**
   * Find best supplier for a resource.
   */
  private findBestSupplier(
    resource: string,
    quantity: number
  ): { corpId: string; quantity: number; cost: number } | null {
    let best: { corpId: string; quantity: number; cost: number } | null = null;
    let bestPricePerUnit = Infinity;

    for (const [corpId, _] of this.corpStates) {
      const projection = this.getProjection(corpId);
      if (!projection) continue;

      for (const offer of projection.sells) {
        if (offer.resource !== resource) continue;

        const pricePerUnit = offer.quantity > 0 ? offer.price / offer.quantity : Infinity;
        if (pricePerUnit < bestPricePerUnit) {
          bestPricePerUnit = pricePerUnit;
          const availableQty = Math.min(offer.quantity, quantity);
          best = {
            corpId,
            quantity: availableQty,
            cost: pricePerUnit * availableQty
          };
        }
      }
    }

    return best;
  }

  /**
   * Prune expired investments and contracts.
   */
  private pruneExpired(tick: number): void {
    this.activeInvestments = this.activeInvestments.filter(
      i => isInvestmentActive(i, tick)
    );

    this.activeSubContracts = this.activeSubContracts.filter(
      c => tick < c.startTick + c.duration
    );
  }

  /**
   * Record delivery on an investment (called when work is done).
   */
  recordDelivery(investmentId: string, units: number): number {
    const investment = this.activeInvestments.find(i => i.id === investmentId);
    if (!investment) return 0;

    const remaining = remainingBudget(investment);
    const payment = Math.min(units * investment.ratePerUnit, remaining);

    investment.unitsDelivered += units;
    investment.creditsPaid += payment;

    return payment;
  }

  /**
   * Get active investments.
   */
  getActiveInvestments(): InvestmentContract[] {
    return [...this.activeInvestments];
  }

  /**
   * Get active sub-contracts.
   */
  getActiveSubContracts(): SubContract[] {
    return [...this.activeSubContracts];
  }

  /**
   * Get investment by recipient corp ID.
   */
  getInvestmentForCorp(corpId: string): InvestmentContract | undefined {
    return this.activeInvestments.find(
      i => i.recipientCorpId === corpId && remainingBudget(i) > 0
    );
  }

  /**
   * Get capital available to a corp from active investments.
   */
  getAvailableCapital(corpId: string): number {
    const investment = this.getInvestmentForCorp(corpId);
    if (!investment) return 0;
    return remainingBudget(investment);
  }

  /**
   * Record performance for ROI tracking.
   */
  recordPerformance(performance: InvestmentPerformance): void {
    this.performanceHistory.push(performance);

    // Keep history bounded
    if (this.performanceHistory.length > 100) {
      this.performanceHistory.shift();
    }
  }

  /**
   * Get portfolio summary.
   */
  getPortfolioSummary(): {
    totalDeployed: number;
    totalReturns: number;
    activeInvestments: number;
    averageROI: number;
  } {
    const totalDeployed = this.activeInvestments.reduce(
      (sum, i) => sum + i.creditsPaid,
      0
    );

    const totalReturns = this.activeInvestments.reduce((sum, i) => {
      const mintValue = this.getMintValueForResource(i.resource);
      return sum + i.unitsDelivered * mintValue;
    }, 0);

    const averageROI = totalDeployed > 0
      ? (totalReturns - totalDeployed) / totalDeployed
      : 0;

    return {
      totalDeployed,
      totalReturns,
      activeInvestments: this.activeInvestments.length,
      averageROI
    };
  }
}

/**
 * Create an investment planner instance.
 */
export function createInvestmentPlanner(mintValues: MintValues): InvestmentPlanner {
  return new InvestmentPlanner(mintValues);
}
