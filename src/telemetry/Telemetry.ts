/**
 * @fileoverview Telemetry system for exporting game data to RawMemory segments.
 *
 * This module writes telemetry data to RawMemory segments each tick (or periodically),
 * enabling an external app to poll the Screeps HTTP API and visualize colony state.
 *
 * ## Segment Layout
 * - Segment 0: Core telemetry (colony stats, money supply, creep counts)
 * - Segment 1: Node data (territories, resources, ROI)
 * - Segment 2: Edge data (spatial and economic edges with flow rates)
 * - Segment 3: Room intel data (scouted room information)
 * - Segment 4: Corps data (mining, hauling, upgrading corps)
 * - Segment 5: Active chains data
 * - Segment 6: Flow economy (sources, sinks, allocations)
 *
 * ## Data Flow
 * Screeps Game → RawMemory.segments[N] → HTTP API → External App → Dashboard
 *
 * @module telemetry/Telemetry
 */

import { Colony } from "../colony/Colony";
import { Corp } from "../corps/Corp";
import { deserializeChain, SerializedChain } from "../planning/Chain";
import { FlowSolution } from "../flow/FlowTypes";

/**
 * Interface for corps that track creeps.
 */
interface CreepTrackingCorp extends Corp {
  getCreepCount(): number;
}

/**
 * Interface for spawning corps (tracks pending orders instead of creeps).
 */
interface SpawningCorpLike extends Corp {
  getPendingOrderCount(): number;
}

/**
 * Segment assignments for telemetry data.
 */
export const TELEMETRY_SEGMENTS = {
  CORE: 0,      // Colony stats, money supply, creep counts
  NODES: 1,     // Node territories, resources, ROI
  EDGES: 2,     // Spatial and economic edges with flow rates
  INTEL: 3,     // Room intel from scouting
  CORPS: 4,     // Corps details
  CHAINS: 5,    // Active chains
  FLOW: 6,      // Flow economy: sources, sinks, allocations
};

/**
 * Segments to make publicly readable via API.
 */
export const PUBLIC_SEGMENTS = [0, 1, 2, 3, 4, 5, 6];

/**
 * Core telemetry data structure (Segment 0).
 */
export interface CoreTelemetry {
  /** Telemetry format version */
  version: number;
  /** Current game tick */
  tick: number;
  /** Shard name */
  shard: string;
  /** CPU usage this tick */
  cpu: {
    used: number;
    limit: number;
    bucket: number;
    tickLimit: number;
  };
  /** GCL information */
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
  };
  /** Colony stats */
  colony: {
    nodeCount: number;
    totalCorps: number;
    activeCorps: number;
    activeChains: number;
    averageROI: number;
  };
  /** Money supply */
  money: {
    treasury: number;
    minted: number;
    taxed: number;
    net: number;
  };
  /** Creep counts by type */
  creeps: {
    total: number;
    bootstrap: number;
    miners: number;
    haulers: number;
    upgraders: number;
    scouts: number;
    builders: number;
  };
  /** Owned rooms summary */
  rooms: {
    name: string;
    rcl: number;
    rclProgress: number;
    rclProgressTotal: number;
    energyAvailable: number;
    energyCapacity: number;
  }[];
}

/**
 * Node telemetry data structure (Segment 1).
 * Uses compact keys to minimize size:
 * - id, r=roomName, p=peakPosition, t=territorySize
 * - res=resources, roi, spans=spansRooms
 */
export interface NodeTelemetry {
  version: number;
  tick: number;
  nodes: {
    id: string;
    r: string;  // roomName
    p: { x: number; y: number; r: string };  // peakPosition
    t: number;  // territorySize
    res: {  // resources (compact)
      t: string;  // type
      x: number;
      y: number;
    }[];
    roi?: {
      s: number;   // score
      e: number;   // expansionScore
      o: number;   // openness
      d: number;   // distanceFromOwned
      own: boolean;  // isOwned
      src: number;   // sourceCount
      ctrl: boolean; // hasController
    };
    spans: string[];  // spansRooms
    econ?: boolean;   // is part of economic network (has corps)
    sp?: number;      // number of spawn structures in this node's room
  }[];
  /** @deprecated Edges moved to segment 2 (EdgesTelemetry) in version 5 */
  edges?: string[];
  /** @deprecated Economic edges moved to segment 2 (EdgesTelemetry) in version 5 */
  economicEdges?: { [edge: string]: number };
  summary: {
    totalNodes: number;
    ownedNodes: number;
    expansionCandidates: number;
    totalSources: number;
    avgROI: number;
  };
}

/**
 * Edges telemetry data structure (Segment 2).
 * Uses compressed numeric format to minimize size:
 * - nodeIndex maps node position in nodes array to node ID
 * - edges are [idx1, idx2] pairs (indices into nodeIndex)
 * - economicEdges are [idx1, idx2, distance, flowRate?] - flowRate is energy/tick
 */
export interface EdgesTelemetry {
  version: number;
  tick: number;
  /** Node IDs in index order - position = index for edge references */
  nodeIndex: string[];
  /** Spatial edges as [idx1, idx2] pairs (indices into nodeIndex) */
  edges: [number, number][];
  /** Economic edges as [idx1, idx2, distance, flowRate?] - flowRate in energy/tick */
  economicEdges: [number, number, number, number?][];
}

/**
 * Intel telemetry data structure (Segment 3).
 */
export interface IntelTelemetry {
  version: number;
  tick: number;
  rooms: {
    name: string;
    lastVisit: number;
    sourceCount: number;
    sourcePositions: { x: number; y: number }[];
    mineralType: string | null;
    mineralPos: { x: number; y: number } | null;
    controllerLevel: number;
    controllerPos: { x: number; y: number } | null;
    controllerOwner: string | null;
    controllerReservation: string | null;
    hostileCreepCount: number;
    hostileStructureCount: number;
    isSafe: boolean;
  }[];
}

/**
 * Corps telemetry data structure (Segment 4).
 */
export interface CorpsTelemetry {
  version: number;
  tick: number;
  corps: {
    id: string;
    type: string;
    nodeId: string;
    roomName: string;
    balance: number;
    totalRevenue: number;
    totalCost: number;
    profit: number;
    roi: number;
    isActive: boolean;
    creepCount: number;
    createdAt: number;
    lastActivityTick: number;
  }[];
  summary: {
    totalCorps: number;
    activeCorps: number;
    totalBalance: number;
    avgProfit: number;
    corpsByType: { [type: string]: number };
  };
}

/**
 * Chains telemetry data structure (Segment 5).
 */
export interface ChainsTelemetry {
  version: number;
  tick: number;
  chains: {
    id: string;
    funded: boolean;
    age: number;
    leafCost: number;
    totalCost: number;
    mintValue: number;
    profit: number;
    segments: {
      corpType: string;
      resource: string;
      inputCost: number;
      margin: number;
      outputPrice: number;
    }[];
  }[];
  summary: {
    totalChains: number;
    fundedChains: number;
    totalProfit: number;
    avgChainAge: number;
  };
}

/**
 * Flow telemetry data structure (Segment 6).
 * Shows flow economy state: sources, sinks, and energy flow.
 */
export interface FlowTelemetry {
  version: number;
  tick: number;
  /** Source nodes (energy producers) */
  sources: {
    id: string;
    nodeId: string;
    harvestRate: number;
    workParts: number;
    /** Mining efficiency percentage (0-100) */
    efficiency: number;
    /** Distance from spawn */
    spawnDistance: number;
  }[];
  /** Sink nodes (energy consumers) - spawns, controllers, construction */
  sinks: {
    id: string;
    nodeId?: string;  // Optional - may not always be available
    type: string;  // "spawn" | "controller" | "construction"
    demand: number;
    allocated: number;
    unmet: number;
    priority: number;
  }[];
  /** Flow summary */
  summary: {
    totalHarvest: number;
    totalOverhead: number;
    netEnergy: number;
    efficiency: number;
    isSustainable: boolean;
    minerCount: number;
    haulerCount: number;
  };
  /** Warnings from the flow solver */
  warnings: string[];
}

/**
 * Telemetry configuration.
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;
  /** Tick interval for full telemetry update (0 = every tick) */
  updateInterval: number;
  /** Tick interval for terrain update (expensive, should be infrequent) */
  terrainInterval: number;
}

/**
 * Default telemetry configuration.
 */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  updateInterval: 1,      // Every tick for core data
  terrainInterval: 1000,  // Every 1000 ticks for terrain (rarely changes)
};

/**
 * Telemetry system for exporting game data to RawMemory segments.
 */
export class Telemetry {
  private config: TelemetryConfig;

  constructor(config: Partial<TelemetryConfig> = {}) {
    this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
  }

  /**
   * Updates all telemetry data in RawMemory segments.
   * Call this from the main game loop.
   */
  update(
    colony: Colony | undefined,
    bootstrapCorps: { [roomName: string]: { getCreepCount(): number } },
    harvestCorps: { [sourceId: string]: CreepTrackingCorp },
    haulingCorps: { [roomName: string]: CreepTrackingCorp },
    upgradingCorps: { [roomName: string]: CreepTrackingCorp },
    scoutCorps: { [roomName: string]: { getCreepCount(): number } },
    constructionCorps: { [roomName: string]: CreepTrackingCorp } = {},
    spawningCorps: { [spawnId: string]: SpawningCorpLike } = {},
    flowSolution?: FlowSolution
  ): void {
    if (!this.config.enabled) return;

    // Set public segments for API access
    RawMemory.setPublicSegments(PUBLIC_SEGMENTS);

    // Request segments we'll be writing to
    RawMemory.setActiveSegments(PUBLIC_SEGMENTS);

    // Check if we should update based on interval
    const shouldUpdate = this.config.updateInterval === 0 ||
      Game.time % this.config.updateInterval === 0;

    if (!shouldUpdate) return;

    // Update core telemetry (always)
    this.updateCoreTelemetry(colony, bootstrapCorps, harvestCorps, haulingCorps, upgradingCorps, scoutCorps, constructionCorps);

    // Update nodes telemetry
    this.updateNodesTelemetry(colony);

    // Update edges telemetry (segment 2 - with flow rates)
    this.updateEdgesTelemetry(colony, flowSolution);

    // Update intel telemetry
    this.updateIntelTelemetry();

    // Update corps telemetry
    this.updateCorpsTelemetry(harvestCorps, haulingCorps, upgradingCorps, constructionCorps, spawningCorps);

    // Update chains telemetry (reads from Memory.chains)
    this.updateChainsTelemetry();

    // Update flow telemetry (sources, sinks, allocations)
    this.updateFlowTelemetry(flowSolution);
  }

  /**
   * Updates core telemetry (Segment 0).
   */
  private updateCoreTelemetry(
    colony: Colony | undefined,
    bootstrapCorps: { [roomName: string]: { getCreepCount(): number } },
    harvestCorps: { [sourceId: string]: CreepTrackingCorp },
    haulingCorps: { [roomName: string]: CreepTrackingCorp },
    upgradingCorps: { [roomName: string]: CreepTrackingCorp },
    scoutCorps: { [roomName: string]: { getCreepCount(): number } },
    constructionCorps: { [roomName: string]: CreepTrackingCorp }
  ): void {
    // Count creeps
    let bootstrapCount = 0;
    let minerCount = 0;
    let haulerCount = 0;
    let upgraderCount = 0;
    let scoutCount = 0;
    let builderCount = 0;

    for (const roomName in bootstrapCorps) {
      bootstrapCount += bootstrapCorps[roomName].getCreepCount();
    }
    for (const sourceId in harvestCorps) {
      minerCount += harvestCorps[sourceId].getCreepCount();
    }
    for (const roomName in haulingCorps) {
      haulerCount += haulingCorps[roomName].getCreepCount();
    }
    for (const roomName in upgradingCorps) {
      upgraderCount += upgradingCorps[roomName].getCreepCount();
    }
    for (const roomName in scoutCorps) {
      scoutCount += scoutCorps[roomName].getCreepCount();
    }
    for (const roomName in constructionCorps) {
      builderCount += constructionCorps[roomName].getCreepCount();
    }

    // Get colony stats
    const stats = colony?.getStats() || {
      nodeCount: 0,
      totalCorps: 0,
      activeCorps: 0,
      activeChains: 0,
      totalMinted: 0,
      totalTaxed: 0,
      treasuryBalance: 0,
      averageROI: 0,
    };

    const money = colony?.getMoneySupply() || {
      minted: 0,
      taxed: 0,
      net: 0,
      treasury: 0,
    };

    // Build rooms array
    const rooms: CoreTelemetry["rooms"] = [];
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (room.controller?.my) {
        rooms.push({
          name: roomName,
          rcl: room.controller.level,
          rclProgress: room.controller.progress,
          rclProgressTotal: room.controller.progressTotal,
          energyAvailable: room.energyAvailable,
          energyCapacity: room.energyCapacityAvailable,
        });
      }
    }

    const telemetry: CoreTelemetry = {
      version: 1,
      tick: Game.time,
      shard: Game.shard?.name || "shard0",
      cpu: {
        used: Game.cpu.getUsed(),
        limit: Game.cpu.limit,
        bucket: Game.cpu.bucket,
        tickLimit: Game.cpu.tickLimit,
      },
      gcl: {
        level: Game.gcl.level,
        progress: Game.gcl.progress,
        progressTotal: Game.gcl.progressTotal,
      },
      colony: {
        nodeCount: stats.nodeCount,
        totalCorps: stats.totalCorps,
        activeCorps: stats.activeCorps,
        activeChains: stats.activeChains,
        averageROI: stats.averageROI,
      },
      money: {
        treasury: money.treasury,
        minted: money.minted,
        taxed: money.taxed,
        net: money.net,
      },
      creeps: {
        total: Object.keys(Game.creeps).length,
        bootstrap: bootstrapCount,
        miners: minerCount,
        haulers: haulerCount,
        upgraders: upgraderCount,
        scouts: scoutCount,
        builders: builderCount,
      },
      rooms,
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.CORE] = JSON.stringify(telemetry);
  }

  /**
   * Updates nodes telemetry (Segment 1).
   * Uses compact keys to fit more nodes in the 100KB segment limit.
   */
  private updateNodesTelemetry(colony: Colony | undefined): void {
    const nodes = colony?.getNodes() || [];

    // Calculate summary stats from full node list
    const ownedNodes = nodes.filter(n => n.roi?.isOwned).length;
    const expansionCandidates = nodes.filter(n => !n.roi?.isOwned && (n.roi?.score || 0) > 0).length;
    const totalSources = nodes.reduce((sum, n) => sum + (n.roi?.sourceCount || 0), 0);
    const avgROI = nodes.length > 0
      ? nodes.reduce((sum, n) => sum + (n.roi?.score || 0), 0) / nodes.length
      : 0;

    // Sort nodes: owned first, then by ROI score descending
    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.roi?.isOwned && !b.roi?.isOwned) return -1;
      if (!a.roi?.isOwned && b.roi?.isOwned) return 1;
      return (b.roi?.score || 0) - (a.roi?.score || 0);
    });

    // Build set of economic node IDs (nodes that appear in economic edges)
    const econNodeIds = new Set<string>();
    for (const edge of Object.keys(Memory.economicEdges || {})) {
      const [id1, id2] = edge.split("|");
      econNodeIds.add(id1);
      econNodeIds.add(id2);
    }

    // Count spawn structures per room
    const spawnCountsByRoom: { [roomName: string]: number } = {};
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (room.controller?.my) {
        const spawns = room.find(FIND_MY_SPAWNS);
        if (spawns.length > 0) {
          spawnCountsByRoom[roomName] = spawns.length;
        }
      }
    }

    // Build compact node data
    const nodeData: NodeTelemetry["nodes"] = sortedNodes.map(node => ({
      id: node.id,
      r: node.roomName,
      p: { x: node.peakPosition.x, y: node.peakPosition.y, r: node.peakPosition.roomName },
      t: node.territorySize,
      res: node.resources.map(r => ({
        t: r.type,
        x: r.position.x,
        y: r.position.y,
      })),
      roi: node.roi ? {
        s: node.roi.score,
        e: node.roi.expansionScore,
        o: node.roi.openness,
        d: node.roi.distanceFromOwned,
        own: node.roi.isOwned,
        src: node.roi.sourceCount,
        ctrl: node.roi.hasController,
      } : undefined,
      spans: node.spansRooms,
      econ: econNodeIds.has(node.id) || undefined,
      sp: spawnCountsByRoom[node.roomName] || undefined,
    }));

    const telemetry: NodeTelemetry = {
      version: 5,  // Version 5: edges moved to segment 2
      tick: Game.time,
      nodes: nodeData,
      summary: {
        totalNodes: nodes.length,
        ownedNodes,
        expansionCandidates,
        totalSources,
        avgROI,
      },
    };

    const json = JSON.stringify(telemetry);
    if (json.length > 100000) {
      console.log(`[Telemetry] Warning: Node segment ${json.length} bytes exceeds 100KB limit`);
    }
    RawMemory.segments[TELEMETRY_SEGMENTS.NODES] = json;
  }

  /**
   * Updates edges telemetry (Segment 2).
   * Uses compressed numeric format: edges as index pairs instead of string IDs.
   * Includes flow rates from flow solution when available.
   */
  private updateEdgesTelemetry(colony: Colony | undefined, flowSolution?: FlowSolution): void {
    const nodes = colony?.getNodes() || [];

    // Build node ID to index map (sorted same as nodes telemetry)
    const sortedNodes = [...nodes].sort((a, b) => {
      if (a.roi?.isOwned && !b.roi?.isOwned) return -1;
      if (!a.roi?.isOwned && b.roi?.isOwned) return 1;
      return (b.roi?.score || 0) - (a.roi?.score || 0);
    });

    const nodeIdToIndex = new Map<string, number>();
    const nodeIndex: string[] = [];
    sortedNodes.forEach((node, idx) => {
      nodeIdToIndex.set(node.id, idx);
      nodeIndex.push(node.id);
    });

    // Build flow rate map from hauler assignments (edge key → total flow rate)
    const flowRateByEdge = new Map<string, number>();
    if (flowSolution) {
      for (const hauler of flowSolution.haulers) {
        // Extract node IDs from flow IDs (e.g., "source-abc|sink-xyz" or use fromId/toId)
        const fromNodeId = this.extractNodeId(hauler.fromId);
        const toNodeId = this.extractNodeId(hauler.toId);
        if (fromNodeId && toNodeId) {
          // Create consistent edge key (sorted alphabetically)
          const edgeKey = [fromNodeId, toNodeId].sort().join("|");
          const existing = flowRateByEdge.get(edgeKey) || 0;
          flowRateByEdge.set(edgeKey, existing + hauler.flowRate);
        }
      }
    }

    // Convert spatial edges to index pairs
    const edges: [number, number][] = [];
    for (const edge of Memory.nodeEdges || []) {
      const [id1, id2] = edge.split("|");
      const idx1 = nodeIdToIndex.get(id1);
      const idx2 = nodeIdToIndex.get(id2);
      if (idx1 !== undefined && idx2 !== undefined) {
        edges.push([idx1, idx2]);
      }
    }

    // Convert economic edges to index tuples with distance and optional flow rate
    const economicEdges: [number, number, number, number?][] = [];
    for (const [edge, distance] of Object.entries(Memory.economicEdges || {})) {
      const [id1, id2] = edge.split("|");
      const idx1 = nodeIdToIndex.get(id1);
      const idx2 = nodeIdToIndex.get(id2);
      if (idx1 !== undefined && idx2 !== undefined) {
        const flowRate = flowRateByEdge.get(edge);
        if (flowRate !== undefined && flowRate > 0) {
          economicEdges.push([idx1, idx2, distance, flowRate]);
        } else {
          economicEdges.push([idx1, idx2, distance]);
        }
      }
    }

    const telemetry: EdgesTelemetry = {
      version: 2,  // Version 2: includes flow rates
      tick: Game.time,
      nodeIndex,
      edges,
      economicEdges,
    };

    const json = JSON.stringify(telemetry);
    if (json.length > 100000) {
      console.log(`[Telemetry] Warning: Edges segment ${json.length} bytes exceeds 100KB limit`);
    }
    RawMemory.segments[TELEMETRY_SEGMENTS.EDGES] = json;
  }

  /**
   * Extract node ID from a flow ID (e.g., "source-abc123" → node ID from Memory).
   * Flow IDs reference game objects; we need to map them back to nodes.
   */
  private extractNodeId(flowId: string): string | undefined {
    // For sources: "source-{gameId}" → find node containing this source
    // For sinks: "spawn-{gameId}" or "controller-{gameId}" → find node
    // This is a simplified mapping - in practice, we'd need the flow graph's node mappings

    // Try to find the node by checking if any node's ID matches or contains the source/sink
    // For now, return undefined and rely on economicEdges which already have node-to-node mappings
    return undefined;
  }

  /**
   * Updates intel telemetry (Segment 3).
   */
  private updateIntelTelemetry(): void {
    const rooms: IntelTelemetry["rooms"] = [];

    if (Memory.roomIntel) {
      for (const roomName in Memory.roomIntel) {
        const intel = Memory.roomIntel[roomName];
        rooms.push({
          name: roomName,
          lastVisit: intel.lastVisit,
          sourceCount: intel.sourceCount,
          sourcePositions: intel.sourcePositions,
          mineralType: intel.mineralType,
          mineralPos: intel.mineralPos,
          controllerLevel: intel.controllerLevel,
          controllerPos: intel.controllerPos,
          controllerOwner: intel.controllerOwner,
          controllerReservation: intel.controllerReservation,
          hostileCreepCount: intel.hostileCreepCount,
          hostileStructureCount: intel.hostileStructureCount,
          isSafe: intel.isSafe,
        });
      }
    }

    const telemetry: IntelTelemetry = {
      version: 1,
      tick: Game.time,
      rooms,
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.INTEL] = JSON.stringify(telemetry);
  }

  /**
   * Updates corps telemetry (Segment 4).
   */
  private updateCorpsTelemetry(
    harvestCorps: { [sourceId: string]: CreepTrackingCorp },
    haulingCorps: { [roomName: string]: CreepTrackingCorp },
    upgradingCorps: { [roomName: string]: CreepTrackingCorp },
    constructionCorps: { [roomName: string]: CreepTrackingCorp },
    spawningCorps: { [spawnId: string]: SpawningCorpLike }
  ): void {
    const corps: CorpsTelemetry["corps"] = [];
    const corpsByType: { [type: string]: number } = {};

    const addCorp = (corp: CreepTrackingCorp, roomName: string) => {
      const profit = corp.totalRevenue - corp.totalCost;
      const roi = corp.totalCost > 0 ? profit / corp.totalCost : 0;

      corps.push({
        id: corp.id,
        type: corp.type,
        nodeId: corp.nodeId || "",
        roomName,
        balance: corp.balance,
        totalRevenue: corp.totalRevenue,
        totalCost: corp.totalCost,
        profit,
        roi,
        isActive: corp.isActive,
        creepCount: corp.getCreepCount(),
        createdAt: corp.createdAt,
        lastActivityTick: corp.lastActivityTick,
      });

      corpsByType[corp.type] = (corpsByType[corp.type] || 0) + 1;
    };

    // Add mining corps
    for (const sourceId in harvestCorps) {
      const corp = harvestCorps[sourceId];
      // Extract room from source ID (format is like "xxxxRoomName")
      const roomName = Object.keys(Game.rooms).find(r =>
        Game.rooms[r].find(FIND_SOURCES).some(s => s.id === sourceId)
      ) || "unknown";
      addCorp(corp, roomName);
    }

    // Add hauling corps
    for (const roomName in haulingCorps) {
      addCorp(haulingCorps[roomName], roomName);
    }

    // Add upgrading corps
    for (const roomName in upgradingCorps) {
      addCorp(upgradingCorps[roomName], roomName);
    }

    // Add construction corps
    for (const roomName in constructionCorps) {
      addCorp(constructionCorps[roomName], roomName);
    }

    // Add spawning corps
    for (const spawnId in spawningCorps) {
      const corp = spawningCorps[spawnId];
      const profit = corp.totalRevenue - corp.totalCost;
      const roi = corp.totalCost > 0 ? profit / corp.totalCost : 0;
      // Extract room from nodeId (format: "E75N8-spawn-xxxx")
      const roomName = corp.nodeId.split("-")[0] || "unknown";

      corps.push({
        id: corp.id,
        type: corp.type,
        nodeId: corp.nodeId || "",
        roomName,
        balance: corp.balance,
        totalRevenue: corp.totalRevenue,
        totalCost: corp.totalCost,
        profit,
        roi,
        isActive: corp.isActive,
        creepCount: corp.getPendingOrderCount(), // Show pending orders as "creepCount"
        createdAt: corp.createdAt,
        lastActivityTick: corp.lastActivityTick,
      });

      corpsByType[corp.type] = (corpsByType[corp.type] || 0) + 1;
    }

    const totalBalance = corps.reduce((sum, c) => sum + c.balance, 0);
    const avgProfit = corps.length > 0
      ? corps.reduce((sum, c) => sum + c.profit, 0) / corps.length
      : 0;

    const telemetry: CorpsTelemetry = {
      version: 1,
      tick: Game.time,
      corps,
      summary: {
        totalCorps: corps.length,
        activeCorps: corps.filter(c => c.isActive).length,
        totalBalance,
        avgProfit,
        corpsByType,
      },
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.CORPS] = JSON.stringify(telemetry);
  }

  /**
   * Updates chains telemetry (Segment 5).
   * Reads from Memory.chains (latest planned chains from ChainPlanner).
   */
  private updateChainsTelemetry(): void {
    // Load chains from Memory (populated by ChainPlanner during planning phase)
    const memoryChains = Memory.chains || {};
    const plannedChains = Object.values(memoryChains).map((data: SerializedChain) =>
      deserializeChain(data)
    );

    const chains: ChainsTelemetry["chains"] = plannedChains.map(chain => ({
      id: chain.id,
      funded: chain.funded,
      age: chain.age,
      leafCost: chain.leafCost,
      totalCost: chain.totalCost,
      mintValue: chain.mintValue,
      profit: chain.profit,
      segments: chain.segments.map(seg => ({
        corpType: seg.corpType,
        resource: seg.resource,
        inputCost: seg.inputCost,
        margin: seg.margin,
        outputPrice: seg.outputPrice,
      })),
    }));

    // Sort by profit (highest first)
    chains.sort((a, b) => b.profit - a.profit);

    const fundedChains = chains.filter(c => c.funded).length;
    const totalProfit = chains.reduce((sum, c) => sum + c.profit, 0);
    const avgChainAge = chains.length > 0
      ? chains.reduce((sum, c) => sum + c.age, 0) / chains.length
      : 0;

    const telemetry: ChainsTelemetry = {
      version: 1,
      tick: Game.time,
      chains,
      summary: {
        totalChains: chains.length,
        fundedChains,
        totalProfit,
        avgChainAge,
      },
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.CHAINS] = JSON.stringify(telemetry);
  }

  /**
   * Updates flow telemetry (Segment 6).
   * Shows flow economy state: sources, sinks, and energy allocations.
   */
  private updateFlowTelemetry(flowSolution?: FlowSolution): void {
    // Build source data from miner assignments
    const sources: FlowTelemetry["sources"] = [];
    const sinks: FlowTelemetry["sinks"] = [];

    if (flowSolution) {
      // Collect sources from miner assignments
      for (const miner of flowSolution.miners) {
        sources.push({
          id: miner.sourceId,
          nodeId: miner.nodeId || "",
          harvestRate: miner.harvestRate,
          // Work parts calculated from harvest rate (2 energy/tick per WORK part)
          workParts: Math.ceil(miner.harvestRate / 2),
          efficiency: miner.efficiency,
          spawnDistance: miner.spawnDistance,
        });
      }

      // Collect sinks from sink allocations
      for (const sink of flowSolution.sinkAllocations) {
        sinks.push({
          id: sink.sinkId,
          // nodeId not available in SinkAllocation - could be derived from sinkId if needed
          type: sink.sinkType,
          demand: sink.demand,
          allocated: sink.allocated,
          unmet: sink.unmet,
          priority: sink.priority,
        });
      }
    }

    const telemetry: FlowTelemetry = {
      version: 1,
      tick: Game.time,
      sources,
      sinks,
      summary: flowSolution ? {
        totalHarvest: flowSolution.totalHarvest,
        totalOverhead: flowSolution.totalOverhead,
        netEnergy: flowSolution.netEnergy,
        efficiency: flowSolution.efficiency,
        isSustainable: flowSolution.isSustainable,
        minerCount: flowSolution.miners.length,
        haulerCount: flowSolution.haulers.length,
      } : {
        totalHarvest: 0,
        totalOverhead: 0,
        netEnergy: 0,
        efficiency: 0,
        isSustainable: false,
        minerCount: 0,
        haulerCount: 0,
      },
      warnings: flowSolution?.warnings || [],
    };

    RawMemory.segments[TELEMETRY_SEGMENTS.FLOW] = JSON.stringify(telemetry);
  }
}

/**
 * Global telemetry instance.
 */
let telemetryInstance: Telemetry | null = null;

/**
 * Gets or creates the global telemetry instance.
 */
export function getTelemetry(config?: Partial<TelemetryConfig>): Telemetry {
  if (!telemetryInstance) {
    telemetryInstance = new Telemetry(config);
  }
  return telemetryInstance;
}

/**
 * Reconfigures telemetry with new settings.
 */
export function configureTelemetry(config: Partial<TelemetryConfig>): void {
  telemetryInstance = new Telemetry(config);
}
