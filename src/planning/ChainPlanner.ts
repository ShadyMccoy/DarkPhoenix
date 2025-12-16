import { Offer, Position, effectivePrice } from "../market/Offer";
import { Corp, CorpType } from "../corps/Corp";
import { MintValues, getMintValue } from "../colony/MintValues";
import {
  Chain,
  ChainSegment,
  createChain,
  createChainId,
  buildSegment,
  sortByProfit,
  filterViable,
  selectNonOverlapping
} from "./Chain";
import { OfferCollector, Node } from "./OfferCollector";

/**
 * Goal types that can be achieved by chains.
 * Each goal type has an associated mint value.
 */
export type GoalType = "rcl-progress" | "gcl-progress" | "construction";

/**
 * A chain goal represents an achievable objective that mints credits.
 */
export interface ChainGoal {
  type: GoalType;
  corpId: string;
  resource: string;
  quantity: number;
  position: Position;
  mintValuePerUnit: number;
}

/**
 * Input requirement for building a chain segment
 */
export interface InputRequirement {
  resource: string;
  quantity: number;
  location: Position;
}

/**
 * ChainPlanner finds viable production chains by matching offers.
 *
 * The algorithm:
 * 1. Find all goal corps (upgrading, building) that mint credits
 * 2. For each goal, trace backwards through buy offers
 * 3. Match each buy offer with the cheapest sell offer
 * 4. Accumulate costs with margins at each step
 * 5. Chain is viable if total cost < mint value
 *
 * Cost-plus pricing ensures:
 * - Each corp adds its margin to input costs
 * - Wealthy corps have lower margins (competitive advantage)
 * - Prices naturally adjust based on supply/demand
 */
export class ChainPlanner {
  private collector: OfferCollector;
  private mintValues: MintValues;
  private maxDepth: number;
  private corpRegistry: Map<string, Corp> = new Map();

  constructor(
    collector: OfferCollector,
    mintValues: MintValues,
    maxDepth: number = 10
  ) {
    this.collector = collector;
    this.mintValues = mintValues;
    this.maxDepth = maxDepth;
  }

  /**
   * Register corps for lookup during chain building
   */
  registerCorps(corps: Corp[]): void {
    this.corpRegistry.clear();
    for (const corp of corps) {
      this.corpRegistry.set(corp.id, corp);
    }
  }

  /**
   * Register corps from nodes
   */
  registerNodes(nodes: Node[]): void {
    this.corpRegistry.clear();
    for (const node of nodes) {
      for (const corp of node.corps) {
        this.corpRegistry.set(corp.id, corp);
      }
    }
  }

  /**
   * Find all viable chains (profit > 0)
   */
  findViableChains(tick: number): Chain[] {
    const goals = this.findGoals();
    const chains: Chain[] = [];

    for (const goal of goals) {
      const chain = this.buildChainForGoal(goal, tick);
      if (chain) {
        chains.push(chain);
      }
    }

    return filterViable(sortByProfit(chains));
  }

  /**
   * Find best non-overlapping chains within budget
   */
  findBestChains(tick: number, budget: number): Chain[] {
    const viable = this.findViableChains(tick);
    const nonOverlapping = selectNonOverlapping(viable);

    // Filter by budget
    const affordable: Chain[] = [];
    let spent = 0;

    for (const chain of nonOverlapping) {
      if (spent + chain.totalCost <= budget) {
        affordable.push(chain);
        spent += chain.totalCost;
      }
    }

    return affordable;
  }

  /**
   * Find all goal corps that can mint credits
   */
  private findGoals(): ChainGoal[] {
    const goals: ChainGoal[] = [];

    // Look for corps that sell mintable resources
    const rclOffers = this.collector.getSellOffers("rcl-progress");
    for (const offer of rclOffers) {
      const corp = this.corpRegistry.get(offer.corpId);
      if (corp) {
        goals.push({
          type: "rcl-progress",
          corpId: offer.corpId,
          resource: "rcl-progress",
          quantity: offer.quantity,
          position: corp.getPosition(),
          mintValuePerUnit: getMintValue(this.mintValues, "rcl_upgrade")
        });
      }
    }

    return goals;
  }

  /**
   * Build a complete chain for a goal
   */
  private buildChainForGoal(goal: ChainGoal, tick: number): Chain | null {
    const goalCorp = this.corpRegistry.get(goal.corpId);
    if (!goalCorp) return null;

    // Get what the goal corp needs
    const buyOffers = goalCorp.buys();
    if (buyOffers.length === 0) return null;

    // Build chain by tracing inputs
    const segments: ChainSegment[] = [];
    let success = true;
    let totalInputCost = 0;

    for (const buyOffer of buyOffers) {
      const result = this.traceInput(
        {
          resource: buyOffer.resource,
          quantity: buyOffer.quantity,
          location: goal.position
        },
        0,
        []
      );

      if (!result.success) {
        success = false;
        break;
      }

      segments.push(...result.segments);
      totalInputCost += result.cost;
    }

    if (!success) return null;

    // Add the goal corp's segment
    const goalMargin = goalCorp.getMargin();
    segments.push(
      buildSegment(
        goal.corpId,
        goalCorp.type,
        goal.resource,
        goal.quantity,
        totalInputCost,
        goalMargin
      )
    );

    // Calculate mint value and create chain
    const mintValue = goal.mintValuePerUnit * goal.quantity;
    return createChain(createChainId(goal.corpId, tick), segments, mintValue);
  }

  /**
   * Trace an input requirement back to its source
   */
  private traceInput(
    requirement: InputRequirement,
    depth: number,
    visited: string[]
  ): TraceResult {
    if (depth >= this.maxDepth) {
      return { success: false, segments: [], cost: 0 };
    }

    // Find cheapest sell offer for this resource
    const sellOffers = this.collector.getCheapestSellOffers(
      requirement.resource,
      requirement.location
    );

    for (const sellOffer of sellOffers) {
      // Avoid cycles
      if (visited.includes(sellOffer.corpId)) continue;

      // Check quantity
      if (sellOffer.quantity < requirement.quantity) continue;

      const sellerCorp = this.corpRegistry.get(sellOffer.corpId);
      if (!sellerCorp) continue;

      // Calculate effective price including distance
      const price = effectivePrice(
        sellOffer,
        requirement.location
      );

      // What does the seller need?
      const sellerBuyOffers = sellerCorp.buys();

      if (sellerBuyOffers.length === 0) {
        // Leaf node (raw production like mining)
        const segment = buildSegment(
          sellOffer.corpId,
          sellerCorp.type,
          requirement.resource,
          requirement.quantity,
          0, // Leaf has no input cost
          sellerCorp.getMargin()
        );
        return {
          success: true,
          segments: [segment],
          cost: segment.outputPrice
        };
      }

      // Recursive: trace seller's inputs
      const childSegments: ChainSegment[] = [];
      let inputCost = 0;
      let allInputsFound = true;

      for (const buyOffer of sellerBuyOffers) {
        const result = this.traceInput(
          {
            resource: buyOffer.resource,
            quantity: buyOffer.quantity,
            location: sellerCorp.getPosition()
          },
          depth + 1,
          [...visited, sellOffer.corpId]
        );

        if (!result.success) {
          allInputsFound = false;
          break;
        }

        childSegments.push(...result.segments);
        inputCost += result.cost;
      }

      if (allInputsFound) {
        const segment = buildSegment(
          sellOffer.corpId,
          sellerCorp.type,
          requirement.resource,
          requirement.quantity,
          inputCost,
          sellerCorp.getMargin()
        );

        return {
          success: true,
          segments: [...childSegments, segment],
          cost: segment.outputPrice
        };
      }
    }

    // No valid supplier found
    return { success: false, segments: [], cost: 0 };
  }

  /**
   * Estimate the potential profit for a goal without building full chain
   */
  estimateProfit(goal: ChainGoal): number {
    // Simple estimation: mint value minus estimated input costs
    const mintValue = goal.mintValuePerUnit * goal.quantity;

    // Rough estimate of costs based on available offers
    const buyOffers = this.collector.getBuyOffers(goal.resource);
    if (buyOffers.length === 0) return mintValue;

    const avgBuyPrice = buyOffers.reduce((sum, o) => sum + o.price, 0) / buyOffers.length;
    return mintValue - avgBuyPrice;
  }
}

/**
 * Result of tracing an input requirement
 */
interface TraceResult {
  success: boolean;
  segments: ChainSegment[];
  cost: number;
}

/**
 * Pure function to check if a chain can be built for a goal
 */
export function canBuildChain(
  goalResource: string,
  collector: OfferCollector,
  maxDepth: number = 10
): boolean {
  const visited = new Set<string>();
  const queue = [goalResource];
  let depth = 0;

  while (queue.length > 0 && depth < maxDepth) {
    const resource = queue.shift()!;
    if (visited.has(resource)) continue;
    visited.add(resource);

    const sellOffers = collector.getSellOffers(resource);
    if (sellOffers.length === 0) return false;

    // Check what sellers need
    for (const offer of sellOffers) {
      const buyOffers = collector.getBuyOffers(offer.resource);
      for (const buy of buyOffers) {
        if (!visited.has(buy.resource)) {
          queue.push(buy.resource);
        }
      }
    }

    depth++;
  }

  return true;
}
