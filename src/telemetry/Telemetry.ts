/**
 * @fileoverview Telemetry system for exporting game data to RawMemory segments.
 *
 * This module writes telemetry data to RawMemory segments each tick (or periodically),
 * enabling an external app to poll the Screeps HTTP API and visualize colony state.
 *
 * ## Segment Layout
 * - Segment 0: Core telemetry (colony stats, money supply, creep counts)
 * - Segment 1: Node data (territories, resources, ROI)
 * - Segment 2: Room terrain cache (for rooms with vision or intel)
 * - Segment 3: Room intel data (scouted room information)
 * - Segment 4: Corps data (mining, hauling, upgrading corps)
 * - Segment 5: Active chains data
 *
 * ## Data Flow
 * Screeps Game → RawMemory.segments[N] → HTTP API → External App → Dashboard
 *
 * @module telemetry/Telemetry
 */

import { Colony } from "../colony/Colony";
import { Node, SerializedNode } from "../nodes/Node";
import { Corp } from "../corps/Corp";

/**
 * Interface for corps that track creeps.
 */
interface CreepTrackingCorp extends Corp {
  getCreepCount(): number;
}

/**
 * Segment assignments for telemetry data.
 */
export const TELEMETRY_SEGMENTS = {
  CORE: 0,      // Colony stats, money supply, creep counts
  NODES: 1,     // Node territories, resources, ROI
  TERRAIN: 2,   // Room terrain data
  INTEL: 3,     // Room intel from scouting
  CORPS: 4,     // Corps details
  CHAINS: 5,    // Active chains
};

/**
 * Segments to make publicly readable via API.
 */
export const PUBLIC_SEGMENTS = [0, 1, 2, 3, 4, 5];

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
      o: number;   // openness
      d: number;   // distanceFromOwned
      own: boolean;  // isOwned
      src: number;   // sourceCount
      ctrl: boolean; // hasController
    };
    spans: string[];  // spansRooms
  }[];
  /** Spatial edges between nodes (adjacent territories). Format: "nodeId1|nodeId2" */
  edges: string[];
  /** Economic edges between corp-hosting nodes. Format: "nodeId1|nodeId2" */
  economicEdges: string[];
  summary: {
    totalNodes: number;
    ownedNodes: number;
    expansionCandidates: number;
    totalSources: number;
    avgROI: number;
  };
}

/**
 * Terrain telemetry data structure (Segment 2).
 * Terrain data is encoded efficiently: 0=plain, 1=wall, 2=swamp
 */
export interface TerrainTelemetry {
  version: number;
  tick: number;
  rooms: {
    name: string;
    /** Base64-encoded terrain data (2500 bytes = 50x50 tiles) */
    terrain: string;
    /** Last update tick */
    cachedAt: number;
  }[];
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
    miningCorps: { [sourceId: string]: CreepTrackingCorp },
    haulingCorps: { [roomName: string]: CreepTrackingCorp },
    upgradingCorps: { [roomName: string]: CreepTrackingCorp },
    scoutCorps: { [roomName: string]: { getCreepCount(): number } }
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
    this.updateCoreTelemetry(colony, bootstrapCorps, miningCorps, haulingCorps, upgradingCorps, scoutCorps);

    // Update nodes telemetry
    this.updateNodesTelemetry(colony);

    // Terrain telemetry disabled - too large for 100KB segment limit
    // Clear segment 2 if it has stale data
    RawMemory.segments[TELEMETRY_SEGMENTS.TERRAIN] = "";

    // Update intel telemetry
    this.updateIntelTelemetry();

    // Update corps telemetry
    this.updateCorpsTelemetry(miningCorps, haulingCorps, upgradingCorps);

    // Update chains telemetry
    this.updateChainsTelemetry(colony);
  }

  /**
   * Updates core telemetry (Segment 0).
   */
  private updateCoreTelemetry(
    colony: Colony | undefined,
    bootstrapCorps: { [roomName: string]: { getCreepCount(): number } },
    miningCorps: { [sourceId: string]: CreepTrackingCorp },
    haulingCorps: { [roomName: string]: CreepTrackingCorp },
    upgradingCorps: { [roomName: string]: CreepTrackingCorp },
    scoutCorps: { [roomName: string]: { getCreepCount(): number } }
  ): void {
    // Count creeps
    let bootstrapCount = 0;
    let minerCount = 0;
    let haulerCount = 0;
    let upgraderCount = 0;
    let scoutCount = 0;

    for (const roomName in bootstrapCorps) {
      bootstrapCount += bootstrapCorps[roomName].getCreepCount();
    }
    for (const sourceId in miningCorps) {
      minerCount += miningCorps[sourceId].getCreepCount();
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
        o: node.roi.openness,
        d: node.roi.distanceFromOwned,
        own: node.roi.isOwned,
        src: node.roi.sourceCount,
        ctrl: node.roi.hasController,
      } : undefined,
      spans: node.spansRooms,
    }));

    const telemetry: NodeTelemetry = {
      version: 4,  // Bumped version for economic edges
      tick: Game.time,
      nodes: nodeData,
      edges: Memory.nodeEdges || [],
      economicEdges: Memory.economicEdges || [],
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
    miningCorps: { [sourceId: string]: CreepTrackingCorp },
    haulingCorps: { [roomName: string]: CreepTrackingCorp },
    upgradingCorps: { [roomName: string]: CreepTrackingCorp }
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
    for (const sourceId in miningCorps) {
      const corp = miningCorps[sourceId];
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
   */
  private updateChainsTelemetry(colony: Colony | undefined): void {
    const activeChains = colony?.getActiveChains() || [];

    const chains: ChainsTelemetry["chains"] = activeChains.map(chain => ({
      id: chain.id,
      funded: chain.funded,
      age: chain.age,
      leafCost: chain.leafCost,
      totalCost: chain.totalCost,
      mintValue: chain.mintValue,
      profit: chain.mintValue - chain.totalCost,
      segments: chain.segments.map(seg => ({
        corpType: seg.corpType,
        resource: seg.resource,
        inputCost: seg.inputCost,
        margin: seg.margin,
        outputPrice: seg.outputPrice,
      })),
    }));

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
