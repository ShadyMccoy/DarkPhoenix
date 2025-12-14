export interface NodeNetworkMemory {
  nodes: {
    [nodeId: string]: {
      pos: RoomPosition;
      height: number;
      territory: RoomPosition[];
      resources: {
        id: Id<Source | Mineral | StructureController>;
        type: "source" | "mineral" | "controller";
        pos: RoomPosition;
      }[];
    };
  };
  edges: {
    [edgeId: string]: {
      from: string;
      to: string;
      path: RoomPosition[];
      cost: number;
      type: "internal" | "external";
    };
  };
}

interface ColonyMemory {
  id: string;
  rootRoomName: string;
  roomNames: string[];
  nodeIds: string[];
  // Resource tracking
  energyLedger: {
    income: number; // Total energy produced
    expenses: number; // Total energy consumed
    net: number; // Net energy balance
    lastUpdate: number; // Game time of last update
  };
  // ROI tracking for different activities
  roiMetrics: {
    [activityType: string]: {
      totalExpectedValue: number;
      totalActualValue: number;
      totalCost: number;
      executionCount: number;
      averageROI: number; // (actual - cost) / cost
    };
  };
  // Action planning queue
  actionQueue: {
    priority: number;
    type: string;
    nodeId: string;
    routineType: string;
    estimatedValue: number;
    estimatedCost: number;
  }[];
  // Market economy
  screepsBucks: number; // Colony's currency balance
  marketPrices: { [resourceType: string]: number }; // Price per unit in ScreepsBucks
  marketOrders: MarketOrder[]; // Active buy/sell orders
  currentPlan: ActionPlan | null; // Currently executing plan
  lastPlanUpdate: number; // Game time of last plan update
}

interface RoomNode {
  position: {
    x: number;
    y: number;
    roomName: string;
  };
  territory: {
    x: number;
    y: number;
    roomName: string;
  }[];
  resources: {
    id: Id<Source | Mineral | StructureController>;
    type: "source" | "mineral" | "controller";
    pos: {
      x: number;
      y: number;
      roomName: string;
    };
  }[];
}

declare global {
  interface Memory {
    colonies: { [colonyId: string]: ColonyMemory };
    nodeNetwork: NodeNetworkMemory;
    creeps: { [creepName: string]: CreepMemory };
    roomNodes: { [roomName: string]: RoomNode[] };
  }

  interface CreepMemory {
    role?: string;
    nodeId?: string;
    task?: string;
    targetId?: Id<any>;
    busy?: boolean;
    working?: boolean;
    source?: Id<Source>;
    target?: Id<Structure>;
  }
}

export {};
