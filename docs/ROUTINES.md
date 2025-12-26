# Corps System

This document describes the corps (business units) that execute work based on flow allocations.

## Overview

Corps are the execution layer of the flow-based economy. Each corp:

- Receives allocations from the FlowSolver
- Manages assigned creeps
- Executes domain-specific work
- Reports actual performance for ROI tracking

## Corp Base Class

All corps share common functionality:

```typescript
abstract class Corp {
  id: string;
  nodeId: string;
  creepIds: string[];

  // Get allocations from FlowEconomy
  abstract getAssignments(): Assignment[];

  // Execute work with assigned creeps
  abstract work(): void;

  // Report actual output for ROI
  abstract getActualOutput(): number;
}
```

## MiningCorp

**Purpose**: Harvest energy from assigned sources

**Allocation**: FlowSource assignment from FlowSolver

### Creep Role: Miner

| Property | Value |
|----------|-------|
| Body | `[WORK, WORK, WORK, WORK, WORK, MOVE]` (at RCL 4+) |
| Body | `[WORK, WORK, MOVE]` (early game) |
| Output | 10 energy/tick (5 WORK parts) |
| Behavior | Stationary harvesting |

### Behavior

```
1. Get assigned source from FlowEconomy
2. Move to optimal harvest position
3. Harvest continuously
4. Drop energy (haulers pick up)
```

### Auto-Infrastructure

When energy pile exceeds threshold:
1. Check for existing container
2. Create construction site if none
3. Stand on container once built

## HaulingCorp

**Purpose**: Transport energy along assigned edges

**Allocation**: FlowEdge assignments with capacity requirements

### Creep Role: Hauler

| Property | Value |
|----------|-------|
| Body | `[CARRY, CARRY, MOVE, MOVE, ...]` |
| Capacity | 50 energy per CARRY |
| Behavior | Pickup → Deliver → Repeat |

### Behavior

```
1. Get assigned edge from FlowEconomy
2. Move to source end of edge
3. Pickup energy (container, dropped, tombstone)
4. Move to sink end of edge
5. Deliver to structure or drop for next hauler
6. Return to source
```

### Delivery Priority

Haulers deliver to (in order):
1. Spawn (if not full)
2. Extensions (if not full)
3. Towers (if below threshold)
4. Storage
5. Drop at destination

## UpgradingCorp

**Purpose**: Upgrade room controller

**Allocation**: Controller sink allocation from FlowSolver

### Creep Role: Upgrader

| Property | Value |
|----------|-------|
| Body | `[WORK, CARRY, MOVE, ...]` |
| Upgrade rate | 1 per WORK per tick |
| Behavior | Collect energy → Upgrade |

### Behavior

```
1. Get controller allocation from FlowEconomy
2. Check if have energy
   - If no: collect from container/storage near controller
   - If yes: upgrade controller
3. Track upgrade progress for ROI
```

### Allocation-Based Spawning

Number of upgraders scales with allocation:
- Allocation = 10 energy/tick → ~2 upgraders (5 WORK each)
- Allocation = 0 (building phase) → 0 upgraders

## ConstructionCorp

**Purpose**: Build construction sites

**Allocation**: Construction sink allocation from FlowSolver

### Creep Role: Builder

| Property | Value |
|----------|-------|
| Body | `[WORK, CARRY, MOVE]` |
| Build rate | 5 per WORK per tick |
| Behavior | Collect → Build |

### Behavior

```
1. Get construction allocation from FlowEconomy
2. If no construction sites: idle/recycle
3. Find nearest site
4. Collect energy from nearest source
5. Build until site complete or energy depleted
6. Repeat
```

### Site Priority

Build sites in order:
1. Spawn (critical)
2. Extensions (capacity)
3. Towers (defense)
4. Storage (economy)
5. Roads (optimization)
6. Walls/Ramparts (defense)

## SpawningCorp

**Purpose**: Spawn creeps for other corps

**Allocation**: Spawn capacity (implicit from spawn structures)

### Behavior

```
1. Collect spawn requests from FlowEconomy
2. Sort by priority (from requesting corp's allocation)
3. Check energy availability
4. Spawn highest priority request that fits
5. Assign spawned creep to requesting corp
```

### Spawn Queue Priority

| Priority | Source |
|----------|--------|
| 100 | Miners (production) |
| 90 | Haulers (logistics) |
| 80 | Builders (construction phase) |
| 70 | Upgraders (normal) |
| 50 | Scouts |

## BootstrapCorp

**Purpose**: Emergency recovery from starvation

**Allocation**: Activated only when no other corps can function

### Creep Role: Jack

| Property | Value |
|----------|-------|
| Body | `[WORK, CARRY, MOVE]` |
| Cost | 200 energy |
| Behavior | Harvest → Deliver → Upgrade |

### Activation Conditions

Bootstrap activates when:
- No miners alive AND no energy to spawn
- All haulers dead AND storage empty
- Colony is in "starvation" state

### Behavior

```
1. If energy in spawn/extensions:
   - Spawn basic harvester
2. If no energy anywhere:
   - Spawn jack creep
   - Harvest nearest source
   - Deliver to spawn
   - Repeat until normal economy restarts
3. Once miners/haulers spawned:
   - Deactivate bootstrap
   - Normal flow economy resumes
```

**Important**: Bootstrap is NOT a regular occurrence. It's a rare fallback for recovery after wipes or attacks.

## Creating New Corps

### Template

```typescript
export class MyNewCorp extends Corp {
  constructor(nodeId: string) {
    super('my-new-corp', nodeId);
  }

  getAssignments(): Assignment[] {
    // Get from FlowEconomy
    return this.flowEconomy.getMyAssignments(this.id);
  }

  work(): void {
    const creeps = this.getCreeps();
    const assignments = this.getAssignments();

    for (const creep of creeps) {
      const assignment = assignments.find(a => a.creepId === creep.id);
      if (assignment) {
        this.executeWork(creep, assignment);
      }
    }
  }

  private executeWork(creep: Creep, assignment: Assignment): void {
    // Implementation
  }

  getActualOutput(): number {
    // Track and return actual work done
    return this.outputThisTick;
  }
}
```

### Registration

```typescript
// In FlowEconomy initialization
function createCorps(nodes: Node[]): Corp[] {
  const corps: Corp[] = [];

  for (const node of nodes) {
    // Standard corps
    corps.push(new MiningCorp(node.id, node.sources));
    corps.push(new HaulingCorp(node.id));

    // Add new corp
    if (node.hasMyResource) {
      corps.push(new MyNewCorp(node.id));
    }
  }

  return corps;
}
```

## Best Practices

### 1. Single Responsibility

Each corp handles one domain:
- Mining handles harvesting
- Hauling handles transport
- Construction handles building

### 2. Trust Flow Allocations

Don't spawn more creeps than your allocation justifies. If you need more, the priority context should reflect that.

### 3. Report Accurate Output

Track actual work done, not expected. This enables ROI validation:
```typescript
work(): void {
  const result = creep.upgrade(controller);
  if (result === OK) {
    this.actualOutput += creep.getActiveBodyparts(WORK);
  }
}
```

### 4. Handle Edge Cases

- Creeps die: remove from tracking
- Targets disappear: reassign or idle
- No allocation: don't spawn more

### 5. Coordinate via FlowEconomy

Don't have corps communicate directly. All coordination happens through the flow network and allocations.
