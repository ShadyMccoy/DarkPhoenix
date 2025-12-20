# Corp State & Projections Refactor

## Problem

Currently we have duplicate logic between:
- `src/planning/models/*Model.ts` - Planning classes for ChainPlanner testing
- `src/corps/Real*Corp.ts` - Execution classes for live game

This creates:
1. **Duplicated constants** - `MINING_CONSTANTS` vs `EconomicConstants.ts`
2. **Duplicated formulas** - Same calculations in two places
3. **Testing friction** - Need separate Model classes just to avoid Game dependencies
4. **Divergence risk** - Easy for planning vs execution to get out of sync

## Design Constraints

Based on how ChainPlanner is used:

- **Stateless planning** - ChainPlanner runs periodically (every 500-1500 ticks) to set new plans, not multi-tick simulation
- **Pure projections** - Offer calculations depend only on node/corp configuration, not runtime state
- **Planning focus** - For now, we're focused on planning; execution comes later

## Solution: CorpState + Pure Projection Functions

Separate **state** (what a corp IS) from **projections** (what a corp OFFERS), with projections computed by pure functions.

### Why Not Cache Projections in State?

The original proposal included `projectedBuys`/`projectedSells` in the snapshot. This conflates:
- **State** (balance, costs, configuration) - serializable, changes over time
- **Projections** (offers) - computed from state + formulas, derived data

Since projections are stateless computations, they should be calculated on-demand rather than cached.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 CorpState (per type)                        │
│  Extends SerializedCorp with type-specific configuration    │
│  Pure data - no methods, no computed values                 │
├─────────────────────────────────────────────────────────────┤
│  MiningCorpState:                                           │
│    - id, type, nodeId, balance, ... (from SerializedCorp)   │
│    - position: Position                                     │
│    - sourceCapacity: number                                 │
│    - spawnPosition: Position | null                         │
│                                                             │
│  SpawningCorpState:                                         │
│    - position: Position                                     │
│    - energyCapacity: number                                 │
│                                                             │
│  UpgradingCorpState:                                        │
│    - position: Position                                     │
│    - controllerLevel: number                                │
│    - spawnPosition: Position | null                         │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ input to
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              Projection Functions (pure)                    │
│  No classes, no state - just functions                      │
├─────────────────────────────────────────────────────────────┤
│  projectMining(state, tick) → { buys: Offer[], sells: [] }  │
│  projectSpawning(state, tick) → { buys: [], sells: [] }     │
│  projectUpgrading(state, tick) → { buys: [], sells: [] }    │
│                                                             │
│  All use EconomicConstants.ts for formulas                  │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ called by
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    ChainPlanner                             │
│  Calls projection functions to get offers on-demand         │
│  Matches offers, builds chains, calculates viability        │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐
│  Test Fixture   │     │     Memory      │
│  (JSON file)    │     │  (serialized)   │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
    ┌─────────────────────────────────────────────────────────┐
    │                     CorpState                           │
    │         (type-specific configuration data)              │
    └────────────────────────┬────────────────────────────────┘
                             │
                             ▼
    ┌─────────────────────────────────────────────────────────┐
    │              projectXxx(state, tick)                    │
    │         (pure function, computes offers)                │
    └────────────────────────┬────────────────────────────────┘
                             │
                             ▼
    ┌─────────────────────────────────────────────────────────┐
    │                    ChainPlanner                         │
    │         (works with computed offers)                    │
    └─────────────────────────────────────────────────────────┘
```

## Changes Required

### 1. Create CorpState types

**File:** `src/corps/CorpState.ts`

```typescript
import { SerializedCorp } from "./Corp";
import { Position } from "../market/Offer";

/**
 * Mining corp state - configuration needed for projection
 */
export interface MiningCorpState extends SerializedCorp {
  type: "mining";
  position: Position;
  sourceCapacity: number;
  spawnPosition: Position | null;
}

/**
 * Spawning corp state
 */
export interface SpawningCorpState extends SerializedCorp {
  type: "spawning";
  position: Position;
  energyCapacity: number;
}

/**
 * Upgrading corp state
 */
export interface UpgradingCorpState extends SerializedCorp {
  type: "upgrading";
  position: Position;
  controllerLevel: number;
  spawnPosition: Position | null;
}

/**
 * Hauling corp state
 */
export interface HaulingCorpState extends SerializedCorp {
  type: "hauling";
  position: Position;
  carryCapacity: number;
  sourcePosition: Position;
  destinationPosition: Position;
}

/**
 * Union of all corp state types
 */
export type AnyCorpState =
  | MiningCorpState
  | SpawningCorpState
  | UpgradingCorpState
  | HaulingCorpState;

/**
 * Create a minimal corp state for testing
 */
export function createMiningState(
  id: string,
  nodeId: string,
  position: Position,
  sourceCapacity: number,
  spawnPosition: Position | null = null
): MiningCorpState {
  return {
    id,
    type: "mining",
    nodeId,
    position,
    sourceCapacity,
    spawnPosition,
    balance: 0,
    totalRevenue: 0,
    totalCost: 0,
    createdAt: 0,
    isActive: false,
    lastActivityTick: 0
  };
}
```

### 2. Create projection functions

**File:** `src/planning/projections.ts`

```typescript
import { Offer, createOfferId } from "../market/Offer";
import {
  MiningCorpState,
  SpawningCorpState,
  UpgradingCorpState,
  AnyCorpState
} from "../corps/CorpState";
import {
  calculateOptimalWorkParts,
  calculateEffectiveWorkTime,
  designMiningCreep,
  calculateBodyCost,
  HARVEST_RATE,
  CREEP_LIFETIME,
  BODY_PART_COST
} from "./EconomicConstants";
import { calculateMargin } from "../corps/Corp";

/**
 * Projection result - buy and sell offers for a corp
 */
export interface CorpProjection {
  buys: Offer[];
  sells: Offer[];
}

/**
 * Calculate offers for a mining corp
 */
export function projectMining(state: MiningCorpState, tick: number): CorpProjection {
  const workParts = calculateOptimalWorkParts(state.sourceCapacity);
  const workTicksNeeded = workParts * CREEP_LIFETIME;

  // Calculate effective output considering travel time
  const effectiveLifetime = state.spawnPosition
    ? calculateEffectiveWorkTime(state.spawnPosition, state.position)
    : CREEP_LIFETIME;
  const expectedOutput = workParts * HARVEST_RATE * effectiveLifetime;

  // Calculate input cost for pricing
  const body = designMiningCreep(workParts);
  const spawnCost = calculateBodyCost(body);
  const inputCostPerTick = effectiveLifetime > 0 ? spawnCost / effectiveLifetime : 0;

  const margin = calculateMargin(state.balance);
  const sellPrice = inputCostPerTick * (1 + margin);

  return {
    buys: [{
      id: createOfferId(state.id, "work-ticks", tick),
      corpId: state.id,
      type: "buy",
      resource: "work-ticks",
      quantity: workTicksNeeded,
      price: 0,  // Price determined by seller
      duration: CREEP_LIFETIME,
      location: state.position
    }],
    sells: [{
      id: createOfferId(state.id, "energy", tick),
      corpId: state.id,
      type: "sell",
      resource: "energy",
      quantity: expectedOutput,
      price: sellPrice,
      duration: CREEP_LIFETIME,
      location: state.position
    }]
  };
}

/**
 * Calculate offers for a spawning corp
 */
export function projectSpawning(state: SpawningCorpState, tick: number): CorpProjection {
  const margin = calculateMargin(state.balance);

  // Spawning corps sell work-ticks (creep labor)
  // Price based on body part costs
  const workTickPrice = (BODY_PART_COST.work + BODY_PART_COST.move) / CREEP_LIFETIME;

  return {
    buys: [{
      id: createOfferId(state.id, "energy", tick),
      corpId: state.id,
      type: "buy",
      resource: "energy",
      quantity: state.energyCapacity,
      price: 0,
      duration: CREEP_LIFETIME,
      location: state.position
    }],
    sells: [{
      id: createOfferId(state.id, "work-ticks", tick),
      corpId: state.id,
      type: "sell",
      resource: "work-ticks",
      quantity: CREEP_LIFETIME,  // One creep lifetime worth
      price: workTickPrice * (1 + margin),
      duration: CREEP_LIFETIME,
      location: state.position
    }]
  };
}

/**
 * Calculate offers for an upgrading corp
 */
export function projectUpgrading(state: UpgradingCorpState, tick: number): CorpProjection {
  const margin = calculateMargin(state.balance);

  // Upgrading corps buy energy, sell RCL progress
  // Energy consumed = 1 per upgrade point
  const energyNeeded = CREEP_LIFETIME;  // Simplified: 1 energy per tick

  return {
    buys: [{
      id: createOfferId(state.id, "energy", tick),
      corpId: state.id,
      type: "buy",
      resource: "energy",
      quantity: energyNeeded,
      price: 0,
      duration: CREEP_LIFETIME,
      location: state.position
    }],
    sells: [{
      id: createOfferId(state.id, "rcl-progress", tick),
      corpId: state.id,
      type: "sell",
      resource: "rcl-progress",
      quantity: energyNeeded,  // 1:1 energy to progress
      price: 0,  // RCL progress mints credits, doesn't sell
      duration: CREEP_LIFETIME,
      location: state.position
    }]
  };
}

/**
 * Project offers for any corp state (dispatcher)
 */
export function project(state: AnyCorpState, tick: number): CorpProjection {
  switch (state.type) {
    case "mining":
      return projectMining(state, tick);
    case "spawning":
      return projectSpawning(state, tick);
    case "upgrading":
      return projectUpgrading(state, tick);
    default:
      return { buys: [], sells: [] };
  }
}
```

### 3. Update FixtureHydration

**File:** `src/planning/FixtureHydration.ts`

- Remove imports of Model classes
- Create CorpState objects from fixture data
- Use projection functions when offers are needed

```typescript
// Before
import { MiningModel } from "./models/MiningModel";
const model = new MiningModel(nodeId, position, capacity, corpId);

// After
import { createMiningState } from "../corps/CorpState";
import { projectMining } from "./projections";

const state = createMiningState(corpId, nodeId, position, capacity, spawnPos);
const { buys, sells } = projectMining(state, tick);
```

### 4. Update ChainPlanner

**File:** `src/planning/ChainPlanner.ts`

Option A: ChainPlanner calls projection functions directly
```typescript
// Instead of corp.buys(), call:
const { buys, sells } = project(corpState, tick);
```

Option B: Create a thin wrapper that adapts CorpState to Corp interface
```typescript
class CorpStateAdapter {
  constructor(private state: AnyCorpState, private tick: number) {}

  buys(): Offer[] { return project(this.state, this.tick).buys; }
  sells(): Offer[] { return project(this.state, this.tick).sells; }
  getPosition(): Position { return this.state.position; }
  getMargin(): number { return calculateMargin(this.state.balance); }
  // ... other methods
}
```

### 5. Delete planning models

**Delete:** `src/planning/models/` directory entirely

- MiningModel.ts
- SpawningModel.ts
- UpgradingModel.ts
- HaulingModel.ts
- index.ts

### 6. Update exports

**File:** `src/planning/index.ts`

```typescript
// Remove
export * from "./models";

// Add
export * from "./projections";
```

**File:** `src/corps/index.ts`

```typescript
export * from "./CorpState";
```

### 7. Update tests

- Change imports from `planning/models` to `corps/CorpState` and `planning/projections`
- Tests create state objects and call projection functions directly

```typescript
// Before
const model = new MiningModel("node1", position, 3000);
const buys = model.buys();

// After
const state = createMiningState("mining-1", "node1", position, 3000, spawnPos);
const { buys } = projectMining(state, 0);
```

## Benefits

1. **Single source of truth** - All constants and formulas in `EconomicConstants.ts`
2. **No duplication** - Projection logic written once as pure functions
3. **Easy testing** - Pure functions with simple inputs, no mocking needed
4. **Clear separation** - State (CorpState) vs Computation (projection functions)
5. **Builds on existing code** - Extends `SerializedCorp` rather than replacing it
6. **Simpler mental model** - Functions, not classes with hidden state

## Migration Path

### Phase 1: Add new code (non-breaking)
1. Create `src/corps/CorpState.ts` with type interfaces
2. Create `src/planning/projections.ts` with pure functions
3. Add exports to index files

### Phase 2: Migrate MiningModel (proof of concept)
4. Update one test file to use new approach
5. Verify tests pass
6. Update FixtureHydration for mining

### Phase 3: Migrate remaining models
7. Update SpawningModel → projectSpawning
8. Update UpgradingModel → projectUpgrading
9. Update HaulingModel → projectHauling

### Phase 4: Update ChainPlanner
10. Decide on adapter approach (Option A or B above)
11. Update ChainPlanner to use CorpState + projections
12. Update all tests

### Phase 5: Cleanup
13. Delete `src/planning/models/` directory
14. Remove old imports and exports
15. Final test pass

## Future: Connecting to Real*Corps

When we connect planning to execution, Real*Corps can implement `toState()`:

```typescript
class RealMiningCorp extends Corp {
  toState(): MiningCorpState {
    return {
      ...this.serialize(),
      type: "mining",
      position: this.getPosition(),
      sourceCapacity: this.getSourceCapacity(),
      spawnPosition: this.getSpawnPosition()
    };
  }
}
```

This allows the same projection functions to work with both:
- Test fixtures (CorpState created directly)
- Live corps (CorpState from `corp.toState()`)
