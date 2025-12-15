# Economic Framework

This document describes the economic model underlying DarkPhoenix's decision-making system.

## Core Philosophy

Traditional Screeps AIs use explicit rules:
```
IF spawn.energy < 200 THEN spawn harvester
IF sources.length > harvesters THEN spawn harvester
```

DarkPhoenix uses economic signals:
```
Mining operation declares: "I need 2 WORK parts, I produce 10 energy/tick"
Colony decides: "This operation has 400% ROI, fund it"
```

The key insight: **good decisions emerge from well-designed markets**.

## The Resource Contract

Every operation declares what it needs and what it produces:

```typescript
interface ResourceContract {
  type: string;   // Resource identifier
  size: number;   // Amount per tick or per run
}
```

### Example: EnergyMining Contract

```typescript
// What the operation needs
requirements: [
  { type: 'work', size: 2 },      // 2 WORK body parts
  { type: 'move', size: 1 },      // 1 MOVE body part
  { type: 'spawn_time', size: 150 } // Spawn cost in ticks
]

// What the operation produces
outputs: [
  { type: 'energy', size: 10 }    // ~10 energy/tick
]
```

### Resource Types

| Type | Unit | Description |
|------|------|-------------|
| `energy` | per tick | Energy production/consumption |
| `work` | parts | WORK body parts required |
| `carry` | parts | CARRY body parts required |
| `move` | parts | MOVE body parts required |
| `spawn_time` | ticks | Spawn duration cost |
| `cpu` | per tick | CPU usage |

## ROI Calculation

Return on Investment measures operation efficiency:

```
ROI = (actualValue - cost) / cost
```

### Components

- **Actual Value**: Real output achieved
- **Cost**: Resources consumed (spawn energy, time, CPU)
- **Expected Value**: Predicted output based on contracts

### Example Calculation

```typescript
// Harvester stats
const energyPerTick = 10;    // 2 WORK * 2 energy/tick/WORK
const spawnCost = 200;       // Body cost
const lifetime = 1500;       // Creep lifespan

// Amortized cost per tick
const costPerTick = spawnCost / lifetime;  // 0.133 energy/tick

// ROI
const roi = (energyPerTick - costPerTick) / costPerTick;
// roi = (10 - 0.133) / 0.133 = 74.1 (7410% ROI!)
```

## Performance Tracking

Each routine maintains a performance history:

```typescript
interface PerformanceRecord {
  tick: number;           // When recorded
  expectedValue: number;  // Predicted output
  actualValue: number;    // Achieved output
  cost: number;           // Resources consumed
}
```

### Usage

```typescript
// After routine execution
this.recordPerformance(actualEnergy, spawnCostAmortized);

// Query average performance
const avgROI = routine.getAverageROI();
```

### History Management

- In-memory: Last 100 records
- Persisted: Last 20 records
- Enables trend analysis and anomaly detection

## Expected Value Calculation

Default formula:

```typescript
protected calculateExpectedValue(): number {
  const outputValue = this.outputs.reduce((sum, o) => sum + o.size, 0);
  const inputCost = this.requirements.reduce((sum, r) => sum + r.size, 0);
  return outputValue - inputCost;
}
```

Custom calculations can override this:

```typescript
// EnergyMining custom calculation
protected calculateExpectedValue(): number {
  const workParts = this.creepIds['harvester'].length * 2;
  const energyPerTick = workParts * 2;  // 2 energy/tick/WORK
  const spawnCost = this.creepIds['harvester'].length * 200;
  const amortizedCost = spawnCost / 1500;  // Over creep lifetime
  return energyPerTick - amortizedCost;
}
```

## Colony Hierarchy

The economic hierarchy enables market-based coordination:

```
Colony (AI controller)
  │
  ├── Room (resource pool)
  │     │
  │     ├── Routine (operation type)
  │     │     ├── Contract (requirements/outputs)
  │     │     ├── Creeps (execution units)
  │     │     └── Performance (ROI tracking)
  │     │
  │     └── Routine ...
  │
  └── Room ...
```

### Current Implementation

- **Colony**: Single AI managing all rooms
- **Room**: Independent routine sets per room
- **Routine**: Self-contained operation with contract

### Future Vision

```
Colony
  └── District (room cluster)
        ├── Market (buy/sell orders)
        └── Corp (operation group)
              └── Operation (executable unit)
```

## Market Mechanics (Planned)

### Buy Orders

Districts post what they need:

```typescript
interface BuyOrder {
  resource: string;      // What they want
  quantity: number;      // How much
  maxPrice: number;      // Maximum willing to pay
  priority: number;      // Urgency
}
```

### Sell Orders

Operations post what they produce:

```typescript
interface SellOrder {
  resource: string;      // What they offer
  quantity: number;      // How much
  minPrice: number;      // Minimum acceptable
  operation: Operation;  // Producer
}
```

### Price Discovery

Market price emerges from supply/demand:

```
If buyers > sellers → price rises
If sellers > buyers → price falls
```

Operations with costs below market price profit.
Operations with costs above market price fail.

## Taxation (Planned)

Colony-level funding mechanism:

```typescript
interface TaxPolicy {
  rate: number;           // Percentage of profits
  redistribution: string; // Where taxes go
}
```

### Purpose

1. **Fund public goods**: Shared infrastructure
2. **Smooth failures**: Operations can fail without bankruptcy
3. **Shape incentives**: Tax breaks for strategic operations

## Telemetry

Economic metrics to track:

### Per-Routine

- ROI (current and average)
- Expected vs actual value
- Resource consumption
- Creep utilization

### Per-Room

- Total energy production
- Total energy consumption
- Net energy flow
- Spawn utilization

### Per-Colony

- Aggregate ROI
- Resource distribution
- Operation mix
- Failure rate

## Design Patterns

### Contract-First Design

1. Define inputs and outputs first
2. Implementation follows contract
3. Changes to contract require explicit decision

### Fail-Fast Economics

```typescript
// If ROI is negative, operation is unsustainable
if (routine.getAverageROI() < 0) {
  console.log(`Warning: ${routine.name} has negative ROI`);
  // Consider: shutdown, modify, or accept loss
}
```

### Amortization

Spread one-time costs over lifetime:

```typescript
const spawnCost = 200;        // One-time
const lifetime = 1500;        // Expected ticks
const costPerTick = spawnCost / lifetime;  // Amortized
```

### Marginal Analysis

Compare additional output vs additional cost:

```typescript
// Should we add another harvester?
const marginalOutput = 10;     // Additional energy/tick
const marginalCost = 200/1500; // Additional amortized cost
const marginalROI = (marginalOutput - marginalCost) / marginalCost;
// If marginalROI > threshold, add harvester
```

## Implementation Status

### Implemented

- [x] ResourceContract interface
- [x] PerformanceRecord tracking
- [x] ROI calculation
- [x] History management
- [x] Serialization

### Planned

- [ ] Market system with orders
- [ ] Price discovery algorithm
- [ ] Taxation mechanics
- [ ] Cross-room coordination
- [ ] Automated operation selection

## Best Practices

1. **Always define contracts** - Even simple operations benefit from explicit contracts

2. **Track performance** - Use recordPerformance() to build history

3. **Calculate ROI** - Use getAverageROI() for operation comparison

4. **Amortize correctly** - Spread spawn costs over expected lifetime

5. **Review regularly** - Negative ROI operations need attention
