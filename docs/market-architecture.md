# Market Architecture: Generalizing the Economic System

## Current Implementation

The market currently handles a simple energy supply chain:

```
Mining Corp ──sells energy──> Hauling Corp ──sells delivered-energy──> Upgrading/Construction Corps
```

**Key Principles:**
1. **Marginal Cost Pricing**: Sellers price at actual cost + margin
2. **Urgency Bidding**: Buyers bid based on need (starvation, deadlines)
3. **Price Discovery**: Final price = max(seller's ask, buyer's bid)

## Generalizing to Other Resources

### Resource Types

| Resource | Producers | Consumers | Notes |
|----------|-----------|-----------|-------|
| `energy` | Mining | Hauling | Raw extraction |
| `delivered-energy` | Hauling | Upgrading, Construction, Spawning | Location-specific |
| `minerals` | Mineral Mining | Labs, Terminal | Per-mineral-type |
| `boosts` | Labs | Military, Remote Mining | Compound-specific |
| `spawn-time` | Spawning Corp | All corps needing creeps | Scarce resource |
| `cpu-ticks` | - | All corps | System-level constraint |

### Service Resources

Beyond physical resources, corps can trade **services**:

```typescript
type ServiceType =
  | "spawn-time"      // Access to spawn capacity
  | "protection"      // Military escort for remote operations
  | "repair"          // Structure maintenance
  | "storage-space"   // Warehouse capacity
  | "terminal-access" // Market/transfer capacity
```

## New Corp Types

### Remote Mining Corp
```
Buys: protection, spawn-time
Sells: energy (at remote location)

Urgency factors:
- Source keeper respawn timer
- Container decay
- Hostile presence
```

### Defense Corp
```
Buys: spawn-time, delivered-energy (for towers)
Sells: protection (service)

Pricing:
- Base rate per tick of coverage
- Premium during active threats
- Discount for long-term contracts
```

### Lab Corp
```
Buys: minerals, delivered-energy
Sells: boosts, compounds

Pricing:
- Cost of inputs + processing margin
- Urgency premium for military boosts during combat
```

### Terminal/Trade Corp
```
Buys: excess resources from all corps
Sells: scarce resources, credits from market

Acts as arbitrageur:
- Buys low locally, sells high on global market
- Imports when local price > global + transport
```

### Repair Corp
```
Buys: delivered-energy
Sells: repair service

Pricing based on:
- Structure importance (spawn > tower > extension > road)
- Decay urgency (hits remaining / max hits)
```

## Multi-Room Economics

### Cross-Room Offers

Offers already include `location` for distance-based pricing. Extend to cross-room:

```typescript
interface Offer {
  // ... existing fields
  location: Position;

  // New: acceptable delivery range
  maxDistance?: number;

  // New: cross-room logistics requirements
  requiresEscort?: boolean;
  requiresTerminal?: boolean;
}
```

### Transport Modes

| Mode | Speed | Capacity | Risk | Use Case |
|------|-------|----------|------|----------|
| Hauler | Slow | High | Medium | Adjacent rooms |
| Terminal | Instant | Limited | None | Long distance, credits |
| Power Creep | Fast | Low | Low | High-value, urgent |

### Inter-Room Arbitrage

```
Room A: Energy surplus (price 0.05/unit)
Room B: Energy deficit (price 0.20/unit)
Transport cost: 0.08/unit

Profit = 0.20 - 0.05 - 0.08 = 0.07/unit

→ Hauling corp routes creeps to profitable routes automatically
```

## Spawn Time Market

Spawn time is the scarcest resource. Corps bid for it:

```typescript
interface SpawnBid {
  corpId: string;
  bodyRequest: BodyPartConstant[];
  priority: number;        // Calculated from urgency
  maxWaitTicks: number;    // How long before we give up
  bidPrice: number;        // Credits willing to pay
}

// Spawning Corp clears the queue:
// 1. Sort by bidPrice (highest first)
// 2. Spawn highest bidder that fits current energy
// 3. Record revenue from spawn fee
```

**Urgency factors for spawn bidding:**
- Mining: Source going unharvested (energy waste)
- Defense: Active threat level
- Upgrading: Controller downgrade timer
- Construction: Build site decay

## Contract Evolution

Current contracts are simple delivery agreements. Extend to:

### Recurring Contracts
```typescript
interface RecurringContract extends Contract {
  frequency: number;        // Ticks between deliveries
  renewalTerms: "auto" | "renegotiate" | "terminate";
  priceAdjustment: "fixed" | "market" | "indexed";
}
```

### Futures Contracts
```typescript
interface FuturesContract extends Contract {
  deliveryTick: number;     // When delivery is due
  lockedPrice: number;      // Price agreed now
  margin: number;           // Collateral held
}
```

Useful for:
- Reserving spawn time for a military operation
- Locking in boost supply before a room assault
- Hedging against energy price spikes

## Price Signals Driving Behavior

The market creates **emergent optimization**:

| Signal | Response |
|--------|----------|
| High energy price | Mining corps spawn more miners |
| High transport margin | Hauling corps spawn more haulers |
| High spawn-time price | Corps optimize body sizes, reduce spawning |
| Low upgrade bid prices | Upgrading deprioritized, energy flows elsewhere |

### Feedback Loops

```
Energy scarce → Price rises → Mining more profitable → More miners spawn
                                                            ↓
Energy abundant ← Price falls ← Mining less profitable ← More energy produced
```

## Implementation Phases

### Phase 1 ✅ Complete
- [x] Energy market (mining → hauling → consumers)
- [x] Marginal cost pricing
- [x] Urgency-based bidding
- [x] Market clearing

### Phase 2 ✅ Complete (Dec 2024)
- [x] Spawn time market (`SpawningCorp` sells `work-ticks`)
- [x] Price-driven spawning decisions (corps buy work-ticks via market)
- [x] Multi-room offer routing (remote mining "just works")
- [x] Contract fulfillment via `processSpawnContracts()`

### Phase 3
- [ ] Mineral/boost markets
- [ ] Lab corps
- [ ] Terminal arbitrage

### Phase 4
- [ ] Defense services market
- [ ] Recurring contracts
- [ ] Cross-shard economics

## Design Principles

1. **Corps are selfish**: Each corp optimizes its own profit
2. **Prices are signals**: They communicate scarcity without central planning
3. **Markets clear**: No resource sits idle if someone values it
4. **Emergent behavior**: Complex coordination from simple rules
5. **Failure is feedback**: Bankrupt corps get replaced by better strategies

## Example: Full Economy Flow

```
Tick 1000:
  MiningCorp-A: sells 20 energy @ 0.08 (marginal cost 0.07 + 10% margin)
  HaulingCorp-A: buys 20 energy @ 0.12 (willing to pay for transport profit)
  → Trade at 0.12 (buyer's bid > seller's ask, urgency captured)

  HaulingCorp-A: sells 20 delivered-energy @ 0.18 (0.12 acquisition + 0.05 transport + margin)
  UpgradingCorp-A: bids 0.25 (controller at 15% downgrade, high urgency)
  ConstructionCorp-A: bids 0.15 (normal priority)
  → Upgrading wins, pays 0.25
  → Construction waits for next batch

Tick 1001:
  UpgradingCorp-A now has energy, urgency drops
  UpgradingCorp-A: bids 0.12 (normal priority)
  ConstructionCorp-A: bids 0.15 (still waiting)
  → Construction wins this time

  System self-balances without central coordination.
```

---

## Current Implementation: Market-Driven Spawning

### Overview

As of December 2024, spawning is fully market-driven. Corps no longer spawn creeps directly - they buy `work-ticks` from `SpawningCorp` through the market.

### Key Components

| File | Purpose |
|------|---------|
| `src/corps/SpawningCorp.ts` | Manages spawn structures, sells work-ticks, queues spawn orders |
| `src/corps/RealMiningCorp.ts` | Buys work-ticks via `buys()`, picks up assigned creeps |
| `src/corps/RealHaulingCorp.ts` | Same pattern - buys work-ticks, picks up creeps |
| `src/corps/RealUpgradingCorp.ts` | Same pattern - buys work-ticks + delivered-energy |
| `src/execution/CorpRunner.ts` | `processSpawnContracts()` routes contracts to SpawningCorps |

### Flow

```
1. MiningCorp.buys() → offers to buy "work-ticks"
2. SpawningCorp.sells() → offers to sell "work-ticks"
3. runMarketClearing() → matches offers, creates contracts
4. processSpawnContracts() → queues spawn order on SpawningCorp
5. SpawningCorp.work() → spawns creep with memory.corpId = buyerCorpId
6. MiningCorp.pickupAssignedCreeps() → scans for creeps with matching corpId
```

### Why This Matters for Remote Mining

With market-driven spawning, room boundaries become invisible:

- A spawn in room A can fulfill a work-ticks contract from a mining corp targeting a source in room B
- The market automatically routes based on price (distance factors into effective price)
- No special "remote mining" logic needed - it's just economics

### Monitoring via Telemetry

The telemetry system exports data to RawMemory segments for external monitoring.

#### Telemetry Segments

| Segment | Content |
|---------|---------|
| 0 (CORE) | CPU, GCL, colony stats, creep counts |
| 1 (NODES) | Node territories, resources, ROI scores |
| 2 (EDGES) | Spatial and economic graph edges |
| 3 (INTEL) | Room scouting data |
| 4 (CORPS) | Corp details: balance, revenue, cost, ROI |
| 5 (CHAINS) | Active production chains |

#### What to Watch

**Creep counts** (Segment 0 - `creeps` field):
- `miners`: Should match number of active mining corps
- `haulers`: Should match number of active hauling corps
- `upgraders`: Should match upgrading corps

**Corps data** (Segment 4):
- `creepCount`: Number of creeps per corp
- `isActive`: Whether corp is actively working
- `profit`: Revenue - Cost (should be positive for healthy corps)

**Console logs** to watch for:
```
[Mining] Picked up creep Miner_1234 assigned to W1N1-mining-abc1
[Hauling] Picked up creep Hauler_5678 assigned to W1N1-hauling
[Upgrading] Picked up creep Upgrader_9012 assigned to W1N1-upgrading
[Spawning] Spawned creep Miner_1234 for W1N1-mining-abc1
```

#### Running the Telemetry App

```bash
cd telemetry-app
npm start
```

Then open http://localhost:3000 and configure with your Screeps token.

#### Verifying Market-Driven Spawning Works

1. **Check corps tab**: Each mining/hauling/upgrading corp should have creeps
2. **Watch creep counts**: Should see miners, haulers, upgraders being spawned
3. **Check corps balance**: Should be non-zero (receiving/spending credits)
4. **Console logs**: Watch for "Picked up creep" messages

If creeps aren't being assigned:
- Verify `SpawningCorp` is created and registered
- Check that market clearing is producing contracts
- Verify `processSpawnContracts()` is being called

### Future: Boosted Creeps (Minerals)

The `work-ticks` abstraction is designed for future extension:

- Minerals boost body parts (e.g., +100% harvest rate)
- A boosted WORK part = 2 effective work-ticks per tick
- SpawningCorp with lab access could offer cheaper effective work-ticks
- Could introduce `boosted-work-ticks` or price by effectiveness
