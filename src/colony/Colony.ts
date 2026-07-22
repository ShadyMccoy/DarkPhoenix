import { CorpRegistry } from "../execution/CorpRunner";
import { completeCensus } from "../execution/CommissionHost";
import { Node } from "../nodes/Node";

/**
 * Colony configuration
 */
export interface ColonyConfig {
  /** Tax rate applied per tick (default 0.001 = 0.1%) */
  taxRate: number;
  /** Grace period for new corps before pruning (ticks) */
  corpGracePeriod: number;
  /** Minimum treasury balance before funding new work */
  minTreasuryBuffer: number;
}

/**
 * Default colony configuration
 */
export const DEFAULT_COLONY_CONFIG: ColonyConfig = {
  taxRate: 0.001,
  corpGracePeriod: 1500,
  minTreasuryBuffer: 1000
};

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
 * 2. Surveys - identifying potential corps in territories
 * 3. Statistics - tracking economic health
 *
 * NOTE: Actual corp execution is handled by CorpRunner in the execution module,
 * and the colony economy is solved by the CorpPlanner (src/economy). Corps are
 * managed via CorpRegistry, not via node.corps. This class provides spatial
 * infrastructure (surveying) but doesn't directly run corps or plan the economy.
 *
 * See main.ts for the full game loop orchestration.
 */
export class Colony {
  /** All nodes in this colony */
  private nodes: Node[] = [];

  /** Node surveyor for finding opportunities */

  /** Colony configuration */
  private config: ColonyConfig;

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

  public constructor(config: Partial<ColonyConfig> = {}) {
    this.config = { ...DEFAULT_COLONY_CONFIG, ...config };
  }

  /**
   * Main colony tick - run spatial coordination.
   *
   * NOTE: This does NOT run corps - that's handled by CorpRunner in main.ts -
   * nor does it plan the economy (CorpPlanner does). This method handles:
   * - Bootstrap (one-time initialization marker)
   * - Node surveying (identify potential corps)
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
   * Get configuration
   */
  public getConfig(): ColonyConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  public setConfig(config: Partial<ColonyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current tick
   */
  public getCurrentTick(): number {
    return this.currentTick;
  }

  /**
   * Serialize colony state for persistence
   */
  public serialize(): SerializedColony {
    return {
      bootstrapped: this.bootstrapped,
      currentTick: this.currentTick,
      config: this.config,
      nodeIds: this.nodes.map(n => n.id)
    };
  }

  /**
   * Restore colony state from persistence
   */
  public deserialize(data: SerializedColony): void {
    this.bootstrapped = data.bootstrapped ?? false;
    this.currentTick = data.currentTick ?? 0;
    this.config = { ...DEFAULT_COLONY_CONFIG, ...data.config };
    // Node restoration would need additional logic
  }
}

/**
 * Serialized colony state
 */
export interface SerializedColony {
  bootstrapped: boolean;
  currentTick: number;
  config: ColonyConfig;
  nodeIds: string[];
}

/**
 * Create a colony with default configuration
 */
export function createColony(config?: Partial<ColonyConfig>): Colony {
  return new Colony(config);
}
