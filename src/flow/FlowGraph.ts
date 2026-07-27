/**
 * FlowGraph - Flow Network Construction
 *
 * Discovers sources and sinks from spatial nodes - the world-translation
 * input economy/flowAdapter flattens into the pure ColonyProblem.
 */
import { FlowSink, FlowSource, Position, SinkType, createFlowSink, createFlowSource } from "./FlowTypes";
import { Node, getResourcesByType } from "../nodes/Node";
import { countMiningSpots } from "../analysis/SourceAnalysis";
import { isSourceKeeperRoom } from "../utils/RoomDiscovery";

// =============================================================================
// FLOW GRAPH CLASS
// =============================================================================

/**
 * FlowGraph builds and maintains the flow network from spatial nodes.
 *
 * The flow network consists of:
 * - Sources: Energy producers (game Sources)
 * - Sinks: Energy consumers (spawns, controllers, construction sites, etc.)
 */
/** Normal controller upgrade demand (energy/tick) when nothing else competes. */
export const DEFAULT_CONTROLLER_UPGRADE_DEMAND = 50;

export class FlowGraph {
  /** All energy sources indexed by ID */
  private sources: Map<string, FlowSource>;

  /** All energy sinks indexed by ID */
  private sinks: Map<string, FlowSink>;

  /** All nodes in the network */
  private nodes: Map<string, Node>;

  /**
   * Creates a new FlowGraph from nodes.
   *
   * @param nodes - Array of territory nodes
   */
  public constructor(nodes: Node[]) {
    this.sources = new Map();
    this.sinks = new Map();
    this.nodes = new Map();

    // Index nodes
    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }

    // Discover sources and sinks from nodes
    this.discoverSources();
    this.discoverSinks();
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
   * Get a sink by ID.
   */
  public getSink(id: string): FlowSink | undefined {
    return this.sinks.get(id);
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a FlowGraph from nodes.
 *
 * @param nodes - Array of territory nodes
 */
export function createFlowGraph(nodes: Node[]): FlowGraph {
  return new FlowGraph(nodes);
}
