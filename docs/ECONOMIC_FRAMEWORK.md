# Economic Framework

This document describes the flow-based economic model underlying DarkPhoenix's resource allocation.

## Core Philosophy

Traditional Screeps AIs use explicit rules:
```
IF spawn.energy < 200 THEN spawn harvester
IF sources.length > harvesters THEN spawn harvester
```

DarkPhoenix uses flow-based allocation:
```
FlowSolver sees: 2 sources producing 20 energy/tick
FlowSolver sees: spawn needs 5/tick, controller needs 15/tick
FlowSolver allocates: spawn priority 100, controller priority 70
Result: spawn gets energy first, controller gets remainder
```

The key insight: **optimal allocation emerges from a single global solve, not local decisions**.

## Flow Network Model

### Sources (Producers)

Energy sources in the room:

```typescript
interface FlowSource {
  id: string;
  nodeId: string;
  position: Position;
  capacity: number;       // 10 energy/tick per source
  assigned: boolean;      // Has miner?
}
```

### Sinks (Consumers)

Structures and operations that consume energy:

```typescript
interface FlowSink {
  id: string;
  nodeId: string;
  position: Position;
  type: SinkType;
  priority: number;       // 1-100
  demand: number;         // Energy needed per tick
  currentAllocation: number;
}

type SinkType =
  | "spawn"          // Priority 100 (always)
  | "extension"      // Priority 90 (when spawning)
  | "tower"          // Priority 95 (during combat)
  | "construction"   // Priority 80 (after RCL-up)
  | "controller"     // Priority 70 (normal) / 10 (building phase)
  | "storage";       // Priority 5 (excess only)
```

### Edges (Transport)

Paths between sources and sinks:

```typescript
interface FlowEdge {
  fromId: string;
  toId: string;
  distance: number;       // Walking distance
  carryCapacity: number;  // CARRY parts allocated
  flowRate: number;       // Energy/tick through edge
  costPerEnergy: number;  // Transport overhead
}
```

## Priority-Based Allocation

### How Priorities Work

The FlowSolver allocates energy greedily by priority:

1. Sort sinks by priority (highest first)
2. For each sink, allocate up to its demand
3. Subtract from available production
4. Continue until production exhausted

```typescript
function allocateBySinkPriority(
  availableEnergy: number,
  sinks: FlowSink[]
): SinkAllocation[] {
  // Sort by priority descending
  const sorted = sinks.sort((a, b) => b.priority - a.priority);

  const allocations: SinkAllocation[] = [];
  let remaining = availableEnergy;

  for (const sink of sorted) {
    const allocation = Math.min(sink.demand, remaining);
    allocations.push({ sinkId: sink.id, amount: allocation });
    remaining -= allocation;

    if (remaining <= 0) break;
  }

  return allocations;
}
```

### Dynamic Priority Context

Priorities adjust based on game state:

```typescript
interface PriorityContext {
  tick: number;
  rcl: number;
  rclProgress: number;
  constructionSites: number;
  hostileCreeps: number;
  storageEnergy: number;
  spawnQueue: number;
}

function calculatePriorities(context: PriorityContext): Map<SinkType, number> {
  const priorities = new Map<SinkType, number>();

  // Spawn is always critical
  priorities.set("spawn", 100);

  // Defense priority during combat
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
    priorities.set("controller", 70);
  }

  // Extensions needed for spawning
  if (context.spawnQueue > 0) {
    priorities.set("extension", 90);
  } else {
    priorities.set("extension", 50);
  }

  // Storage is low-priority buffer
  priorities.set("storage", 5);

  return priorities;
}
```

## Cost Calculation

### Transport Overhead

Moving energy costs spawn capacity (hauler bodies):

```typescript
function calculateHaulerCost(amount: number, distance: number): {
  carryParts: number;
  spawnCost: number;
} {
  // Round trip distance
  const roundTrip = distance * 2;

  // Energy per hauler trip (50 per CARRY part)
  const carryPerTrip = 50;

  // Trips needed per 1500 ticks (creep lifetime)
  const tripsPerLifetime = 1500 / roundTrip;

  // Total energy moved per hauler
  const energyPerHauler = carryPerTrip * tripsPerLifetime;

  // Parts needed to move target amount
  const carryParts = Math.ceil(amount / energyPerHauler);

  // Spawn cost (50 per CARRY, 50 per MOVE)
  const spawnCost = carryParts * 100;

  return { carryParts, spawnCost };
}
```

### Net Energy Calculation

```typescript
interface FlowSolution {
  totalHarvest: number;      // Gross energy from sources
  totalOverhead: number;     // Miners + haulers spawn cost
  netEnergy: number;         // Available for sinks
  efficiency: number;        // netEnergy / totalHarvest
}

// Example:
// 2 sources × 10 energy/tick = 20 gross
// Miners: 2 × (200 energy / 1500 ticks) = 0.27/tick overhead
// Haulers: 2 × (200 energy / 1500 ticks) = 0.27/tick overhead
// Net: 20 - 0.54 = 19.46 energy/tick available
// Efficiency: 97.3%
```

## ROI Tracking

Even with flow-based allocation, we track corps performance:

```typescript
interface PerformanceRecord {
  tick: number;
  expectedValue: number;    // Allocated by solver
  actualValue: number;      // Actually delivered
  cost: number;             // Resources consumed
}

// ROI calculation
const roi = (actualValue - cost) / cost;
```

### Why Track ROI?

1. **Validate solver accuracy** - Expected vs actual
2. **Identify bottlenecks** - Low actual means something's wrong
3. **Tune priorities** - If upgrading consistently underperforms, adjust
4. **Detect problems** - Negative ROI = investigate

## Comparison: Flow vs Market

### Market-Based (Old)

```
Mining Corp: "I'll sell 10 energy at $0.05"
Upgrade Corp: "I'll buy 10 energy at $0.08"
Market: Matches offers, creates contract
Problem: Mining Corp needs energy to spawn miner to make the offer
         → Circular dependency
         → Slow price discovery
         → Local optimization only
```

### Flow-Based (Current)

```
FlowSolver: Sees all sources and sinks
FlowSolver: Computes global optimal allocation
FlowSolver: Assigns miners to sources, haulers to edges
Corps: Execute their assignments
         → No circular dependency
         → Instant allocation
         → Global optimization
```

## Implementation Status

### Implemented

- [x] FlowSource and FlowSink types
- [x] FlowGraph construction from room data
- [x] Priority-based allocation algorithm
- [x] PriorityManager with context-aware priorities
- [x] FlowSolver with net energy calculation
- [x] Corps receiving and executing allocations

### Planned

- [ ] Multi-room flow networks
- [ ] Mineral/boost sink types
- [ ] Terminal as cross-room edge
- [ ] Defense sink with threat-level priority

## Best Practices

### 1. Trust the Solver

Don't manually override allocations. If something's wrong, adjust priorities or fix the input data.

### 2. Keep Priorities Simple

Use the standard priority tiers:
- 100: Critical (spawn)
- 90-95: Urgent (defense, extension fill)
- 70-80: Normal (upgrading, construction)
- 5-30: Low (storage, idle towers)

### 3. Monitor Efficiency

Track `FlowSolution.efficiency`. Below 90% means too much overhead—optimize hauler routes or miner placement.

### 4. React to Context

Let PriorityManager handle priority shifts. Defense → high tower priority. RCL-up → high construction priority. Don't hardcode responses.

### 5. Validate with ROI

If a corp's actual ROI is much lower than expected, investigate:
- Are creeps dying?
- Are paths blocked?
- Is the priority context wrong?
