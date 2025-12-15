# Architecture Overview

This document describes the high-level architecture of the DarkPhoenix Screeps AI.

## System Design

DarkPhoenix is built around three core principles:

1. **Economic Decision Making** - Operations compete for resources through contracts
2. **Domain-Driven Organization** - Code organized by business domain, not technical concerns
3. **Routine-Based Lifecycle** - Consistent execution pattern across all operations

## Module Structure

```
src/
├── main.ts              # Entry point and game loop
├── core/                # Foundation layer
├── routines/            # Business operations
├── spatial/             # Room analysis
├── planning/            # Decision making
├── types/               # Domain interfaces
└── utils/               # Shared utilities
```

### Core Layer (`src/core/`)

The foundation of the routine system.

#### RoomRoutine

Abstract base class providing:

- **Creep Management**: Track and manage assigned creeps by role
- **Spawn Queue**: Request creep spawning with body specifications
- **Economic Contracts**: Requirements/outputs declarations
- **Performance Tracking**: ROI calculation and history
- **Serialization**: Persist/restore state across ticks

```typescript
abstract class RoomRoutine {
  // Lifecycle
  runRoutine(room: Room): void;
  abstract routine(room: Room): void;
  abstract calcSpawnQueue(room: Room): void;

  // Economic
  getRequirements(): ResourceContract[];
  getOutputs(): ResourceContract[];
  getAverageROI(): number;

  // Persistence
  serialize(): any;
  deserialize(data: any): void;
}
```

### Routines Layer (`src/routines/`)

Concrete implementations of colony operations.

| Routine | Purpose | Creep Role |
|---------|---------|------------|
| Bootstrap | Early-game initialization | Jack |
| EnergyMining | Source harvesting | Harvester |
| EnergyCarrying | Resource transport | Carrier |
| Construction | Structure building | Builder |

Each routine is self-contained:
- Owns specific creeps
- Defines its resource contracts
- Manages its own logic
- Tracks its own performance

### Spatial Layer (`src/spatial/`)

Room analysis and territory management.

#### RoomMap

Provides sophisticated spatial analysis:

1. **Distance Transform** - Calculate openness metrics
2. **Peak Detection** - Find optimal building locations
3. **Territory Division** - Assign tiles to zones
4. **Visualization** - Debug overlay rendering

Key interfaces:

```typescript
interface Peak {
  tiles: RoomPosition[];    // All tiles at peak height
  center: RoomPosition;     // Centroid
  height: number;           // Openness value
}

interface Territory {
  peakId: string;
  positions: RoomPosition[];
}
```

### Planning Layer (`src/planning/`)

Goal-Oriented Action Planning (GOAP) framework.

#### Components

- **Action**: Operations with preconditions, effects, and cost
- **Goal**: Desired world states with priorities
- **WorldState**: Current state tracking
- **Agent**: Decision-making entity

```typescript
// Example: Mining action
const harvestAction = new Action(
  'harvest',
  new Map([['atSource', true]]),      // Preconditions
  new Map([['hasEnergy', true]]),     // Effects
  1                                    // Cost
);
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

#### EnergyRoute

Logistics route definition:

```typescript
interface EnergyRoute {
  waypoints: RouteWaypoint[];
  Carriers: CarrierAssignment[];
}
```

### Utils Layer (`src/utils/`)

Shared utility functions.

#### ErrorMapper

Wraps the game loop with error handling:

```typescript
export const loop = ErrorMapper.wrapLoop(() => {
  // Game logic here
});
```

## Execution Flow

### Per-Tick Lifecycle

```
1. Game Loop Start
   │
2. For Each Room:
   ├── Initialize/Deserialize Routines
   │   ├── Bootstrap (always present)
   │   ├── EnergyMining (per source)
   │   └── Construction (per site)
   │
   ├── For Each Routine:
   │   ├── RemoveDeadCreeps()
   │   ├── calcSpawnQueue()
   │   ├── AddNewlySpawnedCreeps()
   │   ├── SpawnCreeps()
   │   ├── calculateExpectedValue()
   │   └── routine()
   │
   ├── Serialize Routines to Memory
   │
   └── Update RoomMap (every 100 ticks)
   │
3. Clean Dead Creep Memory
   │
4. Game Loop End
```

### Routine Lifecycle Detail

```
runRoutine(room)
    │
    ├── RemoveDeadCreeps()
    │   └── Filter out IDs for dead creeps
    │
    ├── calcSpawnQueue(room)
    │   └── Determine needed spawns
    │
    ├── AddNewlySpawnedCreeps(room)
    │   └── Find and assign idle creeps
    │
    ├── SpawnCreeps(room)
    │   └── Execute spawn requests
    │
    ├── calculateExpectedValue()
    │   └── Compute outputs - requirements
    │
    └── routine(room)
        └── Custom behavior logic
```

## Memory Architecture

### Room Memory

```typescript
Memory.rooms[roomName] = {
  routines: {
    bootstrap: [BootstrapState[]],
    energyMines: [EnergyMiningState[]],
    construction: [ConstructionState[]]
  }
}
```

### Creep Memory

```typescript
Memory.creeps[creepName] = {
  role: string  // e.g., "jack", "busyHarvester"
}
```

### Role Naming Convention

| Role | Idle State | Active State |
|------|------------|--------------|
| Jack | `jack` | `busyjack` |
| Harvester | `harvester` | `busyHarvester` |
| Carrier | `carrier` | `busyCarrier` |
| Builder | `builder` | `busyBuilder` |

## Caching Strategy

### RoomMap Cache

Spatial analysis is expensive. RoomMaps are cached:

```typescript
const roomMapCache: { [roomName: string]: { map: RoomMap, tick: number } };
const ROOM_MAP_CACHE_TTL = 100; // Recalculate every 100 ticks
```

### Performance History

Each routine keeps bounded history:

```typescript
// Only last 100 records in memory
if (this.performanceHistory.length > 100) {
  this.performanceHistory = this.performanceHistory.slice(-100);
}

// Only last 20 records persisted
serialize() {
  return {
    performanceHistory: this.performanceHistory.slice(-20)
  };
}
```

## Extension Points

### Adding a New Routine

1. Create class extending `RoomRoutine`
2. Implement `routine()` and `calcSpawnQueue()`
3. Define requirements and outputs
4. Register in `main.ts` getRoomRoutines()

```typescript
// src/routines/MyRoutine.ts
export class MyRoutine extends RoomRoutine {
  name = 'myRoutine';

  constructor(pos: RoomPosition) {
    super(pos, { worker: [] });
    this.requirements = [{ type: 'work', size: 1 }];
    this.outputs = [{ type: 'result', size: 5 }];
  }

  routine(room: Room): void {
    // Custom logic
  }

  calcSpawnQueue(room: Room): void {
    // Spawn decisions
  }
}
```

### Adding a New Creep Role

1. Define body composition
2. Add role to routine's creepIds
3. Implement behavior in routine()
4. Handle in spawn queue

## Design Decisions

### Why Routines Over Creep-Centric

**Problem**: Creep-centric code ("harvester does X, carrier does Y") becomes tangled as roles interact.

**Solution**: Routine-centric code groups related creeps and their coordination logic together.

### Why Economic Contracts

**Problem**: Hard to compare operation effectiveness or prioritize resources.

**Solution**: Explicit requirements/outputs enable ROI calculation and market-driven coordination.

### Why Spatial Peaks

**Problem**: Optimal base placement is non-obvious and room-dependent.

**Solution**: Distance transform identifies mathematically optimal open areas.

### Why Waypoint Routing

**Problem**: Direct A-to-B pathfinding is expensive and rigid.

**Solution**: Waypoint routes are cheap to evaluate and support complex logistics patterns.
