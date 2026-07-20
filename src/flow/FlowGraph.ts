/**
 * FlowGraph - Flow Network Construction
 *
 * Builds the flow network from spatial nodes and navigator.
 * Discovers sources and sinks, creates edges, calculates distances.
 *
 * This replaces the Market's role in connecting producers and consumers.
 */
import {
  FlowEdge,
  FlowSink,
  FlowSource,
  Position,
  SOURCE_ENERGY_PER_TICK,
  SinkType,
  createEdgeId,
  createFlowSink,
  createFlowSource
} from "./FlowTypes";
import { roundTripTicks } from "../economy/primitives";
import { Node, getResourcesByType } from "../nodes/Node";
import { NodeNavigator, pathDistance } from "../nodes/NodeNavigator";
import { countMiningSpots } from "../analysis/SourceAnalysis";

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
/** Normal controller upgrade demand (energy/tick) when nothing else competes. */
export const DEFAULT_CONTROLLER_UPGRADE_DEMAND = 50;

/** Minimal anti-downgrade controller demand used while construction is pending,
 * so building new structures takes the lion's share of the node's energy. */
export const MIN_CONTROLLER_UPGRADE_DEMAND = 1;

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
  public constructor(nodes: Node[], navigator: NodeNavigator) {
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
        // Skip sources in Source Keeper rooms (too dangerous to mine without combat)
        const roomName = resource.position.roomName;
        if (isSourceKeeperRoom(roomName)) {
          continue;
        }

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

        const source = createFlowSource(resource.id, node.id, resource.position, ratePerTick, maxMiners);
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
          50 // Max capacity per tick
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
          DEFAULT_CONTROLLER_UPGRADE_DEMAND, // upgrade demand (reduced while building)
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
          0, // No active demand (only takes excess)
          1000 // High capacity for buffering
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
  public buildEdges(): void {
    this.edges.clear();

    // For each source, create edges to reachable sinks
    for (const source of this.sources.values()) {
      // Verify source has a valid node
      if (!this.nodes.has(source.nodeId)) continue;

      for (const sink of this.sinks.values()) {
        // Verify sink has a valid node
        if (!this.nodes.has(sink.nodeId)) continue;

        // Real (cached) path distance, so walls/swamps between a source and its
        // sink are reflected in the haul round-trip and the profitability gate.
        // Falls back to the analytic estimate when PathFinder can't path.
        const distance = pathDistance(source.position, sink.position);

        // Create edge
        const edgeId = createEdgeId(source.id, sink.id);
        const roundTrip = roundTripTicks(distance);

        const edge: FlowEdge = {
          id: edgeId,
          fromId: source.id,
          toId: sink.id,
          distance,
          roundTrip,
          carryParts: 0, // Set by solver
          flowRate: 0, // Set by solver
          spawnCostPerTick: 0, // Set by solver
          hasRoads: false // TODO: detect roads
        };

        this.edges.set(edgeId, edge);
      }
    }
  }

  // ===========================================================================
  // PRIORITY MANAGEMENT
  // ===========================================================================

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
  public addConstructionSite(
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
      // Demand a real build crew's worth, not one builder's. Construction outranks
      // the controller (priority 70 vs 60), so this makes building claim the node's
      // surplus while there is something to build - "build supersedes upgrade" - and
      // the builder squad sizes itself to the energy actually allocated (which the
      // available surplus and MAX_BUILDERS still cap, so it does not over-claim).
      // The controller resumes absorbing the surplus once building is done.
      20, // Demand: roughly a full build crew (MAX_BUILDERS) at low/mid RCL
      50, // Capacity: max build rate
      priority
    );
    sink.progressRemaining = progressRemaining;
    this.sinks.set(sink.id, sink);
  }

  // ===========================================================================
  // QUERY METHODS
  // ===========================================================================

  /**
   * Get all sources.
   */
  public getSources(): FlowSource[] {
    return Array.from(this.sources.values());
  }

  /**
   * Get a source by ID.
   */
  public getSource(id: string): FlowSource | undefined {
    return this.sources.get(id);
  }

  /**
   * Get all sinks, optionally filtered by type.
   */
  public getSinks(type?: SinkType): FlowSink[] {
    const sinks = Array.from(this.sinks.values());
    if (type) {
      return sinks.filter(s => s.type === type);
    }
    return sinks;
  }

  /**
   * Get sinks sorted by priority (highest first).
   */
  public getSinksByPriority(): FlowSink[] {
    return Array.from(this.sinks.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Get a sink by ID.
   */
  public getSink(id: string): FlowSink | undefined {
    return this.sinks.get(id);
  }

  /**
   * Get all edges.
   */
  public getEdges(): FlowEdge[] {
    return Array.from(this.edges.values());
  }

  /**
   * Get edges from a specific source.
   */
  public getEdgesFromSource(sourceId: string): FlowEdge[] {
    return Array.from(this.edges.values()).filter(e => e.fromId === sourceId);
  }

  /**
   * Get edges to a specific sink.
   */
  public getEdgesToSink(sinkId: string): FlowEdge[] {
    return Array.from(this.edges.values()).filter(e => e.toId === sinkId);
  }

  /**
   * Get the edge between a source and sink.
   */
  public getEdge(sourceId: string, sinkId: string): FlowEdge | undefined {
    const edgeId = createEdgeId(sourceId, sinkId);
    return this.edges.get(edgeId);
  }

  /**
   * Get nodes that contain spawns.
   */
  public getSpawnNodeIds(): Set<string> {
    return new Set(this.spawnNodeIds);
  }

  /**
   * Find the nearest spawn to a source.
   */
  public findNearestSpawn(sourceId: string): { sinkId: string; distance: number } | null {
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
  public findNearestSource(sinkId: string): { sourceId: string; distance: number } | null {
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
  // STATISTICS
  // ===========================================================================

  /**
   * Get graph statistics.
   */
  public getStats(): {
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
      totalDemand
    };
  }

  /**
   * Debug: Print graph summary.
   */
  public debugPrint(): void {
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
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a room is a Source Keeper room.
 * SK rooms have coordinates where both X and Y end in 4, 5, or 6,
 * but are not center rooms (where both end in 5).
 */
function isSourceKeeperRoom(roomName: string): boolean {
  const match = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
  if (!match) return false;

  const x = parseInt(match[1], 10) % 10;
  const y = parseInt(match[2], 10) % 10;

  // Center rooms (portals) have both coords ending in 5
  if (x === 5 && y === 5) return false;

  // SK rooms have both coords in [4, 5, 6] range
  return x >= 4 && x <= 6 && y >= 4 && y <= 6;
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
