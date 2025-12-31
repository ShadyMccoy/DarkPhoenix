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
  EDGES: 2,    // Spatial and economic edges with flow rates
  INTEL: 3,
  CORPS: 4,
  CHAINS: 5,
  FLOW: 6,     // Flow economy: sources, sinks, allocations
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
  /** Economic edges between nodes with resources. Format: "nodeId1|nodeId2" -> distance */
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
    e?: number;   // expansionScore
    o: number;    // openness
    d: number;    // distanceFromOwned
    own: boolean; // isOwned
    src: number;  // sourceCount
    ctrl: boolean; // hasController
  };
  spans: string[];  // spansRooms
  econ?: boolean;   // is part of economic network
  sp?: number;      // number of spawn structures in this node's room
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
    expansionScore?: number;
    openness: number;
    distanceFromOwned: number;
    isOwned: boolean;
    sourceCount: number;
    hasController: boolean;
  };
  spansRooms: string[];
  econ?: boolean;  // is part of economic network
  spawnCount?: number;  // number of spawn structures in this node's room
}

/**
 * Edges telemetry data structure (Segment 2).
 * Uses compressed numeric format to minimize size.
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
    nodeId?: string;
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
 * All telemetry data combined.
 */
export interface AllTelemetry {
  core: CoreTelemetry | null;
  nodes: NodeTelemetry | null;
  edges: EdgesTelemetry | null;
  intel: IntelTelemetry | null;
  corps: CorpsTelemetry | null;
  chains: ChainsTelemetry | null;
  flow: FlowTelemetry | null;
  lastUpdate: number;
}
