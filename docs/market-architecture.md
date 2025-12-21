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

### Phase 1 (Current)
- [x] Energy market (mining → hauling → consumers)
- [x] Marginal cost pricing
- [x] Urgency-based bidding
- [x] Market clearing

### Phase 2
- [ ] Spawn time market
- [ ] Price-driven spawning decisions
- [ ] Multi-room offer routing

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
