/**
 * FlowGraph - Flow Network Construction
 *
 * Builds the flow network from spatial nodes and navigator.
 * Discovers sources and sinks, creates edges, calculates distances.
 *
 * This replaces the Market's role in connecting producers and consumers.
 */

import { Node, NodeResource, getResourcesByType } from "../nodes/Node";
import { NodeNavigator, estimateWalkingDistance } from "../nodes/NodeNavigator";
import { countMiningSpots } from "../analysis/SourceAnalysis";
import {
  FlowSource,
  FlowSink,
  FlowEdge,
  FlowProblem,
  FlowConstraints,
  SinkType,
  PriorityContext,
  DEFAULT_SINK_PRIORITIES,
  DEFAULT_CONSTRAINTS,
  SOURCE_ENERGY_PER_TICK,
  createFlowSource,
  createFlowSink,
  createEdgeId,
  calculateRoundTrip,
  calculateCarryParts,
  calculateHaulerCostPerTick,
  chebyshevDistance,
  Position,
} from "./FlowTypes";

// =============================================================================
// FLOW GRAPH CLASS
// =============================================================================

/**
 * FlowGraph builds and maintains the flow network from spatial nodes.
 *
 * The flow network consists of:
 * - Sources: Energy producers (game Sources)
 * - Sinks: Energy consumers (spawns, controllers, construction sites, etc.)
 * - Edges: Transport routes between sources and sinks
 *
 * The graph is rebuilt when nodes change, but priorities can be
 * updated dynamically based on game state.
 */
export class FlowGraph {
  /** All energy sources indexed by ID */
  private sources: Map<string, FlowSource>;

  /** All energy sinks indexed by ID */
  private sinks: Map<string, FlowSink>;

  /** All transport edges indexed by ID */
  private edges: Map<string, FlowEdge>;

  /** Reference to the node navigator for pathfinding */
  private navigator: NodeNavigator;

  /** All nodes in the network */
  private nodes: Map<string, Node>;

  /** Spawn nodes (nodes containing spawns) */
  private spawnNodeIds: Set<string>;

  /** Last tick when the graph was built */
  private builtAt: number;

  /**
   * Creates a new FlowGraph from nodes and navigator.
   *
   * @param nodes - Array of territory nodes
   * @param navigator - Node navigator for pathfinding
   */
  constructor(nodes: Node[], navigator: NodeNavigator) {
    this.sources = new Map();
    this.sinks = new Map();
    this.edges = new Map();
    this.nodes = new Map();
    this.spawnNodeIds = new Set();
    this.navigator = navigator;
    this.builtAt = 0;

    // Index nodes
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }

    // Discover sources and sinks from nodes
    this.discoverSources();
    this.discoverSinks();
    this.discoverSpawnNodes();
  }

  // ===========================================================================
  // DISCOVERY METHODS
  // ===========================================================================

  /**
   * Discover all energy sources from node resources.
   */
  private discoverSources(): void {
    this.sources.clear();

    for (const node of this.nodes.values()) {
      const sourceResources = getResourcesByType(node, "source");

      for (const resource of sourceResources) {
        // resource.capacity is the total energy capacity (e.g., 3000)
        // Convert to rate: capacity / 300 ticks = energy per tick
        const energyCapacity = resource.capacity ?? 3000;
        const ratePerTick = energyCapacity / 300; // Standard: 3000/300 = 10 e/tick

        // Count mining spots from the actual game source
        let maxMiners = 1;
        if (typeof Game !== "undefined") {
          const gameSource = Game.getObjectById(resource.id as Id<Source>);
          if (gameSource) {
            maxMiners = countMiningSpots(gameSource);
          }
        }

        const source = createFlowSource(
          resource.id,
          node.id,
          resource.position,
          ratePerTick,
          maxMiners
        );
        this.sources.set(source.id, source);
      }
    }
  }

  /**
   * Discover all energy sinks from node resources.
   * Creates sinks for spawns, controllers, storage, etc.
   */
  private discoverSinks(): void {
    this.sinks.clear();

    for (const node of this.nodes.values()) {
      // Spawns - critical for creep production
      const spawns = getResourcesByType(node, "spawn");
      for (const resource of spawns) {
        const sink = createFlowSink(
          "spawn",
          resource.id,
          node.id,
          resource.position,
          10, // Base spawn overhead demand
          50  // Max capacity per tick
        );
        this.sinks.set(sink.id, sink);
      }

      // Controllers - upgrading (only owned controllers)
      const controllers = getResourcesByType(node, "controller");
      for (const resource of controllers) {
        // Only add controller as sink if we own it
        if (!resource.isOwned) continue;

        const sink = createFlowSink(
          "controller",
          resource.id,
          node.id,
          resource.position,
          50, // Default upgrade demand
          100 // Max upgrade per tick (limited by WORK parts in practice)
        );
        this.sinks.set(sink.id, sink);
      }

      // Storage - buffer sink (lowest priority)
      const storages = getResourcesByType(node, "storage");
      for (const resource of storages) {
        const sink = createFlowSink(
          "storage",
          resource.id,
          node.id,
          resource.position,
          0,      // No active demand (only takes excess)
          1000    // High capacity for buffering
        );
        this.sinks.set(sink.id, sink);
      }

      // Containers near sources become intermediate collection points
      // (handled differently - they're part of the edge, not a sink)
    }
  }

  /**
   * Find nodes that contain spawns.
   */
  private discoverSpawnNodes(): void {
    this.spawnNodeIds.clear();

    for (const node of this.nodes.values()) {
      const spawns = getResourcesByType(node, "spawn");
      if (spawns.length > 0) {
        this.spawnNodeIds.add(node.id);
      }
    }
  }

  /**
   * Build transport edges between sources and sinks.
   * Each source connects to potential sinks based on distance.
   */
  buildEdges(): void {
    this.edges.clear();

    // For each source, create edges to reachable sinks
    for (const source of this.sources.values()) {
      const sourceNode = this.nodes.get(source.nodeId);
      if (!sourceNode) continue;

      for (const sink of this.sinks.values()) {
        const sinkNode = this.nodes.get(sink.nodeId);
        if (!sinkNode) continue;

        // Calculate distance
        let distance: number;

        if (source.nodeId === sink.nodeId) {
          // Same node - use direct position distance
          distance = chebyshevDistance(source.position, sink.position);
        } else {
          // Different nodes - use navigator for path distance
          const pathResult = this.navigator.findPath(source.nodeId, sink.nodeId);
          if (!pathResult.found) continue;

          // Add intra-node distances at endpoints
          const sourceToNodeCenter = chebyshevDistance(
            source.position,
            sourceNode.peakPosition
          );
          const nodeToSink = chebyshevDistance(
            sinkNode.peakPosition,
            sink.position
          );
          distance = pathResult.distance + sourceToNodeCenter + nodeToSink;
        }

        // Create edge
        const edgeId = createEdgeId(source.id, sink.id);
        const roundTrip = calculateRoundTrip(distance);

        const edge: FlowEdge = {
          id: edgeId,
          fromId: source.id,
          toId: sink.id,
          distance,
          roundTrip,
          carryParts: 0,    // Set by solver
          flowRate: 0,      // Set by solver
          spawnCostPerTick: 0, // Set by solver
          hasRoads: false,  // TODO: detect roads
        };

        this.edges.set(edgeId, edge);
      }
    }
  }

  // ===========================================================================
  // PRIORITY MANAGEMENT
  // ===========================================================================

  /**
   * Update sink priorities based on game context.
   * Called when game state changes (RCL up, attack, etc.)
   *
   * @param context - Current game state context
   */
  updatePriorities(context: PriorityContext): void {
    for (const sink of this.sinks.values()) {
      sink.priority = this.calculateSinkPriority(sink, context);
    }
  }

  /**
   * Calculate priority for a specific sink based on context.
   */
  private calculateSinkPriority(sink: FlowSink, context: PriorityContext): number {
    let priority = DEFAULT_SINK_PRIORITIES[sink.type];

    switch (sink.type) {
      case "spawn":
        // Spawn is always critical
        priority = 100;
        break;

      case "extension":
        // High priority when spawn queue is waiting
        if (context.spawnQueueSize > 0 && context.extensionEnergy < context.extensionCapacity * 0.5) {
          priority = 95;
        } else {
          priority = 50;
        }
        break;

      case "tower":
        // Critical during attack, low otherwise
        if (context.underAttack || context.hostileCreeps > 0) {
          priority = 98;
        } else {
          priority = 30;
        }
        break;

      case "construction":
        // High priority after RCL up
        if (context.constructionSites > 0) {
          // Higher priority for more recent RCL ups
          if (context.ticksSinceRclUp < 10000) {
            priority = 85;
          } else {
            priority = 70;
          }
        } else {
          priority = 0;
        }
        break;

      case "controller":
        // Low during construction, normal otherwise
        if (context.constructionSites > 0) {
          priority = 15; // Just enough to prevent downgrade
        } else {
          priority = 65;
        }
        break;

      case "storage":
        // Lowest priority - only takes excess
        priority = 5;
        break;

      default:
        // Use default
        break;
    }

    return priority;
  }

  // ===========================================================================
  // DYNAMIC SINK MANAGEMENT
  // ===========================================================================

  /**
   * Add a construction site as a temporary sink.
   *
   * @param id - Construction site ID
   * @param nodeId - Node containing the site
   * @param position - World position
   * @param progressRemaining - Build progress remaining
   * @param priority - Override priority (default: construction priority)
   */
  addConstructionSite(
    id: string,
    nodeId: string,
    position: Position,
    progressRemaining: number,
    priority?: number
  ): void {
    const sink = createFlowSink(
      "construction",
      id,
      nodeId,
      position,
      5,  // Demand: 5 energy/tick (builder rate)
      50, // Capacity: max build rate
      priority
    );
    sink.progressRemaining = progressRemaining;
    this.sinks.set(sink.id, sink);
  }

  /**
   * Remove a construction site sink (when complete or cancelled).
   */
  removeConstructionSite(id: string): void {
    const sinkId = `construction-${id}`;
    this.sinks.delete(sinkId);

    // Remove edges to this sink
    for (const [edgeId, edge] of this.edges) {
      if (edge.toId === sinkId) {
        this.edges.delete(edgeId);
      }
    }
  }

  /**
   * Add an extension sink.
   */
  addExtension(
    id: string,
    nodeId: string,
    position: Position
  ): void {
    const sink = createFlowSink(
      "extension",
      id,
      nodeId,
      position,
      50,  // Extensions need filling for spawning
      50   // Extension capacity
    );
    this.sinks.set(sink.id, sink);
  }

  /**
   * Add a tower sink.
   */
  addTower(
    id: string,
    nodeId: string,
    position: Position
  ): void {
    const sink = createFlowSink(
      "tower",
      id,
      nodeId,
      position,
      10,   // Tower base energy need
      1000  // Tower capacity
    );
    this.sinks.set(sink.id, sink);
  }

  // ===========================================================================
  // QUERY METHODS
  // ===========================================================================

  /**
   * Get all sources.
   */
  getSources(): FlowSource[] {
    return Array.from(this.sources.values());
  }

  /**
   * Get a source by ID.
   */
  getSource(id: string): FlowSource | undefined {
    return this.sources.get(id);
  }

  /**
   * Get all sinks, optionally filtered by type.
   */
  getSinks(type?: SinkType): FlowSink[] {
    const sinks = Array.from(this.sinks.values());
    if (type) {
      return sinks.filter(s => s.type === type);
    }
    return sinks;
  }

  /**
   * Get sinks sorted by priority (highest first).
   */
  getSinksByPriority(): FlowSink[] {
    return Array.from(this.sinks.values())
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get a sink by ID.
   */
  getSink(id: string): FlowSink | undefined {
    return this.sinks.get(id);
  }

  /**
   * Get all edges.
   */
  getEdges(): FlowEdge[] {
    return Array.from(this.edges.values());
  }

  /**
   * Get edges from a specific source.
   */
  getEdgesFromSource(sourceId: string): FlowEdge[] {
    return Array.from(this.edges.values())
      .filter(e => e.fromId === sourceId);
  }

  /**
   * Get edges to a specific sink.
   */
  getEdgesToSink(sinkId: string): FlowEdge[] {
    return Array.from(this.edges.values())
      .filter(e => e.toId === sinkId);
  }

  /**
   * Get the edge between a source and sink.
   */
  getEdge(sourceId: string, sinkId: string): FlowEdge | undefined {
    const edgeId = createEdgeId(sourceId, sinkId);
    return this.edges.get(edgeId);
  }

  /**
   * Get nodes that contain spawns.
   */
  getSpawnNodeIds(): Set<string> {
    return new Set(this.spawnNodeIds);
  }

  /**
   * Find the nearest spawn to a source.
   */
  findNearestSpawn(sourceId: string): { sinkId: string; distance: number } | null {
    const source = this.sources.get(sourceId);
    if (!source) return null;

    const spawnSinks = this.getSinks("spawn");
    if (spawnSinks.length === 0) return null;

    let nearest: { sinkId: string; distance: number } | null = null;

    for (const spawn of spawnSinks) {
      const edge = this.getEdge(sourceId, spawn.id);
      if (edge && (!nearest || edge.distance < nearest.distance)) {
        nearest = { sinkId: spawn.id, distance: edge.distance };
      }
    }

    return nearest;
  }

  /**
   * Find the nearest source to a sink.
   */
  findNearestSource(sinkId: string): { sourceId: string; distance: number } | null {
    const sink = this.sinks.get(sinkId);
    if (!sink) return null;

    let nearest: { sourceId: string; distance: number } | null = null;

    for (const source of this.sources.values()) {
      const edge = this.getEdge(source.id, sinkId);
      if (edge && (!nearest || edge.distance < nearest.distance)) {
        nearest = { sourceId: source.id, distance: edge.distance };
      }
    }

    return nearest;
  }

  // ===========================================================================
  // SOLVER INTERFACE
  // ===========================================================================

  /**
   * Get the flow problem for the solver.
   * Returns all sources, sinks (sorted by priority), edges, and constraints.
   *
   * @param constraints - Optional constraint overrides
   */
  getFlowProblem(constraints?: Partial<FlowConstraints>): FlowProblem {
    return {
      sources: this.getSources(),
      sinks: this.getSinksByPriority(),
      edges: this.getEdges(),
      constraints: {
        ...DEFAULT_CONSTRAINTS,
        ...constraints,
      },
    };
  }

  // ===========================================================================
  // STATISTICS
  // ===========================================================================

  /**
   * Get graph statistics.
   */
  getStats(): {
    sourceCount: number;
    sinkCount: number;
    edgeCount: number;
    sinksByType: Map<SinkType, number>;
    totalCapacity: number;
    totalDemand: number;
  } {
    const sinksByType = new Map<SinkType, number>();
    let totalDemand = 0;

    for (const sink of this.sinks.values()) {
      const count = sinksByType.get(sink.type) || 0;
      sinksByType.set(sink.type, count + 1);
      totalDemand += sink.demand;
    }

    const totalCapacity = this.sources.size * SOURCE_ENERGY_PER_TICK;

    return {
      sourceCount: this.sources.size,
      sinkCount: this.sinks.size,
      edgeCount: this.edges.size,
      sinksByType,
      totalCapacity,
      totalDemand,
    };
  }

  /**
   * Debug: Print graph summary.
   */
  debugPrint(): void {
    const stats = this.getStats();
    console.log("\n=== FlowGraph Summary ===");
    console.log(`Sources: ${stats.sourceCount} (${stats.totalCapacity} energy/tick capacity)`);
    console.log(`Sinks: ${stats.sinkCount} (${stats.totalDemand} energy/tick demand)`);
    console.log(`Edges: ${stats.edgeCount}`);
    console.log("\nSinks by type:");
    for (const [type, count] of stats.sinksByType) {
      console.log(`  ${type}: ${count}`);
    }
    console.log("\nSinks by priority:");
    for (const sink of this.getSinksByPriority().slice(0, 10)) {
      console.log(`  ${sink.id}: priority=${sink.priority}, demand=${sink.demand}`);
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a FlowGraph from nodes and navigator.
 * Convenience function that also builds edges.
 *
 * @param nodes - Array of territory nodes
 * @param navigator - Node navigator for pathfinding
 */
export function createFlowGraph(nodes: Node[], navigator: NodeNavigator): FlowGraph {
  const graph = new FlowGraph(nodes, navigator);
  graph.buildEdges();
  return graph;
}
