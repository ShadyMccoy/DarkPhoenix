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
import { OfferCollector } from "./OfferCollector";
import { Node } from "../nodes/Node";
import { NodeNavigator } from "../nodes/NodeNavigator";

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
  /** Corp ID of the buyer (for economic edge lookups) */
  buyerCorpId?: string;
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
 * When a NodeNavigator is provided, the planner uses economic edges:
 * - Only considers corps in economically connected nodes
 * - Uses economic edge weights for distance-based pricing
 * - Ignores spatial-only nodes during trace
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

  /** Optional navigator for economic edge traversal */
  private navigator: NodeNavigator | null = null;

  /** Mapping of corp ID to node ID for economic edge lookups */
  private corpToNode: Map<string, string> = new Map();

  /** Set of node IDs that are economically connected */
  private economicNodeIds: Set<string> = new Set();

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
   * Set the node navigator for economic edge traversal.
   * When set, the planner will only traverse economic edges.
   */
  setNavigator(navigator: NodeNavigator): void {
    this.navigator = navigator;
    this.updateEconomicNodeIds();
  }

  /**
   * Update the set of economically connected node IDs.
   */
  private updateEconomicNodeIds(): void {
    this.economicNodeIds.clear();
    if (!this.navigator) return;

    // Get all nodes that have economic edges
    const economicEdges = this.navigator.getEdges("economic");
    for (const { edge } of economicEdges) {
      const [id1, id2] = edge.split("|");
      this.economicNodeIds.add(id1);
      this.economicNodeIds.add(id2);
    }
  }

  /**
   * Register corps for lookup during chain building
   */
  registerCorps(corps: Corp[]): void {
    this.corpRegistry.clear();
    this.corpToNode.clear();
    for (const corp of corps) {
      this.corpRegistry.set(corp.id, corp);
    }
  }

  /**
   * Register corps from nodes
   */
  registerNodes(nodes: Node[]): void {
    this.corpRegistry.clear();
    this.corpToNode.clear();
    for (const node of nodes) {
      for (const corp of node.corps) {
        this.corpRegistry.set(corp.id, corp);
        this.corpToNode.set(corp.id, node.id);
      }
    }
    this.updateEconomicNodeIds();
  }

  /**
   * Get the node ID for a corp.
   * Returns undefined if the corp's node is not known.
   */
  private getCorpNodeId(corpId: string): string | undefined {
    return this.corpToNode.get(corpId);
  }

  /**
   * Check if a corp is in an economically connected node.
   * Returns true if no navigator is set (backwards compatibility).
   */
  private isCorpEconomicallyConnected(corpId: string): boolean {
    if (!this.navigator) return true;

    const nodeId = this.getCorpNodeId(corpId);
    if (!nodeId) return false;

    return this.economicNodeIds.has(nodeId);
  }

  /**
   * Get the economic distance between two corps.
   * Uses economic edge weights from the navigator if available.
   * Falls back to Infinity if corps are not economically connected.
   *
   * @param fromCorpId - Source corp ID
   * @param toCorpId - Destination corp ID
   * @returns Economic distance (edge weight sum), or Infinity if not connected
   */
  private getEconomicDistance(fromCorpId: string, toCorpId: string): number {
    if (!this.navigator) {
      // No navigator - fall back to position-based distance
      const fromCorp = this.corpRegistry.get(fromCorpId);
      const toCorp = this.corpRegistry.get(toCorpId);
      if (!fromCorp || !toCorp) return Infinity;

      const fromPos = fromCorp.getPosition();
      const toPos = toCorp.getPosition();
      return Math.abs(toPos.x - fromPos.x) + Math.abs(toPos.y - fromPos.y);
    }

    const fromNodeId = this.getCorpNodeId(fromCorpId);
    const toNodeId = this.getCorpNodeId(toCorpId);

    if (!fromNodeId || !toNodeId) return Infinity;

    // Use economic edges for distance
    return this.navigator.getDistance(fromNodeId, toNodeId, "economic");
  }

  /**
   * Calculate effective price for an offer using economic edges.
   * Similar to effectivePrice but uses economic distance.
   *
   * @param offer - The sell offer
   * @param buyerCorpId - The buying corp's ID
   * @param haulingCostPerTile - Cost per tile of distance
   */
  private economicEffectivePrice(
    offer: Offer,
    buyerCorpId: string,
    haulingCostPerTile: number = 0.01
  ): number {
    const distance = this.getEconomicDistance(offer.corpId, buyerCorpId);
    if (distance === Infinity) {
      return Infinity;
    }
    return offer.price + distance * haulingCostPerTile * offer.quantity;
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
   * Find all goal corps that can mint credits.
   * When using economic edges, only considers goals from economically connected nodes.
   */
  private findGoals(): ChainGoal[] {
    const goals: ChainGoal[] = [];

    // Look for corps that sell mintable resources
    const rclOffers = this.collector.getSellOffers("rcl-progress");
    for (const offer of rclOffers) {
      const corp = this.corpRegistry.get(offer.corpId);
      if (!corp) continue;

      // When using economic edges, skip corps not in economically connected nodes
      if (!this.isCorpEconomicallyConnected(offer.corpId)) continue;

      goals.push({
        type: "rcl-progress",
        corpId: offer.corpId,
        resource: "rcl-progress",
        quantity: offer.quantity,
        position: corp.getPosition(),
        mintValuePerUnit: getMintValue(this.mintValues, "rcl_upgrade")
      });
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
          location: goal.position,
          buyerCorpId: goal.corpId
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
   * Trace an input requirement back to its source.
   * When using economic edges, only traverses economically connected nodes.
   */
  private traceInput(
    requirement: InputRequirement,
    depth: number,
    visited: string[]
  ): TraceResult {
    if (depth >= this.maxDepth) {
      return { success: false, segments: [], cost: 0 };
    }

    // Find sell offers for this resource
    // When using economic edges, filter to economically connected corps
    let sellOffers = this.collector.getCheapestSellOffers(
      requirement.resource,
      requirement.location
    );

    // Filter to economically connected corps when navigator is set
    if (this.navigator) {
      sellOffers = sellOffers.filter(offer =>
        this.isCorpEconomicallyConnected(offer.corpId)
      );
    }

    // Sort by effective price using economic edges if available
    if (this.navigator && requirement.buyerCorpId) {
      sellOffers = [...sellOffers].sort((a, b) => {
        const priceA = this.economicEffectivePrice(a, requirement.buyerCorpId!);
        const priceB = this.economicEffectivePrice(b, requirement.buyerCorpId!);
        return priceA - priceB;
      });
    }

    for (const sellOffer of sellOffers) {
      // Avoid cycles
      if (visited.includes(sellOffer.corpId)) continue;

      // Check quantity
      if (sellOffer.quantity < requirement.quantity) continue;

      const sellerCorp = this.corpRegistry.get(sellOffer.corpId);
      if (!sellerCorp) continue;

      // Calculate effective price including distance
      // Use economic edges if available, otherwise fall back to position-based
      let price: number;
      if (this.navigator && requirement.buyerCorpId) {
        price = this.economicEffectivePrice(sellOffer, requirement.buyerCorpId);
      } else {
        price = effectivePrice(sellOffer, requirement.location);
      }

      // Skip if unreachable via economic edges
      if (price === Infinity) continue;

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
            location: sellerCorp.getPosition(),
            buyerCorpId: sellOffer.corpId
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
