export interface ColonyMemory {
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

export interface MarketOrder {
  id: string;
  type: 'buy' | 'sell';
  resourceType: string;
  quantity: number;
  pricePerUnit: number; // ScreepsBucks per unit
  sellerId?: string; // Node/Routine/Agent ID
  buyerId?: string; // Node/Routine/Agent ID
  fulfilled: boolean;
  created: number; // Game time
}

export interface ActionPlan {
  id: string;
  steps: ActionStep[];
  totalValue: number; // Expected ScreepsBucks value
  totalCost: number; // Expected ScreepsBucks cost
  estimatedDuration: number; // Game ticks
  created: number; // Game time
  status: 'pending' | 'executing' | 'completed' | 'failed';
}

export interface ActionStep {
  id: string;
  type: 'spawn_routine' | 'transfer_resource' | 'execute_routine' | 'market_trade';
  nodeId: string;
  routineType?: string;
  resourceType?: string;
  quantity?: number;
  dependencies: string[]; // IDs of steps that must complete first
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
  value?: number; // Expected ScreepsBucks value
  cost?: number; // Expected ScreepsBucks cost
}
