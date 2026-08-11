import { CorpRegistry } from "../execution/CorpRunner";
import { completeCensus } from "../execution/CommissionHost";
import { Node } from "../nodes/Node";

/**
 * Colony statistics for monitoring
 */
export interface ColonyStats {
  /** Number of nodes */
  nodeCount: number;
  /** Total corps across all nodes */
  totalCorps: number;
  /** Active corps (with creeps) */
  activeCorps: number;
}

/**
 * Colony is the top-level spatial coordinator.
 *
 * The colony manages:
 * 1. Nodes (territories) - spatial regions identified by peak detection
 * 2. Statistics - tracking economic health
 *
 * NOTE: Actual corp execution is handled by CorpRunner in the execution module,
 * and the colony economy is solved by the CorpPlanner (src/economy). Corps are
 * managed via CorpRegistry, not via node.corps. This class provides spatial
 * infrastructure but doesn't directly run corps or plan the economy.
 *
 * See main.ts for the full game loop orchestration.
 */
export class Colony {
  /** All nodes in this colony */
  private nodes: Node[] = [];

  /** Current tick */
  private currentTick = 0;

  /** Whether colony has been bootstrapped */
  private bootstrapped = false;

  /** Stats tracking */
  private stats: ColonyStats = {
    nodeCount: 0,
    totalCorps: 0,
    activeCorps: 0
  };

  /**
   * Main colony tick - run spatial coordination.
   *
   * NOTE: This does NOT run corps - that's handled by CorpRunner in main.ts -
   * nor does it plan the economy (CorpPlanner does). This method handles:
   * - Bootstrap (one-time initialization marker)
   * - Stats updates
   */
  public run(tick: number, corpRegistry: CorpRegistry): void {
    this.currentTick = tick;

    // Bootstrap once on first run.
    if (!this.bootstrapped) {
      this.bootstrap();
    }

    // Update stats
    this.updateStats(corpRegistry);
  }

  /**
   * Bootstrap the colony (one-time initialization marker).
   */
  private bootstrap(): void {
    this.bootstrapped = true;
  }

  /**
   * Add a node to the colony
   */
  public addNode(node: Node): void {
    // Check for duplicate
    if (this.nodes.some(n => n.id === node.id)) {
      return;
    }
    this.nodes.push(node);
  }

  /**
   * Remove a node from the colony
   */
  public removeNode(nodeId: string): void {
    this.nodes = this.nodes.filter(n => n.id !== nodeId);
  }

  /**
   * Get all nodes
   */
  public getNodes(): Node[] {
    return [...this.nodes];
  }

  /**
   * Get a node by ID
   */
  public getNode(nodeId: string): Node | undefined {
    return this.nodes.find(n => n.id === nodeId);
  }

  /**
   * Update colony statistics
   */
  private updateStats(corpRegistry: CorpRegistry): void {
    // The complete census (store + legacy kinds) via the one shared fold.
    // A corp is "active" when it has creeps; spawning corps count as active by
    // existing (they hold no creeps of their own).
    let totalCorps = 0;
    let activeCorps = 0;
    for (const { kind, corp } of completeCensus(corpRegistry)) {
      totalCorps++;
      if (kind === "spawning") {
        activeCorps++;
        continue;
      }
      const counter = corp as unknown as { getCreepCount?: () => number };
      if (typeof counter.getCreepCount === "function" && counter.getCreepCount() > 0) activeCorps++;
    }

    this.stats = {
      nodeCount: this.nodes.length,
      totalCorps,
      activeCorps
    };
  }

  /**
   * Get colony statistics
   */
  public getStats(): ColonyStats {
    return { ...this.stats };
  }

  /**
   * Serialize colony state for persistence
   */
  public serialize(): SerializedColony {
    return {
      bootstrapped: this.bootstrapped,
      currentTick: this.currentTick,
      nodeIds: this.nodes.map(n => n.id)
    };
  }

  /**
   * Restore colony state from persistence
   */
  public deserialize(data: SerializedColony): void {
    this.bootstrapped = data.bootstrapped ?? false;
    this.currentTick = data.currentTick ?? 0;
    // (Older Memory blobs may still carry a `config` key from the retired
    // market-era ColonyConfig - ignored; nothing ever read it.)
    // Node restoration would need additional logic
  }
}

/**
 * Serialized colony state
 */
export interface SerializedColony {
  bootstrapped: boolean;
  currentTick: number;
  nodeIds: string[];
}

/**
 * Create a colony.
 */
export function createColony(): Colony {
  return new Colony();
}
