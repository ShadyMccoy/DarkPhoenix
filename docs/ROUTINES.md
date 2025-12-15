# Routine System

This document describes the colony operation routines in detail.

## Overview

Routines are the primary units of colony operation. Each routine:

- Manages specific creeps
- Defines resource contracts
- Executes domain-specific logic
- Tracks its own performance

## RoomRoutine Base Class

All routines extend the abstract `RoomRoutine` class.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique routine identifier |
| `_position` | `RoomPosition` | Center of operation |
| `creepIds` | `{ [role]: Id<Creep>[] }` | Assigned creeps by role |
| `spawnQueue` | `SpawnRequest[]` | Pending spawn requests |
| `requirements` | `ResourceContract[]` | Input resources needed |
| `outputs` | `ResourceContract[]` | Output resources produced |
| `performanceHistory` | `PerformanceRecord[]` | Historical performance |

### Lifecycle Methods

```typescript
// Main entry point - called every tick
runRoutine(room: Room): void;

// Custom routine logic - implement in subclass
abstract routine(room: Room): void;

// Spawn decisions - implement in subclass
abstract calcSpawnQueue(room: Room): void;

// Internal lifecycle
RemoveDeadCreeps(): void;
AddNewlySpawnedCreeps(room: Room): void;
SpawnCreeps(room: Room): void;
```

### Economic Methods

```typescript
// Resource contracts
getRequirements(): ResourceContract[];
getOutputs(): ResourceContract[];

// Performance
calculateExpectedValue(): number;
getExpectedValue(): number;
recordPerformance(actualValue: number, cost: number): void;
getAverageROI(): number;
getPerformanceHistory(): PerformanceRecord[];
```

### Persistence

```typescript
serialize(): any;
deserialize(data: any): void;
```

## Bootstrap Routine

**Purpose**: Early-game colony initialization (RCL 1-2)

**File**: `src/routines/Bootstrap.ts`

### Creep Role: Jack

| Property | Value |
|----------|-------|
| Body | `[WORK, CARRY, MOVE]` |
| Cost | 200 energy |
| Count | 2 (maintained) |

### Behavior Priority

```
1. If full AND spawn needs energy
   → DeliverEnergyToSpawn()

2. If has energy AND spawn stable AND RCL < 2
   → upgradeController()

3. If dropped energy nearby (>50)
   → pickupEnergyPile()

4. Otherwise
   → HarvestNearestEnergySource()
```

### Methods

| Method | Description |
|--------|-------------|
| `HarvestNearestEnergySource()` | Find source with open positions |
| `DeliverEnergyToSpawn()` | Transfer energy to spawn |
| `upgradeController()` | Upgrade room controller |
| `pickupEnergyPile()` | Collect dropped energy |
| `BuildMinerContainer()` | Build at construction site |
| `dismantleWalls()` | Emergency wall removal |

### When Active

- Always present in controlled rooms
- Primary operation at RCL 1-2
- Backup operation at higher RCL (emergency recovery)

## EnergyMining Routine

**Purpose**: Dedicated harvesting at energy sources

**File**: `src/routines/EnergyMining.ts`

### Creep Role: Harvester

| Property | Value |
|----------|-------|
| Body | `[WORK, WORK, MOVE]` |
| Cost | 200 energy |
| Output | 10 energy/tick |
| Count | 1 per harvest position |

### Resource Contract

```typescript
requirements: [
  { type: 'work', size: 2 },
  { type: 'move', size: 1 },
  { type: 'spawn_time', size: 150 }
]

outputs: [
  { type: 'energy', size: 10 }
]
```

### Configuration: SourceMine

```typescript
interface SourceMine {
  sourceId: Id<Source>;         // Target source
  HarvestPositions: RoomPosition[]; // Valid harvest spots
  flow: number;                 // Expected output
  distanceToSpawn: number;      // For route planning
}
```

### Behavior

```
1. Each harvester assigned to specific position
2. Move to assigned position
3. Harvest from source
4. Energy drops to ground (for carriers)
```

### Auto-Infrastructure

When energy pile exceeds 500:
1. Check for existing container
2. Check for existing construction site
3. Create container construction site

### Instance Per Source

Each energy source gets its own EnergyMining instance:

```typescript
// main.ts initialization
room.find(FIND_SOURCES).forEach(source => {
  const mining = initEnergyMiningFromSource(source);
  // Each source tracked separately
});
```

## EnergyCarrying Routine

**Purpose**: Resource logistics and transport

**File**: `src/routines/EnergyCarrying.ts`

### Creep Role: Carrier

| Property | Value |
|----------|-------|
| Body | `[CARRY, CARRY, MOVE, MOVE]` |
| Cost | 200 energy |
| Capacity | 100 energy |
| Count | 1 (minimum) |

### Route System

Routes define waypoint-based paths:

```typescript
interface EnergyRoute {
  waypoints: RouteWaypoint[];
  Carriers: CarrierAssignment[];
}

interface RouteWaypoint {
  x: number;
  y: number;
  roomName: string;
  surplus: boolean;  // true = pickup, false = delivery
}
```

### Behavior

```
For each carrier on route:
  1. Check proximity to current waypoint

  2. If near waypoint:
     - If surplus point AND has capacity → pickup
     - If deficit point AND has energy → deliver
     - If surplus point AND full → support nearby builders

  3. If not near waypoint:
     → Move to next waypoint

  4. Cycle: waypoint[n] → waypoint[0]
```

### Route Calculation

```typescript
calculateRoutes(room: Room) {
  // For each energy mine:
  // Create route: source → spawn

  energyRoutes.push({
    waypoints: [
      { ...harvestPos, surplus: true },   // Pickup
      { ...spawn.pos, surplus: false }    // Delivery
    ],
    Carriers: []
  });
}
```

### Delivery Targets

Carriers deliver to (in priority order):
1. Spawn
2. Extensions
3. Towers
4. Storage
5. Containers

### Pickup Sources

Carriers pick up from:
1. Containers (priority)
2. Dropped energy piles

## Construction Routine

**Purpose**: Build structures from construction sites

**File**: `src/routines/Construction.ts`

### Creep Role: Builder

| Property | Value |
|----------|-------|
| Body | `[WORK, CARRY, MOVE]` |
| Cost | 200 energy |
| Build rate | 5 per tick |
| Count | 1 per site |

### Lifecycle

```
1. Created when construction site detected
2. Spawns builder if none assigned
3. Builder constructs site
4. When site complete → routine marks isComplete
5. Complete routines filtered from next tick
```

### Behavior

```
1. If builder has no energy:
   → pickupEnergyPile()

2. If far from site (>3 tiles):
   → moveTo(site)

3. If near site:
   → build(site)
```

### Completion Detection

```typescript
get isComplete(): boolean {
  return this._isComplete ||
         Game.getObjectById(this._constructionSiteId) == null;
}
```

### Instance Per Site

Each construction site gets its own Construction instance:

```typescript
room.find(FIND_MY_CONSTRUCTION_SITES).forEach(site => {
  new Construction(site.id);
});
```

## Creating New Routines

### Template

```typescript
import { RoomRoutine } from "../core/RoomRoutine";

export class MyRoutine extends RoomRoutine {
  name = "myRoutine";

  constructor(pos: RoomPosition) {
    super(pos, { worker: [] });  // Define roles

    // Define contracts
    this.requirements = [
      { type: 'work', size: 1 },
      { type: 'carry', size: 1 }
    ];
    this.outputs = [
      { type: 'result', size: 5 }
    ];
  }

  routine(room: Room): void {
    // Get assigned creeps
    const workers = this.creepIds.worker
      .map(id => Game.getObjectById(id))
      .filter((c): c is Creep => c != null);

    // Execute behavior
    workers.forEach(worker => {
      this.doWork(worker);
    });

    // Track performance
    const actualOutput = this.measureOutput();
    const cost = this.measureCost();
    this.recordPerformance(actualOutput, cost);
  }

  calcSpawnQueue(room: Room): void {
    this.spawnQueue = [];

    const desiredCount = this.calculateDesiredWorkers();
    if (this.creepIds.worker.length < desiredCount) {
      this.spawnQueue.push({
        body: [WORK, CARRY, MOVE],
        pos: this.position,
        role: "worker"
      });
    }
  }

  // Custom serialization if needed
  serialize(): any {
    return {
      ...super.serialize(),
      customField: this.customField
    };
  }

  deserialize(data: any): void {
    super.deserialize(data);
    this.customField = data.customField;
  }

  // Custom methods
  private doWork(worker: Creep): void {
    // Implementation
  }
}
```

### Registration

Add to `main.ts`:

```typescript
function getRoomRoutines(room: Room) {
  // ... existing routines ...

  // Add new routine
  if (!room.memory.routines.myRoutine) {
    room.memory.routines.myRoutine = [
      new MyRoutine(room.controller!.pos).serialize()
    ];
  }

  return {
    // ... existing ...
    myRoutine: _.map(room.memory.routines.myRoutine, (data) => {
      const r = new MyRoutine(room.controller!.pos);
      r.deserialize(data);
      return r;
    })
  };
}
```

## Best Practices

### 1. Single Responsibility

Each routine handles one domain:
- Mining handles harvesting
- Carrying handles logistics
- Construction handles building

### 2. Contract Accuracy

Keep requirements/outputs accurate:
```typescript
// Update when body changes
this.requirements = [
  { type: 'work', size: 3 },  // Now 3 WORK parts
];
```

### 3. Performance Tracking

Always record actual performance:
```typescript
routine(room: Room): void {
  const output = this.execute();
  this.recordPerformance(output, this.getCost());
}
```

### 4. Clean Serialization

Only persist essential state:
```typescript
serialize(): any {
  return {
    name: this.name,
    position: this.position,
    creepIds: this.creepIds,
    // Only routine-specific data
    sourceId: this.sourceId
  };
}
```

### 5. Defensive Coding

Handle missing game objects:
```typescript
const creep = Game.getObjectById(id);
if (!creep) return;  // May have died

const site = Game.getObjectById(this.siteId);
if (!site) {
  this._isComplete = true;
  return;
}
```
