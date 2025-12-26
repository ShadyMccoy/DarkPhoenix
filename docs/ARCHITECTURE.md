# Architecture Overview

This document describes the high-level architecture of the DarkPhoenix Screeps AI.

## System Design

DarkPhoenix is built around three core principles:

1. **Flow-Based Resource Allocation** - A centralized solver optimally allocates energy using max-flow min-cost algorithms
2. **Domain-Driven Organization** - Code organized by business domain, not technical concerns
3. **Priority-Weighted Decision Making** - Dynamic priorities direct resources where they're needed most

## Module Structure

```
src/
├── main.ts              # Entry point and game loop
├── core/                # Foundation layer
├── flow/                # Flow-based economy (MFMC solver)
├── corps/               # Business units (Mining, Hauling, etc.)
├── nodes/               # Territory regions
├── spatial/             # Room analysis
├── planning/            # Chain planning
├── types/               # Domain interfaces
└── utils/               # Shared utilities
```

### Flow Layer (`src/flow/`)

The central economic engine using max-flow min-cost allocation.

#### FlowEconomy

Main coordinator replacing the old market system:

- **FlowGraph**: Network of sources, sinks, and edges
- **FlowSolver**: Allocates energy by priority and distance
- **PriorityManager**: Dynamic priority calculation based on game state

```typescript
class FlowEconomy {
  // Called each tick
  update(context: PriorityContext): void {
    // 1. Update sink priorities based on context
    this.graph.updatePriorities(context);

    // 2. Solve flow allocation
    const problem = this.graph.getFlowProblem();
    this.solution = this.solver.solve(problem);
  }

  // Get allocations
  getMinerAssignment(sourceId: string): MinerAssignment | null;
  getHaulerAssignments(nodeId: string): HaulerAssignment[];
  getSinkAllocation(sinkId: string): number;
}
```

#### Flow Types

```typescript
// Energy sources (producers)
interface FlowSource {
  id: string;
  nodeId: string;
  position: Position;
  capacity: number;       // Energy per tick
  assigned: boolean;
}

// Energy sinks (consumers)
interface FlowSink {
  id: string;
  nodeId: string;
  position: Position;
  type: SinkType;
  priority: number;       // 1-100, higher = more important
  demand: number;
  currentAllocation: number;
}

type SinkType =
  | "spawn"          // Critical - priority 100
  | "extension"      // High during spawning
  | "tower"          // High during defense
  | "construction"   // High after RCL-up
  | "controller"     // Normal upgrading
  | "storage";       // Lowest - excess only
```

### Corps Layer (`src/corps/`)

Business units that execute allocated work.

| Corp | Purpose | Resources |
|------|---------|-----------|
| MiningCorp | Source harvesting | FlowSource allocation |
| HaulingCorp | Resource transport | FlowEdge assignments |
| UpgradingCorp | Controller upgrades | Controller sink allocation |
| ConstructionCorp | Structure building | Construction sink allocation |
| SpawningCorp | Creep production | Spawn capacity |
| BootstrapCorp | Emergency fallback | Starvation recovery only |

Each corp receives allocations from the FlowSolver and executes accordingly.

### Nodes Layer (`src/nodes/`)

Territory-based spatial regions derived from peak detection.

```typescript
interface Node {
  id: string;                    // e.g., "W1N1-25-30"
  peakPosition: Position;
  positions: Position[];
  roomName: string;
  resources: NodeResource[];
}
```

### Spatial Layer (`src/spatial/`)

Room analysis and territory management.

#### RoomMap

Provides sophisticated spatial analysis:

1. **Distance Transform** - Calculate openness metrics
2. **Peak Detection** - Find optimal building locations
3. **Territory Division** - Assign tiles to zones

```typescript
interface Peak {
  tiles: RoomPosition[];
  center: RoomPosition;
  height: number;
}

interface Territory {
  peakId: string;
  positions: RoomPosition[];
}
```

### Planning Layer (`src/planning/`)

Chain planning for validating complete production paths.

```typescript
class ChainPlanner {
  // Find chains from sources to sinks
  findViableChains(graph: FlowGraph): Chain[];

  // Validate chain completeness
  isChainComplete(chain: Chain): boolean;
}
```

### Types Layer (`src/types/`)

Domain-specific interfaces.

#### SourceMine

Configuration for mining operations:

```typescript
interface SourceMine {
  sourceId: Id<Source>;
  HarvestPositions: RoomPosition[];
  flow: number;              // Expected energy/tick
  distanceToSpawn: number;
}
```

### Utils Layer (`src/utils/`)

Shared utility functions including ErrorMapper for error handling.

## Execution Flow

### Per-Tick Lifecycle

```
1. Game Loop Start
   │
2. For Each Room:
   ├── Build/Update FlowGraph
   │   ├── Discover sources
   │   ├── Discover sinks (spawn, controller, sites)
   │   └── Build edges with distances
   │
   ├── Update Priorities (PriorityManager)
   │   ├── Check threat level → tower priority
   │   ├── Check construction sites → build priority
   │   ├── Check spawn queue → extension priority
   │   └── Check downgrade timer → controller priority
   │
   ├── Solve Flow Allocation (FlowSolver)
   │   ├── Calculate total production capacity
   │   ├── Calculate overhead (miners + haulers)
   │   ├── Allocate by priority (greedy)
   │   └── Return assignments
   │
   ├── Execute Corps
   │   ├── MiningCorp.work() - harvest assigned sources
   │   ├── HaulingCorp.work() - transport on assigned edges
   │   ├── UpgradingCorp.work() - upgrade with allocation
   │   └── ConstructionCorp.work() - build with allocation
   │
   └── Update RoomMap (every 100 ticks)
   │
3. Clean Dead Creep Memory
   │
4. Game Loop End
```

### Priority-Based Allocation

```typescript
// Example priority context
context = {
  rcl: 3,
  constructionSites: 5,
  hostileCreeps: 0,
  spawnQueue: 2
}

// Results in priorities:
priorities = {
  spawn: 100,        // Always critical
  extension: 90,     // High - spawns queued
  construction: 80,  // High - sites exist
  controller: 10,    // Low - building phase
  storage: 5         // Lowest
}

// Energy flows accordingly:
// Spawn: 15%, Extensions: 25%, Construction: 50%, Controller: 10%
```

## Memory Architecture

### Room Memory

```typescript
Memory.rooms[roomName] = {
  flowGraph: FlowGraphState,
  corps: CorpState[],
  nodes: NodeState[]
}
```

### Creep Memory

```typescript
Memory.creeps[creepName] = {
  role: string,
  corpId: string,
  assignment: string  // Source/edge/sink ID
}
```

## Caching Strategy

### RoomMap Cache

Spatial analysis is expensive. RoomMaps are cached:

```typescript
const roomMapCache: { [roomName: string]: { map: RoomMap, tick: number } };
const ROOM_MAP_CACHE_TTL = 100; // Recalculate every 100 ticks
```

### Flow Solution Cache

Flow solutions are recalculated when:
- Priority context changes significantly
- Sources/sinks are added or removed
- Every N ticks as a fallback

## Extension Points

### Adding a New Sink Type

1. Add to `SinkType` union
2. Update `PriorityManager.calculatePriorities()`
3. Update `FlowGraph.discoverSinks()`
4. Create corresponding Corp if needed

### Adding a New Corp

1. Create class in `src/corps/`
2. Implement `work()` to execute allocated resources
3. Register with FlowEconomy

## Design Decisions

### Why Flow-Based Over Market-Based

**Problem**: Market-based systems have circular dependencies (corps need energy to make offers, offers need corps) and slow price discovery.

**Solution**: Single equilibrium solve considers all flows together. No bootstrapping problem.

### Why Priority Weights Over Price Signals

**Problem**: Price discovery is slow and can be unstable.

**Solution**: Explicit priority values enable instant response to state changes (defense, RCL-up, etc.).

### Why Centralized Solver

**Problem**: Local decisions (each corp optimizing independently) miss global optimization opportunities.

**Solution**: FlowSolver considers all sources, sinks, and edges together for optimal allocation.

### Why Spatial Peaks

**Problem**: Optimal base placement is non-obvious and room-dependent.

**Solution**: Distance transform identifies mathematically optimal open areas.

### Why Territory-Based Nodes

**Problem**: Room boundaries are arbitrary game constraints.

**Solution**: Territories reflect actual spatial structure. Remote mining is "just another territory."
