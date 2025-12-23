import { Offer, Position, effectivePrice, landedCostForCreep } from "../market/Offer";
import { Corp, CorpType, calculateMargin } from "../corps/Corp";
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
import { AnyCorpState, getCorpPosition as getStatePosition } from "../corps/CorpState";
import { project, CorpProjection } from "./projections";

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

  /** Registry of corp states for projection-based planning */
  private corpStateRegistry: Map<string, AnyCorpState> = new Map();

  /** Cache of projections computed from corp states */
  private projectionCache: Map<string, CorpProjection> = new Map();

  /** Current tick for projection computation */
  private currentTick: number = 0;

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
   * Register corps for lookup during chain building.
   *
   * If corps have a toCorpState() method (like Real*Corps), they are
   * automatically registered as CorpStates for projection-based planning.
   * Otherwise, falls back to direct Corp interface (legacy path).
   *
   * @deprecated Prefer registerCorpStates() for new code
   */
  registerCorps(corps: Corp[], tick: number = 0): void {
    this.corpRegistry.clear();
    this.corpToNode.clear();
    this.currentTick = tick;

    for (const corp of corps) {
      // Check if corp has toCorpState() method (Real*Corps)
      const corpWithState = corp as Corp & { toCorpState?: () => AnyCorpState };
      if (typeof corpWithState.toCorpState === "function") {
        // Use CorpState path for unified projection-based planning
        const state = corpWithState.toCorpState();
        this.corpStateRegistry.set(state.id, state);
        this.corpToNode.set(state.id, state.nodeId);
      } else {
        // Legacy path for test mocks and old corps
        this.corpRegistry.set(corp.id, corp);
      }
    }
  }

  /**
   * Register corps from nodes.
   *
   * If corps have a toCorpState() method (like Real*Corps), they are
   * automatically registered as CorpStates for projection-based planning.
   *
   * @deprecated Prefer registerCorpStates() for new code
   */
  registerNodes(nodes: Node[], tick: number = 0): void {
    this.corpRegistry.clear();
    this.corpStateRegistry.clear();
    this.projectionCache.clear();
    this.corpToNode.clear();
    this.currentTick = tick;

    for (const node of nodes) {
      for (const corp of node.corps) {
        // Check if corp has toCorpState() method (Real*Corps)
        const corpWithState = corp as Corp & { toCorpState?: () => AnyCorpState };
        if (typeof corpWithState.toCorpState === "function") {
          // Use CorpState path for unified projection-based planning
          const state = corpWithState.toCorpState();
          this.corpStateRegistry.set(state.id, state);
          this.corpToNode.set(state.id, state.nodeId);
        } else {
          // Legacy path for test mocks
          this.corpRegistry.set(corp.id, corp);
          this.corpToNode.set(corp.id, node.id);
        }
      }
    }
    this.updateEconomicNodeIds();
  }

  /**
   * Register corp states for the new projection-based approach.
   * When corp states are registered, the planner uses pure projection
   * functions instead of calling corp.buys()/sells().
   *
   * @param states - Array of corp states to register
   * @param tick - Current game tick for projection computation
   */
  registerCorpStates(states: AnyCorpState[], tick: number): void {
    this.corpStateRegistry.clear();
    this.projectionCache.clear();
    this.corpToNode.clear();
    this.currentTick = tick;

    for (const state of states) {
      this.corpStateRegistry.set(state.id, state);
      this.corpToNode.set(state.id, state.nodeId);
    }
    this.updateEconomicNodeIds();
  }

  // ==========================================================================
  // Helper methods for working with both Corps and CorpStates
  // ==========================================================================

  /**
   * Get projection for a corp state (cached for performance).
   */
  private getProjection(corpId: string): CorpProjection | null {
    const cached = this.projectionCache.get(corpId);
    if (cached) return cached;

    const state = this.corpStateRegistry.get(corpId);
    if (!state) return null;

    const projection = project(state, this.currentTick);
    this.projectionCache.set(corpId, projection);
    return projection;
  }

  /**
   * Get buy offers for a corp (works with both Corp and CorpState).
   */
  private getCorpBuys(corpId: string): Offer[] {
    // Try projection from CorpState
    const projection = this.getProjection(corpId);
    if (projection) return projection.buys;

    // Fall back to Corp interface
    const corp = this.corpRegistry.get(corpId);
    if (corp) return corp.buys();

    return [];
  }

  /**
   * Get position for a corp (works with both Corp and CorpState).
   */
  private getCorpPosition(corpId: string): Position | null {
    // Try CorpState
    const state = this.corpStateRegistry.get(corpId);
    if (state) return getStatePosition(state);

    // Fall back to Corp interface
    const corp = this.corpRegistry.get(corpId);
    if (corp) return corp.getPosition();

    return null;
  }

  /**
   * Get margin for a corp (works with both Corp and CorpState).
   */
  private getCorpMargin(corpId: string): number {
    // Try CorpState first
    const state = this.corpStateRegistry.get(corpId);
    if (state) return calculateMargin(state.balance);

    // Fall back to Corp
    const corp = this.corpRegistry.get(corpId);
    if (corp) return corp.getMargin();

    return 0.1; // Default margin
  }

  /**
   * Get type for a corp (works with both Corp and CorpState).
   */
  private getCorpType(corpId: string): CorpType | null {
    // Try CorpState first
    const state = this.corpStateRegistry.get(corpId);
    if (state) return state.type as CorpType;

    // Fall back to Corp
    const corp = this.corpRegistry.get(corpId);
    if (corp) return corp.type;

    return null;
  }

  /**
   * Check if a corp exists (in either registry).
   */
  private hasCorp(corpId: string): boolean {
    return this.corpRegistry.has(corpId) || this.corpStateRegistry.has(corpId);
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
      const fromPos = this.getCorpPosition(fromCorpId);
      const toPos = this.getCorpPosition(toCorpId);
      if (!fromPos || !toPos) return Infinity;

      return Math.abs(toPos.x - fromPos.x) + Math.abs(toPos.y - fromPos.y);
    }

    const fromNodeId = this.getCorpNodeId(fromCorpId);
    const toNodeId = this.getCorpNodeId(toCorpId);

    if (!fromNodeId || !toNodeId) return Infinity;

    // Use economic edges for distance
    return this.navigator.getDistance(fromNodeId, toNodeId, "economic");
  }

  /** Set of creep delivery resources that use travel time penalty */
  private static readonly CREEP_DELIVERY_RESOURCES = new Set(["spawn-capacity"]);

  /** Default creep lifetime for landed cost calculations */
  private static readonly CREEP_LIFETIME = 1500;

  /**
   * Calculate effective price for an offer using economic edges.
   * Similar to effectivePrice but uses economic distance.
   *
   * Handles three categories of resources:
   * 1. Creep delivery resources (spawn-capacity) - travel time penalty
   * 2. Physical resources (energy) - hauling cost penalty
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

    // Creep delivery resources use travel time penalty instead of hauling cost
    if (ChainPlanner.CREEP_DELIVERY_RESOURCES.has(offer.resource)) {
      const effectiveWorkTime = Math.max(1, ChainPlanner.CREEP_LIFETIME - distance);
      const multiplier = ChainPlanner.CREEP_LIFETIME / effectiveWorkTime;
      return offer.price * multiplier;
    }

    // Physical resources use hauling cost
    return offer.price + distance * haulingCostPerTile * offer.quantity;
  }

  /**
   * Find all viable chains (profit > 0) by iteratively building and consuming offers.
   *
   * Algorithm:
   * 1. Find all goals that can mint credits
   * 2. For each goal, try to build a chain with current offer capacity
   * 3. Collect all built chains and sort by profit
   * 4. Take the best chain and consume its matched offers
   * 5. Repeat from step 2 until no more chains can be built
   *
   * This allows multiple chains to share the same goal (e.g., multiple mining
   * chains feeding the same upgrader) by progressively consuming offer capacity.
   */
  findViableChains(tick: number): Chain[] {
    const allChains: Chain[] = [];
    const maxIterations = 100; // Safety limit

    for (let i = 0; i < maxIterations; i++) {
      // Find all goals and try to build chains
      const goals = this.findGoals();
      const candidateChains: Array<{ chain: Chain; consumedOffers: ConsumedOffer[] }> = [];

      for (const goal of goals) {
        const result = this.buildChainWithTracking(goal, tick);
        if (result) {
          candidateChains.push(result);
        }
      }

      // No more viable chains
      if (candidateChains.length === 0) {
        break;
      }

      // Sort by profit and take the best
      candidateChains.sort((a, b) => b.chain.profit - a.chain.profit);
      const best = candidateChains[0];

      // Only add if profitable
      if (best.chain.profit <= 0) {
        break;
      }

      allChains.push(best.chain);

      // Consume the matched offers so they can't be used again
      for (const consumed of best.consumedOffers) {
        this.collector.consumeOffer(consumed.offerId, consumed.quantity);
      }
    }

    return sortByProfit(allChains);
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
      // Check corp exists in either registry
      if (!this.hasCorp(offer.corpId)) continue;

      // When using economic edges, skip corps not in economically connected nodes
      if (!this.isCorpEconomicallyConnected(offer.corpId)) continue;

      const position = this.getCorpPosition(offer.corpId);
      if (!position) continue;

      goals.push({
        type: "rcl-progress",
        corpId: offer.corpId,
        resource: "rcl-progress",
        quantity: offer.quantity,
        position,
        mintValuePerUnit: getMintValue(this.mintValues, "rcl_upgrade")
      });
    }

    return goals;
  }

  /**
   * Build a complete chain for a goal
   */
  private buildChainForGoal(goal: ChainGoal, tick: number): Chain | null {
    // Check corp exists in either registry
    if (!this.hasCorp(goal.corpId)) return null;

    // Get what the goal corp needs
    const buyOffers = this.getCorpBuys(goal.corpId);
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
    const goalMargin = this.getCorpMargin(goal.corpId);
    const goalType = this.getCorpType(goal.corpId);
    if (!goalType) return null;

    segments.push(
      buildSegment(
        goal.corpId,
        goalType,
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
   * Build a chain for a goal and track which offers are consumed.
   * Used by iterative chain building to know what to subtract.
   */
  private buildChainWithTracking(
    goal: ChainGoal,
    tick: number
  ): { chain: Chain; consumedOffers: ConsumedOffer[] } | null {
    // Check corp exists in either registry
    if (!this.hasCorp(goal.corpId)) return null;

    // Get what the goal corp needs
    const buyOffers = this.getCorpBuys(goal.corpId);
    if (buyOffers.length === 0) return null;

    // Build chain by tracing inputs
    const segments: ChainSegment[] = [];
    const allConsumed: ConsumedOffer[] = [];
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
      allConsumed.push(...result.consumedOffers);
      totalInputCost += result.cost;
    }

    if (!success) return null;

    // Calculate actual throughput from consumed offers
    // For RCL progress, throughput = delivered-energy consumed
    const deliveredEnergyConsumed = allConsumed
      .filter(c => c.resource === "delivered-energy")
      .reduce((sum, c) => sum + c.quantity, 0);

    // If no delivered-energy (shouldn't happen for upgrading), use goal quantity
    const actualThroughput = deliveredEnergyConsumed > 0 ? deliveredEnergyConsumed : goal.quantity;

    // Add the goal corp's segment with actual throughput
    const goalMargin = this.getCorpMargin(goal.corpId);
    const goalType = this.getCorpType(goal.corpId);
    if (!goalType) return null;

    segments.push(
      buildSegment(
        goal.corpId,
        goalType,
        goal.resource,
        actualThroughput, // Use actual throughput, not demand
        totalInputCost,
        goalMargin
      )
    );

    // Calculate mint value based on ACTUAL throughput, not demand
    const mintValue = goal.mintValuePerUnit * actualThroughput;
    const chain = createChain(createChainId(goal.corpId, tick), segments, mintValue);

    return { chain, consumedOffers: allConsumed };
  }

  /**
   * Trace an input requirement back to its source.
   * When using economic edges, only traverses economically connected nodes.
   * Tracks all consumed offers for iterative chain building.
   */
  private traceInput(
    requirement: InputRequirement,
    depth: number,
    visited: string[]
  ): TraceResult {
    if (depth >= this.maxDepth) {
      return { success: false, segments: [], cost: 0, consumedOffers: [] };
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

      // Skip if no quantity available
      if (sellOffer.quantity <= 0) continue;

      // Check corp exists in either registry
      if (!this.hasCorp(sellOffer.corpId)) continue;

      // Use partial fulfillment - take what's available
      // This allows spawn to provide smaller creeps than requested
      const fulfilledQuantity = Math.min(sellOffer.quantity, requirement.quantity);

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
      const sellerBuyOffers = this.getCorpBuys(sellOffer.corpId);
      const sellerType = this.getCorpType(sellOffer.corpId);
      const sellerMargin = this.getCorpMargin(sellOffer.corpId);
      const sellerPosition = this.getCorpPosition(sellOffer.corpId);

      if (!sellerType || !sellerPosition) continue;

      // Track this offer as consumed
      const thisConsumed: ConsumedOffer = {
        offerId: sellOffer.id,
        corpId: sellOffer.corpId,
        resource: sellOffer.resource,
        quantity: fulfilledQuantity
      };

      // Spawning corps are "origin" nodes - they sell spawn-capacity without
      // needing their buys fulfilled. Their delivered-energy buy is for extensions
      // refill but doesn't block spawn-capacity sales.
      const isOriginCorp = sellerType === "spawning";

      if (sellerBuyOffers.length === 0 || isOriginCorp) {
        // Leaf/origin node (raw production like spawning)
        const segment = buildSegment(
          sellOffer.corpId,
          sellerType,
          requirement.resource,
          fulfilledQuantity,
          0, // Origin has no input cost for this chain
          sellerMargin
        );
        return {
          success: true,
          segments: [segment],
          cost: segment.outputPrice,
          consumedOffers: [thisConsumed]
        };
      }

      // Recursive: trace seller's inputs
      const childSegments: ChainSegment[] = [];
      const childConsumed: ConsumedOffer[] = [];
      let inputCost = 0;
      let allInputsFound = true;

      for (const buyOffer of sellerBuyOffers) {
        const result = this.traceInput(
          {
            resource: buyOffer.resource,
            quantity: buyOffer.quantity,
            location: sellerPosition,
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
        childConsumed.push(...result.consumedOffers);
        inputCost += result.cost;
      }

      if (allInputsFound) {
        const segment = buildSegment(
          sellOffer.corpId,
          sellerType,
          requirement.resource,
          fulfilledQuantity,
          inputCost,
          sellerMargin
        );

        return {
          success: true,
          segments: [...childSegments, segment],
          cost: segment.outputPrice,
          consumedOffers: [...childConsumed, thisConsumed]
        };
      }
    }

    // No valid supplier found
    return { success: false, segments: [], cost: 0, consumedOffers: [] };
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
  /** Offers consumed by this trace (for iterative chain building) */
  consumedOffers: ConsumedOffer[];
}

/**
 * Record of an offer that was consumed during chain building
 */
interface ConsumedOffer {
  offerId: string;
  corpId: string;
  resource: string;
  quantity: number;
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
