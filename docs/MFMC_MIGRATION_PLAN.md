# MFMC Migration Plan: Market → Flow-Based Economy

## Overview

Replace the offer/contract market system with a **weighted flow allocation** model while preserving:
- ✅ Skeletonization (spatial analysis, peaks, territories)
- ✅ Econ Node Graph (Node, NodeNavigator)
- ❌ Market (Offer, Contract, price matching) → **REPLACE**

## Current vs New Architecture

```
CURRENT (Market-based):
┌──────────────────────────────────────────────────────────────────────┐
│  Spatial          Nodes           Corps            Market            │
│  ────────         ─────           ─────            ──────            │
│  Peaks      →     Node      →     MiningCorp   →   Offer (sell)      │
│  Territories      Navigator       SpawningCorp     Offer (buy)       │
│  Adjacencies      Surveyor        UpgradeCorp      Contract          │
│                                   HaulingCorp      Transaction       │
│                                                                      │
│  Problems:                                                           │
│  - Circular: corps need energy to make offers, offers need corps     │
│  - Price discovery is slow and unstable                              │
│  - No global optimization (local decisions only)                     │
└──────────────────────────────────────────────────────────────────────┘

NEW (Flow-based):
┌──────────────────────────────────────────────────────────────────────┐
│  Spatial          Nodes           FlowNetwork      Allocation        │
│  ────────         ─────           ───────────      ──────────        │
│  Peaks      →     Node      →     Sources    →     FlowSolver        │
│  Territories      Navigator       Sinks            ├─ Miner counts   │
│  Adjacencies      (KEEP)          Edges            ├─ Hauler counts  │
│                                   Weights          ├─ Upgrade rates  │
│                                   Priorities       └─ Build rates    │
│                                                                      │
│  Benefits:                                                           │
│  - Single equilibrium solve (no circular dependency)                 │
│  - Global optimization (all flows considered together)               │
│  - Priority-based allocation (RCL-up, defense, etc.)                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Core Flow Types (New Files)

### 1.1 Create `src/flow/FlowTypes.ts`

```typescript
// Energy sources (producers)
interface FlowSource {
  id: string;                    // "source-{gameId}"
  nodeId: string;                // Territory node containing this source
  position: Position;
  capacity: number;              // 10 energy/tick (3000/300)
  assigned: boolean;             // Has miner assigned?
}

// Energy sinks (consumers) - replaces "Corps buying energy"
interface FlowSink {
  id: string;                    // "spawn-{id}", "controller-{id}", "site-{id}"
  nodeId: string;                // Territory node
  position: Position;
  type: SinkType;
  priority: number;              // 1-100, higher = more important
  demand: number;                // Energy needed per tick
  capacity: number;              // Max energy can accept per tick
  currentAllocation: number;     // Allocated by solver
}

type SinkType =
  | "spawn"          // Spawn overhead (CRITICAL - priority 100)
  | "extension"      // Extension fill (HIGH during spawning)
  | "tower"          // Tower energy (HIGH during defense)
  | "construction"   // Build sites (HIGH after RCL-up)
  | "controller"     // Upgrading (NORMAL, LOW during build phase)
  | "terminal"       // Terminal ops (LOW)
  | "link"           // Link network (varies)
  | "storage";       // Storage buffer (LOWEST - excess only)

// Flow edge (transport capacity)
interface FlowEdge {
  id: string;                    // "{fromId}|{toId}"
  fromId: string;                // Source or intermediate node
  toId: string;                  // Sink or intermediate node
  distance: number;              // Walking distance (Chebyshev)
  carryCapacity: number;         // CARRY parts allocated
  flowRate: number;              // Energy/tick through this edge
  costPerEnergy: number;         // Spawn cost per energy unit transported
}
```

### 1.2 Create `src/flow/FlowGraph.ts`

```typescript
// The main flow network - built from spatial nodes
class FlowGraph {
  private sources: Map<string, FlowSource>;
  private sinks: Map<string, FlowSink>;
  private edges: Map<string, FlowEdge>;
  private navigator: NodeNavigator;  // REUSE existing

  constructor(nodes: Node[], navigator: NodeNavigator) {
    this.navigator = navigator;
    this.discoverSources(nodes);
    this.discoverSinks(nodes);
    this.buildEdges();
  }

  // Find all sources in all nodes
  private discoverSources(nodes: Node[]): void;

  // Find all potential sinks in all nodes
  private discoverSinks(nodes: Node[]): void;

  // Build edges: source→sink via node graph
  private buildEdges(): void;

  // Update sink priorities (called on state changes)
  updatePriorities(context: PriorityContext): void;

  // Get current graph state for solver
  getFlowProblem(): FlowProblem;
}
```

---

## Phase 2: Flow Solver (Replaces Market Clearing)

### 2.1 Create `src/flow/FlowSolver.ts`

```typescript
interface FlowProblem {
  sources: FlowSource[];
  sinks: FlowSink[];
  edges: FlowEdge[];
  constraints: FlowConstraints;
}

interface FlowConstraints {
  maxMinersPerSource: number;     // Usually 1
  maxCarryPartsPerEdge: number;   // Creep size limit
  minControllerUpgrade: number;   // Prevent downgrade
}

interface FlowSolution {
  // Allocations
  minerAssignments: MinerAssignment[];
  haulerAssignments: HaulerAssignment[];
  sinkAllocations: SinkAllocation[];

  // Metrics
  totalHarvest: number;
  totalOverhead: number;
  netEnergy: number;
  efficiency: number;
  unmetDemand: Map<string, number>;

  // Validation
  isSustainable: boolean;
  warnings: string[];
}

class FlowSolver {
  // Main solve function - replaces Market.clear()
  solve(problem: FlowProblem): FlowSolution {
    // 1. Calculate total production capacity
    // 2. Calculate overhead (miners + haulers)
    // 3. Allocate remaining energy to sinks by priority
    // 4. Verify sustainability
    // 5. Return assignments
  }

  // Greedy allocation by priority (from our demo)
  private allocateBySinkPriority(
    availableEnergy: number,
    sinks: FlowSink[],
    edges: FlowEdge[]
  ): SinkAllocation[];

  // Calculate hauler requirements for a flow
  private calculateHaulerCost(
    amount: number,
    distance: number
  ): { carryParts: number; spawnCost: number };
}
```

---

## Phase 3: Priority Manager (Dynamic Weights)

### 3.1 Create `src/flow/PriorityManager.ts`

```typescript
interface PriorityContext {
  tick: number;
  rcl: number;
  rclProgress: number;           // 0-1 progress to next RCL
  constructionSites: number;     // Active build sites
  hostileCreeps: number;         // Threat level
  storageEnergy: number;         // Buffer level
  spawnQueue: number;            // Pending spawns
}

class PriorityManager {
  // Calculate sink priorities based on game state
  calculatePriorities(context: PriorityContext): Map<SinkType, number> {
    const priorities = new Map<SinkType, number>();

    // ALWAYS critical
    priorities.set("spawn", 100);

    // Defense takes priority when threatened
    if (context.hostileCreeps > 0) {
      priorities.set("tower", 95);
    } else {
      priorities.set("tower", 30);
    }

    // Building phase after RCL-up
    if (context.constructionSites > 0) {
      priorities.set("construction", 80);
      priorities.set("controller", 10);  // Pause upgrading
    } else {
      priorities.set("construction", 0);
      priorities.set("controller", 70);  // Normal upgrading
    }

    // Extensions needed for spawning
    if (context.spawnQueue > 0) {
      priorities.set("extension", 90);
    } else {
      priorities.set("extension", 50);
    }

    // Storage is a low-priority buffer
    priorities.set("storage", 5);

    return priorities;
  }

  // Get priority for specific sink
  getSinkPriority(sink: FlowSink, context: PriorityContext): number;
}
```

---

## Phase 4: Integration Layer

### 4.1 Create `src/flow/FlowEconomy.ts` (Main Entry Point)

```typescript
// Replaces Market as the central economy coordinator
class FlowEconomy {
  private graph: FlowGraph;
  private solver: FlowSolver;
  private priorityManager: PriorityManager;
  private solution: FlowSolution | null;

  constructor(
    nodes: Node[],           // From existing Node system (KEEP)
    navigator: NodeNavigator // From existing (KEEP)
  ) {
    this.graph = new FlowGraph(nodes, navigator);
    this.solver = new FlowSolver();
    this.priorityManager = new PriorityManager();
  }

  // Called each tick (or when state changes)
  update(context: PriorityContext): void {
    // 1. Update sink priorities based on context
    this.graph.updatePriorities(context);

    // 2. Solve flow allocation
    const problem = this.graph.getFlowProblem();
    this.solution = this.solver.solve(problem);

    // 3. Log warnings
    for (const warning of this.solution.warnings) {
      console.log(`[FlowEconomy] ${warning}`);
    }
  }

  // Get current allocation for a specific creep type
  getMinerAssignment(sourceId: string): MinerAssignment | null;
  getHaulerAssignments(nodeId: string): HaulerAssignment[];

  // Get energy allocation for a sink
  getSinkAllocation(sinkId: string): number;

  // Metrics
  getEfficiency(): number;
  getTotalUpgradeRate(): number;
  getUnmetDemand(): Map<string, number>;
}
```

### 4.2 Create `src/flow/index.ts`

```typescript
export { FlowGraph } from './FlowGraph';
export { FlowSolver, FlowSolution, FlowProblem } from './FlowSolver';
export { PriorityManager, PriorityContext } from './PriorityManager';
export { FlowEconomy } from './FlowEconomy';
export * from './FlowTypes';
```

---

## Phase 5: Migration Steps

### Step 1: Parallel Implementation
- Create `src/flow/` directory with new files
- Keep `src/market/` intact during development
- Add feature flag: `USE_FLOW_ECONOMY`

### Step 2: Bridge Layer
```typescript
// Temporary bridge that can use either system
class EconomyBridge {
  private market: Market;        // Old system
  private flowEconomy: FlowEconomy;  // New system
  private useFlow: boolean;

  getEnergyAllocation(sinkId: string): number {
    if (this.useFlow) {
      return this.flowEconomy.getSinkAllocation(sinkId);
    } else {
      // Legacy: look up from market contracts
      return this.market.getContractedEnergy(sinkId);
    }
  }
}
```

### Step 3: Creep Behavior Updates
- Miners: Get assignment from `FlowEconomy.getMinerAssignment()`
- Haulers: Get routes from `FlowEconomy.getHaulerAssignments()`
- Upgraders: Get allocation from `FlowEconomy.getSinkAllocation("controller-{id}")`
- Builders: Get allocation from `FlowEconomy.getSinkAllocation("construction-{id}")`

### Step 4: Remove Market
- Delete `src/market/` once flow system is validated
- Remove Corps that were only needed for market offers
- Simplify creep spawning logic

---

## Phase 6: File Changes Summary

### New Files (`src/flow/`)
```
src/flow/
├── index.ts              # Exports
├── FlowTypes.ts          # Core interfaces
├── FlowGraph.ts          # Flow network from nodes
├── FlowSolver.ts         # Allocation algorithm
├── PriorityManager.ts    # Dynamic priority calculation
└── FlowEconomy.ts        # Main coordinator (replaces Market)
```

### Modified Files
```
src/nodes/Node.ts         # Add resource discovery helpers
src/nodes/NodeNavigator.ts # Add distance queries for flow edges
src/framework/*           # Eventually remove (replaced by flow/)
```

### Deleted Files (After Migration)
```
src/market/
├── Market.ts             # Replaced by FlowEconomy
├── Offer.ts              # No longer needed
├── Contract.ts           # No longer needed
└── CapitalBudget.ts      # Absorbed into FlowSolver
```

---

## Key Differences: Market vs Flow

| Aspect | Market (Current) | Flow (New) |
|--------|------------------|------------|
| **Decision making** | Local (each corp decides) | Global (solver optimizes all) |
| **Energy allocation** | Via price matching | Via priority + distance |
| **Bootstrap problem** | Iterative convergence | Single solve |
| **Priority handling** | Implicit in bid prices | Explicit priority values |
| **State changes** | Slow (price discovery) | Instant (re-solve) |
| **Complexity** | O(offers²) matching | O(sources × sinks) |

---

## Example: RCL-Up Scenario

```typescript
// Before RCL-up
context = { rcl: 2, constructionSites: 0, ... }
priorities = { spawn: 100, controller: 70, construction: 0 }
→ Energy flows: Spawn 15%, Controller 85%

// After RCL-up (5 extension sites appear)
context = { rcl: 3, constructionSites: 5, ... }
priorities = { spawn: 100, construction: 80, controller: 10 }
→ Energy flows: Spawn 15%, Construction 60%, Controller 25%

// After construction complete
context = { rcl: 3, constructionSites: 0, ... }
priorities = { spawn: 100, controller: 70, construction: 0 }
→ Energy flows: Spawn 15%, Controller 85%
```

---

## Testing Strategy

1. **Unit tests**: FlowSolver with known inputs/outputs
2. **Integration tests**: FlowGraph built from real room data
3. **Simulation tests**: Run alongside market, compare allocations
4. **Gradual rollout**: Enable per-room with feature flag

---

## Timeline Estimate

| Phase | Description |
|-------|-------------|
| Phase 1 | Core types and FlowGraph |
| Phase 2 | FlowSolver implementation |
| Phase 3 | PriorityManager |
| Phase 4 | FlowEconomy integration |
| Phase 5 | Migration bridge, testing |
| Phase 6 | Remove market, cleanup |
