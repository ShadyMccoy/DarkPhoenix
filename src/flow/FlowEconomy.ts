/**
 * FlowEconomy - Main Economy Coordinator
 *
 * Central coordinator that replaces the Market system.
 * Manages the flow network, solves allocations, and provides
 * queries for creep behavior.
 *
 * Usage:
 * ```typescript
 * const economy = new FlowEconomy(nodes, navigator);
 * economy.update(context);  // Call each tick or on state change
 *
 * // Query allocations
 * const miners = economy.getMinerAssignments();
 * const haulers = economy.getHaulerAssignmentsForNode(nodeId);
 * const upgradeRate = economy.getSinkAllocation("controller-xxx");
 * ```
 */

import { Node } from "../nodes/Node";
import { NodeNavigator } from "../nodes/NodeNavigator";
import { FlowGraph, createFlowGraph } from "./FlowGraph";
import { FlowSolver, solveIteratively, printSolutionSummary } from "./FlowSolver";
import { PriorityManager, PRIORITY_PRESETS } from "./PriorityManager";
import {
  FlowSolution,
  FlowConstraints,
  PriorityContext,
  MinerAssignment,
  HaulerAssignment,
  SinkAllocation,
  SinkType,
  DEFAULT_CONSTRAINTS,
  Position,
} from "./FlowTypes";

// =============================================================================
// FLOW ECONOMY CLASS
// =============================================================================

/**
 * FlowEconomy is the main entry point for the flow-based economy system.
 *
 * It replaces the Market by:
 * - Building a flow graph from spatial nodes
 * - Calculating dynamic priorities based on game state
 * - Solving optimal energy allocation
 * - Providing query interface for creep behaviors
 */
export class FlowEconomy {
  /** Flow graph built from nodes */
  private graph: FlowGraph;

  /** Flow solver instance */
  private solver: FlowSolver;

  /** Priority manager instance */
  private priorityManager: PriorityManager;

  /** Current solution (null if not yet solved) */
  private solution: FlowSolution | null;

  /** Current priority context */
  private context: PriorityContext | null;

  /** Node navigator reference */
  private navigator: NodeNavigator;

  /** All nodes indexed by ID */
  private nodes: Map<string, Node>;

  /** Custom constraints */
  private constraints: FlowConstraints;

  /** Last tick when economy was updated */
  private lastUpdateTick: number;

  /** Minimum ticks between full re-solves */
  private updateInterval: number;

  /**
   * Create a new FlowEconomy.
   *
   * @param nodes - Array of territory nodes
   * @param navigator - Node navigator for pathfinding
   * @param constraints - Optional constraint overrides
   */
  constructor(
    nodes: Node[],
    navigator: NodeNavigator,
    constraints?: Partial<FlowConstraints>
  ) {
    this.nodes = new Map();
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }

    this.navigator = navigator;
    this.graph = createFlowGraph(nodes, navigator);
    this.solver = new FlowSolver();
    this.priorityManager = new PriorityManager();
    this.solution = null;
    this.context = null;
    this.constraints = { ...DEFAULT_CONSTRAINTS, ...constraints };
    this.lastUpdateTick = 0;
    this.updateInterval = 10; // Re-solve every 10 ticks by default
  }

  // ===========================================================================
  // UPDATE CYCLE
  // ===========================================================================

  /**
   * Update the economy state.
   * Call this each tick or when game state changes significantly.
   *
   * @param context - Current game state context
   * @param force - Force re-solve even if within update interval
   */
  update(context: PriorityContext, force: boolean = false): void {
    this.context = context;

    // Check if we should re-solve
    const shouldSolve = force ||
      !this.solution ||
      context.tick - this.lastUpdateTick >= this.updateInterval ||
      this.hasSignificantChange(context);

    if (shouldSolve) {
      this.solve();
      this.lastUpdateTick = context.tick;
    }
  }

  /**
   * Force a re-solve of the economy.
   */
  solve(): void {
    if (!this.context) {
      this.context = PriorityManager.createMockContext();
    }

    // Update priorities based on context
    this.graph.updatePriorities(this.context);

    // Get flow problem and solve
    const problem = this.graph.getFlowProblem(this.constraints);

    // Use iterative solver for better convergence
    this.solution = solveIteratively(problem);
  }

  /**
   * Check if context has changed significantly since last solve.
   */
  private hasSignificantChange(context: PriorityContext): boolean {
    if (!this.context) return true;

    // Check for state changes that require re-solve
    return (
      context.underAttack !== this.context.underAttack ||
      context.constructionSites !== this.context.constructionSites ||
      Math.abs(context.hostileCreeps - this.context.hostileCreeps) > 0
    );
  }

  // ===========================================================================
  // QUERY: MINER ASSIGNMENTS
  // ===========================================================================

  /**
   * Get all miner assignments.
   */
  getMinerAssignments(): MinerAssignment[] {
    return this.solution?.miners ?? [];
  }

  /**
   * Get miner assignment for a specific source.
   */
  getMinerAssignment(sourceId: string): MinerAssignment | null {
    return this.solution?.miners.find(m => m.sourceId === sourceId) ?? null;
  }

  /**
   * Get miner assignments for a node.
   */
  getMinerAssignmentsForNode(nodeId: string): MinerAssignment[] {
    return this.solution?.miners.filter(m => m.nodeId === nodeId) ?? [];
  }

  // ===========================================================================
  // QUERY: HAULER ASSIGNMENTS
  // ===========================================================================

  /**
   * Get all hauler assignments.
   */
  getHaulerAssignments(): HaulerAssignment[] {
    return this.solution?.haulers ?? [];
  }

  /**
   * Get hauler assignments originating from a source.
   */
  getHaulerAssignmentsFromSource(sourceId: string): HaulerAssignment[] {
    return this.solution?.haulers.filter(h => h.fromId === sourceId) ?? [];
  }

  /**
   * Get hauler assignments to a sink.
   */
  getHaulerAssignmentsToSink(sinkId: string): HaulerAssignment[] {
    return this.solution?.haulers.filter(h => h.toId === sinkId) ?? [];
  }

  /**
   * Get total CARRY parts needed for a node.
   */
  getCarryPartsForNode(nodeId: string): number {
    const node = this.nodes.get(nodeId);
    if (!node) return 0;

    // Sum CARRY parts for all haulers originating from sources in this node
    let total = 0;
    for (const hauler of this.solution?.haulers ?? []) {
      const sourceId = hauler.fromId;
      const source = this.graph.getSource(sourceId);
      if (source && source.nodeId === nodeId) {
        total += hauler.carryParts;
      }
    }

    return total;
  }

  // ===========================================================================
  // QUERY: SINK ALLOCATIONS
  // ===========================================================================

  /**
   * Get all sink allocations.
   */
  getSinkAllocations(): SinkAllocation[] {
    return this.solution?.sinkAllocations ?? [];
  }

  /**
   * Get allocation for a specific sink.
   */
  getSinkAllocation(sinkId: string): SinkAllocation | null {
    return this.solution?.sinkAllocations.find(a => a.sinkId === sinkId) ?? null;
  }

  /**
   * Get allocations for a sink type.
   */
  getSinkAllocationsByType(type: SinkType): SinkAllocation[] {
    return this.solution?.sinkAllocations.filter(a => a.sinkType === type) ?? [];
  }

  /**
   * Get total energy allocated to a sink type.
   */
  getTotalAllocationForType(type: SinkType): number {
    return this.getSinkAllocationsByType(type)
      .reduce((sum, a) => sum + a.allocated, 0);
  }

  /**
   * Get upgrade rate (energy to controller).
   */
  getUpgradeRate(): number {
    return this.getTotalAllocationForType("controller");
  }

  /**
   * Get build rate (energy to construction sites).
   */
  getBuildRate(): number {
    return this.getTotalAllocationForType("construction");
  }

  // ===========================================================================
  // QUERY: METRICS
  // ===========================================================================

  /**
   * Get current solution (or null if not solved).
   */
  getSolution(): FlowSolution | null {
    return this.solution;
  }

  /**
   * Get total harvest rate.
   */
  getTotalHarvest(): number {
    return this.solution?.totalHarvest ?? 0;
  }

  /**
   * Get total overhead.
   */
  getTotalOverhead(): number {
    return this.solution?.totalOverhead ?? 0;
  }

  /**
   * Get net energy (harvest - overhead).
   */
  getNetEnergy(): number {
    return this.solution?.netEnergy ?? 0;
  }

  /**
   * Get efficiency percentage.
   */
  getEfficiency(): number {
    return this.solution?.efficiency ?? 0;
  }

  /**
   * Check if economy is sustainable.
   */
  isSustainable(): boolean {
    return this.solution?.isSustainable ?? false;
  }

  /**
   * Get unmet demand map.
   */
  getUnmetDemand(): Map<string, number> {
    return this.solution?.unmetDemand ?? new Map();
  }

  /**
   * Get warnings from last solve.
   */
  getWarnings(): string[] {
    return this.solution?.warnings ?? [];
  }

  // ===========================================================================
  // DYNAMIC UPDATES
  // ===========================================================================

  /**
   * Add a construction site dynamically.
   * Call this when a new site is placed.
   */
  addConstructionSite(
    id: string,
    nodeId: string,
    position: Position,
    progressRemaining: number
  ): void {
    this.graph.addConstructionSite(id, nodeId, position, progressRemaining);
    // Rebuild edges for new sink
    this.graph.buildEdges();
  }

  /**
   * Remove a construction site.
   * Call this when a site completes or is cancelled.
   */
  removeConstructionSite(id: string): void {
    this.graph.removeConstructionSite(id);
  }

  /**
   * Add an extension.
   */
  addExtension(id: string, nodeId: string, position: Position): void {
    this.graph.addExtension(id, nodeId, position);
    this.graph.buildEdges();
  }

  /**
   * Add a tower.
   */
  addTower(id: string, nodeId: string, position: Position): void {
    this.graph.addTower(id, nodeId, position);
    this.graph.buildEdges();
  }

  /**
   * Rebuild the graph from nodes.
   * Call this when room structures change significantly.
   */
  rebuild(nodes: Node[]): void {
    this.nodes.clear();
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }
    this.graph = createFlowGraph(nodes, this.navigator);
    this.solution = null;
  }

  // ===========================================================================
  // CONFIGURATION
  // ===========================================================================

  /**
   * Set update interval (ticks between re-solves).
   */
  setUpdateInterval(ticks: number): void {
    this.updateInterval = Math.max(1, ticks);
  }

  /**
   * Set constraints.
   */
  setConstraints(constraints: Partial<FlowConstraints>): void {
    this.constraints = { ...this.constraints, ...constraints };
  }

  /**
   * Get the priority manager for custom rule configuration.
   */
  getPriorityManager(): PriorityManager {
    return this.priorityManager;
  }

  /**
   * Get the flow graph for direct access.
   */
  getFlowGraph(): FlowGraph {
    return this.graph;
  }

  // ===========================================================================
  // DEBUG
  // ===========================================================================

  /**
   * Print economy summary to console.
   */
  debugPrint(): void {
    console.log("\n=== FlowEconomy Debug ===");
    console.log(`Nodes: ${this.nodes.size}`);
    console.log(`Last update: tick ${this.lastUpdateTick}`);
    console.log(`Update interval: ${this.updateInterval} ticks`);

    if (this.solution) {
      printSolutionSummary(this.solution);
    } else {
      console.log("No solution computed yet");
    }

    this.graph.debugPrint();
  }
}

// =============================================================================
// FACTORY FUNCTIONS
// =============================================================================

/**
 * Create a FlowEconomy from nodes and navigator.
 * Convenience function that also performs initial solve.
 *
 * @param nodes - Array of territory nodes
 * @param navigator - Node navigator for pathfinding
 * @param context - Initial priority context
 */
export function createFlowEconomy(
  nodes: Node[],
  navigator: NodeNavigator,
  context?: PriorityContext
): FlowEconomy {
  const economy = new FlowEconomy(nodes, navigator);

  if (context) {
    economy.update(context);
  }

  return economy;
}

/**
 * Create a FlowEconomy with preset priority configuration.
 */
export function createFlowEconomyWithPreset(
  nodes: Node[],
  navigator: NodeNavigator,
  preset: keyof typeof PRIORITY_PRESETS
): FlowEconomy {
  const economy = new FlowEconomy(nodes, navigator);

  // Apply preset priorities
  const priorities = PRIORITY_PRESETS[preset]();
  for (const sink of economy.getFlowGraph().getSinks()) {
    const priority = priorities.get(sink.type);
    if (priority !== undefined) {
      sink.priority = priority;
    }
  }

  return economy;
}
