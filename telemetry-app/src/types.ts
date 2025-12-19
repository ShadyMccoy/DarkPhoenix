/**
 * Telemetry data types.
 * These mirror the types exported from the game code.
 */

/**
 * Segment assignments for telemetry data.
 */
export const TELEMETRY_SEGMENTS = {
  CORE: 0,
  NODES: 1,
  TERRAIN: 2,
  INTEL: 3,
  CORPS: 4,
  CHAINS: 5,
};

/**
 * Core telemetry data structure (Segment 0).
 */
export interface CoreTelemetry {
  version: number;
  tick: number;
  shard: string;
  cpu: {
    used: number;
    limit: number;
    bucket: number;
    tickLimit: number;
  };
  gcl: {
    level: number;
    progress: number;
    progressTotal: number;
  };
  colony: {
    nodeCount: number;
    totalCorps: number;
    activeCorps: number;
    activeChains: number;
    averageROI: number;
  };
  money: {
    treasury: number;
    minted: number;
    taxed: number;
    net: number;
  };
  creeps: {
    total: number;
    bootstrap: number;
    miners: number;
    haulers: number;
    upgraders: number;
    scouts: number;
  };
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
 */
export interface NodeTelemetry {
  version: number;
  tick: number;
  nodes: {
    id: string;
    roomName: string;
    peakPosition: { x: number; y: number; roomName: string };
    territorySize: number;
    /** Territory positions grouped by room */
    territory: { [roomName: string]: { x: number; y: number }[] };
    resources: {
      type: string;
      id: string;
      position: { x: number; y: number; roomName: string };
      capacity?: number;
      level?: number;
      mineralType?: string;
    }[];
    roi?: {
      score: number;
      rawCorpROI: number;
      openness: number;
      distanceFromOwned: number;
      isOwned: boolean;
      sourceCount: number;
      hasController: boolean;
      potentialCorps: { type: string; estimatedROI: number; resourceId: string }[];
    };
    corpIds: string[];
    spansRooms: string[];
  }[];
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
 */
export interface TerrainTelemetry {
  version: number;
  tick: number;
  rooms: {
    name: string;
    terrain: string;
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
 * All telemetry data combined.
 */
export interface AllTelemetry {
  core: CoreTelemetry | null;
  nodes: NodeTelemetry | null;
  terrain: TerrainTelemetry | null;
  intel: IntelTelemetry | null;
  corps: CorpsTelemetry | null;
  chains: ChainsTelemetry | null;
  lastUpdate: number;
}
