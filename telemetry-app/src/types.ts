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
 * Version 2 uses compact keys to fit more nodes.
 */
export interface NodeTelemetry {
  version: number;
  tick: number;
  nodes: NodeTelemetryNode[];
  /** Edges between nodes (adjacent territories). Format: "nodeId1|nodeId2" */
  edges: string[];
  summary: {
    totalNodes: number;
    ownedNodes: number;
    expansionCandidates: number;
    totalSources: number;
    avgROI: number;
  };
}

/**
 * Compact node format (version 2).
 * Uses short keys: r=roomName, p=peakPosition, t=territorySize, etc.
 */
export interface NodeTelemetryNodeCompact {
  id: string;
  r: string;  // roomName
  p: { x: number; y: number; r: string };  // peakPosition
  t: number;  // territorySize
  res: { t: string; x: number; y: number }[];  // resources
  roi?: {
    s: number;    // score
    o: number;    // openness
    d: number;    // distanceFromOwned
    own: boolean; // isOwned
    src: number;  // sourceCount
    ctrl: boolean; // hasController
  };
  spans: string[];  // spansRooms
}

/**
 * Normalized node format (for dashboard display).
 */
export interface NodeTelemetryNode {
  id: string;
  roomName: string;
  peakPosition: { x: number; y: number; roomName: string };
  territorySize: number;
  resources: { type: string; x: number; y: number }[];
  roi?: {
    score: number;
    openness: number;
    distanceFromOwned: number;
    isOwned: boolean;
    sourceCount: number;
    hasController: boolean;
  };
  spansRooms: string[];
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
