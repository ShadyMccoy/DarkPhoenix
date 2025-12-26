/**
 * @fileoverview Min-cost max-flow solver for energy routing.
 *
 * Once we know how much energy each source produces, we need to route it
 * to spawns/projects with minimum transport overhead.
 *
 * This is a classic min-cost max-flow problem:
 * - Sources = nodes with energy surplus (after mining costs)
 * - Sinks = spawns/projects that consume energy
 * - Edges = carry routes with capacity (hauler throughput) and cost (per-energy)
 *
 * We use the Successive Shortest Paths algorithm:
 * 1. Find shortest path (by cost) from any source to any sink
 * 2. Push as much flow as possible along that path
 * 3. Repeat until no more flow can be pushed
 *
 * The result is optimal: maximum energy delivered with minimum transport cost.
 *
 * @module framework/FlowRouter
 */

import { CarryEdge, calculateCarryEdgeThroughput, calculateCarryEdgeCostPerEnergy } from "./FlowEdge";

/**
 * A node in the flow routing graph.
 */
export interface FlowNode {
  /** Node ID */
  id: string;

  /** Energy supply (positive) or demand (negative) */
  supply: number;

  /** Is this a source node? */
  isSource: boolean;

  /** Is this a sink node? (spawn/project) */
  isSink: boolean;
}

/**
 * An edge in the flow routing graph.
 */
export interface FlowArc {
  /** From node ID */
  from: string;

  /** To node ID */
  to: string;

  /** Maximum flow capacity (energy/tick) */
  capacity: number;

  /** Cost per unit of flow (energy cost to transport 1 energy) */
  cost: number;

  /** Current flow on this arc */
  flow: number;

  /** Reference to original carry edge (if any) */
  carryEdge?: CarryEdge;
}

/**
 * Result of flow routing.
 */
export interface FlowRoutingResult {
  /** Flow assignments per arc */
  arcs: FlowArc[];

  /** Total flow (energy delivered to sinks) */
  totalFlow: number;

  /** Total transport cost */
  totalCost: number;

  /** Energy per sink node */
  sinkFlows: Map<string, number>;

  /** Unrouted supply (energy that couldn't reach any sink) */
  unroutedSupply: number;

  /** Unsatisfied demand (sinks that didn't get enough) */
  unsatisfiedDemand: number;
}

/**
 * Flow routing graph.
 */
export class FlowGraph {
  private nodes: Map<string, FlowNode> = new Map();
  private arcs: FlowArc[] = [];
  private adjacency: Map<string, FlowArc[]> = new Map();

  /**
   * Adds a node to the graph.
   */
  addNode(id: string, supply: number, isSource: boolean, isSink: boolean): void {
    this.nodes.set(id, { id, supply, isSource, isSink });
    if (!this.adjacency.has(id)) {
      this.adjacency.set(id, []);
    }
  }

  /**
   * Adds an arc (directed edge) to the graph.
   */
  addArc(from: string, to: string, capacity: number, cost: number, carryEdge?: CarryEdge): void {
    const arc: FlowArc = { from, to, capacity, cost, flow: 0, carryEdge };
    this.arcs.push(arc);
    this.adjacency.get(from)?.push(arc);
  }

  /**
   * Gets all arcs from a node.
   */
  getArcsFrom(nodeId: string): FlowArc[] {
    return this.adjacency.get(nodeId) ?? [];
  }

  /**
   * Gets all source nodes.
   */
  getSources(): FlowNode[] {
    return Array.from(this.nodes.values()).filter(n => n.isSource && n.supply > 0);
  }

  /**
   * Gets all sink nodes.
   */
  getSinks(): FlowNode[] {
    return Array.from(this.nodes.values()).filter(n => n.isSink);
  }

  /**
   * Gets a node by ID.
   */
  getNode(id: string): FlowNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Gets all arcs.
   */
  getArcs(): FlowArc[] {
    return this.arcs;
  }

  /**
   * Gets all node IDs.
   */
  getNodeIds(): string[] {
    return Array.from(this.nodes.keys());
  }
}

/**
 * Builds a flow graph from supply allocations and carry edges.
 */
export function buildFlowGraph(
  nodeSupplies: Map<string, number>,  // nodeId -> net energy supply
  nodeDemands: Map<string, number>,   // nodeId -> energy demand (positive = needs energy)
  carryEdges: CarryEdge[]
): FlowGraph {
  const graph = new FlowGraph();

  // Add all nodes
  const allNodeIds = new Set([
    ...nodeSupplies.keys(),
    ...nodeDemands.keys(),
    ...carryEdges.map(e => e.fromNodeId),
    ...carryEdges.map(e => e.toNodeId),
  ]);

  for (const nodeId of allNodeIds) {
    const supply = nodeSupplies.get(nodeId) ?? 0;
    const demand = nodeDemands.get(nodeId) ?? 0;
    const netSupply = supply - demand;

    graph.addNode(
      nodeId,
      netSupply,
      netSupply > 0,  // isSource
      demand > 0       // isSink
    );
  }

  // Add carry edges as arcs (bidirectional - can haul either direction)
  for (const edge of carryEdges) {
    const capacity = calculateCarryEdgeThroughput(edge);
    const cost = calculateCarryEdgeCostPerEnergy(edge);

    // Forward direction
    graph.addArc(edge.fromNodeId, edge.toNodeId, capacity, cost, edge);

    // Reverse direction (same cost, different arc)
    graph.addArc(edge.toNodeId, edge.fromNodeId, capacity, cost, edge);
  }

  return graph;
}

/**
 * Finds the shortest path (by cost) from any source to any sink.
 * Uses Bellman-Ford to handle potential negative costs in residual graph.
 */
function findShortestPath(
  graph: FlowGraph,
  sources: Set<string>,
  sinks: Set<string>
): { path: FlowArc[]; minCapacity: number } | null {
  const nodeIds = graph.getNodeIds();
  const dist = new Map<string, number>();
  const prev = new Map<string, FlowArc | null>();

  // Initialize distances
  for (const id of nodeIds) {
    dist.set(id, sources.has(id) ? 0 : Infinity);
    prev.set(id, null);
  }

  // Relax edges |V| - 1 times
  for (let i = 0; i < nodeIds.length - 1; i++) {
    let changed = false;

    for (const arc of graph.getArcs()) {
      // Only consider arcs with remaining capacity
      const residualCapacity = arc.capacity - arc.flow;
      if (residualCapacity <= 0) continue;

      const newDist = dist.get(arc.from)! + arc.cost;
      if (newDist < dist.get(arc.to)!) {
        dist.set(arc.to, newDist);
        prev.set(arc.to, arc);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Find the nearest reachable sink
  let bestSink: string | null = null;
  let bestDist = Infinity;

  for (const sinkId of sinks) {
    const d = dist.get(sinkId)!;
    if (d < bestDist) {
      bestDist = d;
      bestSink = sinkId;
    }
  }

  if (bestSink === null || bestDist === Infinity) {
    return null;
  }

  // Reconstruct path and find minimum capacity
  const path: FlowArc[] = [];
  let minCapacity = Infinity;
  let current = bestSink;

  while (prev.get(current) !== null) {
    const arc = prev.get(current)!;
    path.unshift(arc);
    minCapacity = Math.min(minCapacity, arc.capacity - arc.flow);
    current = arc.from;
  }

  if (path.length === 0) {
    return null;
  }

  return { path, minCapacity };
}

/**
 * Solves the min-cost max-flow problem using Successive Shortest Paths.
 *
 * This finds the optimal way to route energy from sources to sinks
 * while minimizing transport cost.
 */
export function solveMinCostMaxFlow(graph: FlowGraph): FlowRoutingResult {
  const sources = new Set(graph.getSources().map(n => n.id));
  const sinks = new Set(graph.getSinks().map(n => n.id));

  // Track remaining supply at each source
  const remainingSupply = new Map<string, number>();
  for (const source of graph.getSources()) {
    remainingSupply.set(source.id, source.supply);
  }

  // Track remaining demand at each sink
  const remainingDemand = new Map<string, number>();
  for (const sink of graph.getSinks()) {
    remainingDemand.set(sink.id, Math.abs(sink.supply));
  }

  let totalFlow = 0;
  let totalCost = 0;
  const sinkFlows = new Map<string, number>();

  for (const sink of graph.getSinks()) {
    sinkFlows.set(sink.id, 0);
  }

  // Successive shortest paths
  while (true) {
    // Find active sources (still have supply)
    const activeSources = new Set<string>();
    for (const [id, supply] of remainingSupply) {
      if (supply > 0) activeSources.add(id);
    }

    // Find active sinks (still have demand)
    const activeSinks = new Set<string>();
    for (const [id, demand] of remainingDemand) {
      if (demand > 0) activeSinks.add(id);
    }

    if (activeSources.size === 0 || activeSinks.size === 0) {
      break;
    }

    const result = findShortestPath(graph, activeSources, activeSinks);
    if (!result) break;

    const { path, minCapacity } = result;

    // Determine how much flow to push
    const sourceId = path[0].from;
    const sinkId = path[path.length - 1].to;

    const availableSupply = remainingSupply.get(sourceId) ?? 0;
    const availableDemand = remainingDemand.get(sinkId) ?? 0;

    const flowToPush = Math.min(minCapacity, availableSupply, availableDemand);

    if (flowToPush <= 0) break;

    // Push flow along path
    for (const arc of path) {
      arc.flow += flowToPush;
      totalCost += flowToPush * arc.cost;
    }

    // Update supply/demand
    remainingSupply.set(sourceId, availableSupply - flowToPush);
    remainingDemand.set(sinkId, availableDemand - flowToPush);

    totalFlow += flowToPush;
    sinkFlows.set(sinkId, (sinkFlows.get(sinkId) ?? 0) + flowToPush);
  }

  // Calculate unrouted and unsatisfied
  let unroutedSupply = 0;
  for (const supply of remainingSupply.values()) {
    unroutedSupply += supply;
  }

  let unsatisfiedDemand = 0;
  for (const demand of remainingDemand.values()) {
    unsatisfiedDemand += demand;
  }

  return {
    arcs: graph.getArcs().filter(a => a.flow > 0),
    totalFlow,
    totalCost,
    sinkFlows,
    unroutedSupply,
    unsatisfiedDemand,
  };
}

/**
 * Formats a flow routing result for display.
 */
export function formatFlowRouting(result: FlowRoutingResult): string {
  const lines: string[] = [
    "=== Flow Routing Result ===",
    "",
    `Total Flow:       ${result.totalFlow.toFixed(2)} energy/tick`,
    `Transport Cost:   ${result.totalCost.toFixed(2)} energy/tick`,
    `Net Delivered:    ${(result.totalFlow - result.totalCost).toFixed(2)} energy/tick`,
    "",
  ];

  if (result.unroutedSupply > 0) {
    lines.push(`⚠ Unrouted supply: ${result.unroutedSupply.toFixed(2)}/tick`);
  }

  if (result.unsatisfiedDemand > 0) {
    lines.push(`⚠ Unsatisfied demand: ${result.unsatisfiedDemand.toFixed(2)}/tick`);
  }

  lines.push("", "--- Active Routes ---");

  for (const arc of result.arcs) {
    const efficiency = 1 / (1 + arc.cost);
    lines.push(
      `  ${arc.from} → ${arc.to}: ${arc.flow.toFixed(2)}/tick ` +
      `(cost: ${arc.cost.toFixed(3)}/energy, ${(efficiency * 100).toFixed(1)}% efficient)`
    );
  }

  lines.push("", "--- Sink Deliveries ---");

  for (const [sinkId, flow] of result.sinkFlows) {
    if (flow > 0) {
      lines.push(`  ${sinkId}: ${flow.toFixed(2)} energy/tick`);
    }
  }

  return lines.join("\n");
}
