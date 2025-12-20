# Corp Snapshot Refactor

## Problem

Currently we have duplicate logic between:
- `src/planning/models/*Model.ts` - Planning classes for ChainPlanner testing
- `src/corps/Real*Corp.ts` - Execution classes for live game

This creates:
1. **Duplicated constants** - `MINING_CONSTANTS` vs `EconomicConstants.ts`
2. **Duplicated formulas** - Same calculations in two places
3. **Testing friction** - Need separate Model classes just to avoid Game dependencies
4. **Divergence risk** - Easy for planning vs execution to get out of sync

## Solution: CorpSnapshot

Separate **data** (what can be serialized) from **behavior** (what requires Game runtime).

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CorpSnapshot                           │
│  (Pure data - can be loaded from Memory or test fixtures)   │
├─────────────────────────────────────────────────────────────┤
│  id: string                                                 │
│  type: CorpType                                             │
│  nodeId: string                                             │
│  position: Position                                         │
│                                                             │
│  // Economic state                                          │
│  balance: number                                            │
│  totalRevenue: number                                       │
│  totalCost: number                                          │
│  inputCost: number                                          │
│                                                             │
│  // Planning projections (pre-calculated)                   │
│  projectedBuys: Offer[]                                     │
│  projectedSells: Offer[]                                    │
│  expectedOutput: number                                     │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ hydrates from
                            │
┌───────────────────────────┴─────────────────────────────────┐
│                         Corp                                │
│  (Base class with economic logic)                           │
├─────────────────────────────────────────────────────────────┤
│  protected snapshot: CorpSnapshot                           │
│                                                             │
│  // Hydration                                               │
│  static fromSnapshot(data: CorpSnapshot): Corp              │
│  toSnapshot(): CorpSnapshot                                 │
│                                                             │
│  // Economic calculations (use EconomicConstants.ts)        │
│  getMargin(): number                                        │
│  getPrice(inputCost: number): number                        │
│  getActualROI(): number                                     │
│                                                             │
│  // Offer access (from snapshot)                            │
│  buys(): Offer[]  { return this.snapshot.projectedBuys }    │
│  sells(): Offer[] { return this.snapshot.projectedSells }   │
│                                                             │
│  // Abstract - only Real*Corps implement                    │
│  abstract work(tick: number): void                          │
│  abstract recalculateProjections(): void                    │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ extends
                            │
┌───────────────────────────┴─────────────────────────────────┐
│                    RealMiningCorp                           │
│  (Execution - requires Game runtime)                        │
├─────────────────────────────────────────────────────────────┤
│  private spawnId: string                                    │
│  private sourceId: string                                   │
│  private creepNames: string[]                               │
│                                                             │
│  // Execution                                               │
│  work(tick: number): void  // creep.harvest(), spawn, etc.  │
│                                                             │
│  // Recalculate projections (updates snapshot)              │
│  recalculateProjections(): void {                           │
│    // Uses EconomicConstants.ts formulas                    │
│    // Updates this.snapshot.projectedBuys/Sells             │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Test Fixture   │     │     Memory      │     │   Live Game     │
│  (JSON file)    │     │  (serialized)   │     │  (Game.*)       │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         ▼                       ▼                       ▼
    ┌─────────────────────────────────────────────────────────┐
    │                     CorpSnapshot                        │
    │            (unified data format)                        │
    └────────────────────────┬────────────────────────────────┘
                             │
                             ▼
    ┌─────────────────────────────────────────────────────────┐
    │                    ChainPlanner                         │
    │         (works with snapshots, doesn't care             │
    │          if they're from fixtures or live)              │
    └─────────────────────────────────────────────────────────┘
```

## Changes Required

### 1. Create CorpSnapshot interface

**File:** `src/corps/CorpSnapshot.ts`

```typescript
import { Offer, Position } from "../market/Offer";
import { CorpType } from "./Corp";

export interface CorpSnapshot {
  // Identity
  id: string;
  type: CorpType;
  nodeId: string;
  position: Position;

  // Economic state
  balance: number;
  totalRevenue: number;
  totalCost: number;
  createdAt: number;
  lastActivityTick: number;
  isActive: boolean;

  // Planning projections
  inputCost: number;
  expectedOutput: number;
  projectedBuys: Offer[];
  projectedSells: Offer[];

  // Type-specific config (optional)
  config?: Record<string, unknown>;
}
```

### 2. Update Corp base class

**File:** `src/corps/Corp.ts`

- Add `protected snapshot: CorpSnapshot`
- Add `static fromSnapshot(data: CorpSnapshot): Corp`
- Add `toSnapshot(): CorpSnapshot`
- Change `buys()`/`sells()` to return from snapshot
- Add `abstract recalculateProjections(): void`

### 3. Update Real*Corps

**Files:** `src/corps/Real*.ts`

- Implement `recalculateProjections()` using `EconomicConstants.ts`
- Call `recalculateProjections()` when state changes
- Remove hardcoded constants, import from `EconomicConstants.ts`

Example for RealMiningCorp:
```typescript
import {
  calculateOptimalWorkParts,
  designMiningCreep,
  calculateBodyCost,
  calculateEffectiveWorkTime,
  HARVEST_RATE,
  CREEP_LIFETIME
} from "../planning/EconomicConstants";

recalculateProjections(): void {
  const workParts = calculateOptimalWorkParts(this.sourceCapacity);
  const body = designMiningCreep(workParts);
  const spawnCost = calculateBodyCost(body);

  // Update snapshot
  this.snapshot.inputCost = spawnCost / CREEP_LIFETIME;
  this.snapshot.expectedOutput = workParts * HARVEST_RATE * CREEP_LIFETIME;
  this.snapshot.projectedBuys = [/* work-ticks offer */];
  this.snapshot.projectedSells = [/* energy offer */];
}
```

### 4. Update FixtureHydration

**File:** `src/planning/FixtureHydration.ts`

- Create `CorpSnapshot` objects directly from fixture data
- Use `Corp.fromSnapshot()` to create corps
- Remove Model-specific creation functions

### 5. Delete planning models

**Delete:** `src/planning/models/` directory entirely

- MiningModel.ts
- SpawningModel.ts
- UpgradingModel.ts
- HaulingModel.ts
- index.ts

### 6. Update exports

**File:** `src/planning/index.ts`

- Remove all `*Model` exports
- Keep `EconomicConstants` exports (these are the shared formulas)

**File:** `src/corps/index.ts`

- Add `CorpSnapshot` export

### 7. Update tests

- Change imports from `planning/models` to `corps`
- Tests that created Models now create snapshots + `fromSnapshot()`

## Benefits

1. **Single source of truth** - All constants in `EconomicConstants.ts`
2. **No duplication** - Formulas written once, used by all corps
3. **Easy testing** - Create `CorpSnapshot` objects directly, no mocking needed
4. **Memory/telemetry alignment** - Same format for persistence and debugging
5. **Clear separation** - Data (CorpSnapshot) vs Behavior (Corp subclasses)

## Migration Path

1. Create `CorpSnapshot` interface
2. Add snapshot support to `Corp` base class
3. Update one Real*Corp as proof of concept (RealMiningCorp)
4. Run tests to verify
5. Update remaining Real*Corps
6. Update FixtureHydration
7. Delete `src/planning/models/`
8. Clean up exports and tests
