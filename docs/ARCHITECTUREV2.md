# DarkPhoenix v2: Economic Colony Architecture

## Vision

A colony that behaves like a market economy. Operations buy and sell services. Profitable chains survive. Unprofitable chains die. The colony expands like a plague because expansion is profitable.

## Core Principles

1. **Credits are money** — minted via controller upgrades (+ policy hooks)
2. **Nodes are regions** — spatial areas with their own mini-economies  
3. **Operations are actors** — atomic units with bank accounts and offers
4. **Chains must close** — only complete paths to $ (upgrade) get funded
5. **Greedy is good** — maximize $/tick, expansion follows naturally

---

## System Architecture

```
Colony (oversight)
│
├── CreditLedger (money supply, policy minting)
│
├── ChainPlanner (find profitable loops)
│
├── Market (match offers, form contracts)
│
└── Nodes[] (spatial regions)
      │
      └── Operations[] (economic actors)
            ├── balance: number
            ├── offers: Offer[]
            └── work(): void
```

---

## Data Structures

### Credit

The universal currency. Loosely coupled to RCL/GCL.

```typescript
// Credits enter the economy via:
// 1. Controller upgrade (primary)
// 2. Policy minting (strategic incentives)

interface CreditLedger {
  // Account balances by operation ID
  balances: Map<string, number>;
  
  // Transfer credits between accounts
  transfer(from: string, to: string, amount: number): boolean;
  
  // Mint new credits (upgrade or policy)
  mint(to: string, amount: number, reason: string): void;
  
  // Get total money supply
  totalSupply(): number;
}
```

### Node

A spatial region with economic activity.

```typescript
interface Node {
  id: string;
  
  // Spatial bounds (could be room, territory, or custom region)
  positions: RoomPosition[];
  
  // Operations running in this node
  operations: Operation[];
  
  // What resources exist here (sources, controller, etc.)
  resources: NodeResource[];
  
  // Survey territory and generate potential offers
  survey(): Offer[];
}

interface NodeResource {
  type: 'source' | 'controller' | 'mineral' | 'spawn';
  id: string;
  position: RoomPosition;
  // Resource-specific data
  capacity?: number;
  level?: number;
}
```

### Operation

An atomic economic actor. The new base class replacing RoomRoutine.

```typescript
abstract class Operation {
  id: string;
  nodeId: string;
  
  // Economic state
  balance: number;
  
  // What I sell (my outputs)
  abstract sells(): Offer[];
  
  // What I buy (my inputs)  
  abstract buys(): Offer[];
  
  // Execute my work (only if contracts are active)
  abstract work(): void;
  
  // Lifecycle
  isActive: boolean;      // Currently funded and running
  isBankrupt: boolean;    // Balance <= 0, no active contracts
  
  // Performance tracking (kept from v1)
  performanceHistory: PerformanceRecord[];
}
```

### Offer

What an operation posts to the market.

```typescript
interface Offer {
  operationId: string;
  
  // What resource
  resource: string;       // 'energy', 'work-ticks', 'carry-ticks', 'credits'
  
  // How much over contract lifetime
  quantity: number;
  
  // Total price for the quantity
  price: number;
  
  // Contract duration (typically creep lifetime = 1500)
  duration: number;
  
  // Where (for location-dependent resources)
  location?: RoomPosition;
  
  // Derived
  perTick(): number { return this.quantity / this.duration; }
  unitPrice(): number { return this.price / this.quantity; }
}

type OfferType = 'sell' | 'buy';

interface MarketOffer extends Offer {
  type: OfferType;
  timestamp: number;
}
```

### Contract

A matched pair of offers. An agreement to exchange.

```typescript
interface Contract {
  id: string;
  
  // Parties
  sellerId: string;
  buyerId: string;
  
  // Terms (copied from matched offers)
  resource: string;
  quantity: number;
  price: number;
  duration: number;
  
  // State
  startTick: number;
  delivered: number;      // quantity delivered so far
  paid: number;           // credits paid so far
  
  // Lifecycle
  isActive(): boolean { return Game.time < this.startTick + this.duration; }
  isComplete(): boolean { return this.delivered >= this.quantity; }
}
```

### Chain

A complete path from raw resources to credit minting.

```typescript
interface Chain {
  id: string;
  
  // Ordered list of contracts forming the chain
  contracts: Contract[];
  
  // Total ROI of the chain
  roi: number;
  
  // Does this chain close? (ends in upgrade → $)
  isComplete: boolean;
  
  // Chain status
  isActive: boolean;
}
```

---

## Core Operations (Built-in)

These are the fundamental operations that ship with the framework.

### SpawnOperation

Sells creep services (work-ticks, carry-ticks, etc.)

```typescript
class SpawnOperation extends Operation {
  spawnId: Id<StructureSpawn>;
  
  sells(): Offer[] {
    // Calculate what we can produce
    // Factor in: energy available, spawn time, distance to buyer
    return [
      {
        resource: 'work-ticks',
        quantity: 2 * effectiveLifetime,  // 2 WORK parts
        price: this.calculatePrice(200),   // body cost + margin
        duration: effectiveLifetime,
        location: this.position
      }
    ];
  }
  
  buys(): Offer[] {
    return [
      { resource: 'energy', quantity: 200, price: 20, duration: 1 }
    ];
  }
  
  work(): void {
    // Spawn creeps for active contracts
    // Assign creeps to contract fulfillment
  }
}
```

### UpgradeOperation

Buys energy, mints credits. **The sink that closes all chains.**

```typescript
class UpgradeOperation extends Operation {
  controllerId: Id<StructureController>;
  
  sells(): Offer[] {
    // Upgrade operation SELLS credits (it mints them)
    const rclMultiplier = this.getRCLMultiplier();
    return [
      {
        resource: 'credits',
        quantity: 100 * rclMultiplier,  // More $ for RCL < 8
        price: 0,                        // Free! (we mint it)
        duration: 1500
      }
    ];
  }
  
  buys(): Offer[] {
    return [
      { resource: 'energy', quantity: 15000, price: 1500, duration: 1500 },
      { resource: 'work-ticks', quantity: 1500, price: 150, duration: 1500 }
    ];
  }
  
  work(): void {
    // Direct upgrader creeps
    // Mint credits based on actual upgrade progress
  }
  
  private getRCLMultiplier(): number {
    // RCL 1-7: high payout (incentivize room development)
    // RCL 8: lower payout (incentivize expansion)
    const level = this.controller?.level ?? 1;
    return level < 8 ? 3 : 1;
  }
}
```

### MiningOperation

Sells energy at a location.

```typescript
class MiningOperation extends Operation {
  sourceId: Id<Source>;
  
  sells(): Offer[] {
    return [
      {
        resource: 'energy',
        quantity: 15000,              // ~10/tick * 1500 ticks
        price: 1500,                  // 0.1 credit per energy
        duration: 1500,
        location: this.harvestPosition
      }
    ];
  }
  
  buys(): Offer[] {
    return [
      {
        resource: 'work-ticks',
        quantity: 3000,               // 2 WORK * 1500 ticks
        price: 200,
        duration: 1500,
        location: this.harvestPosition
      }
    ];
  }
  
  work(): void {
    // Creep harvests, energy drops to ground or container
  }
}
```

### CarryOperation

Buys energy at source, sells energy at destination. Arbitrage.

```typescript
class CarryOperation extends Operation {
  fromLocation: RoomPosition;
  toLocation: RoomPosition;
  
  sells(): Offer[] {
    return [
      {
        resource: 'energy',
        quantity: 10000,
        price: 1200,                  // Higher price at destination
        duration: 1500,
        location: this.toLocation
      }
    ];
  }
  
  buys(): Offer[] {
    return [
      {
        resource: 'energy',
        quantity: 10000,
        price: 1000,                  // Lower price at source
        duration: 1500,
        location: this.fromLocation
      },
      {
        resource: 'carry-ticks',
        quantity: 3000,
        price: 200,
        duration: 1500
      }
    ];
  }
  
  work(): void {
    // Move energy from A to B
    // Profit on the spread
  }
}
```

---

## Market System

### Offer Matching

Simple greedy matching. No complex order book needed.

```typescript
class Market {
  private sellOffers: MarketOffer[] = [];
  private buyOffers: MarketOffer[] = [];
  
  post(offer: MarketOffer): void {
    if (offer.type === 'sell') {
      this.sellOffers.push(offer);
    } else {
      this.buyOffers.push(offer);
    }
  }
  
  // Find compatible offers for a resource
  findMatches(resource: string): PotentialMatch[] {
    const sells = this.sellOffers.filter(o => o.resource === resource);
    const buys = this.buyOffers.filter(o => o.resource === resource);
    
    const matches: PotentialMatch[] = [];
    
    for (const sell of sells) {
      for (const buy of buys) {
        if (sell.price <= buy.price) {
          // Price overlap = potential match
          matches.push({
            sell,
            buy,
            spread: buy.price - sell.price
          });
        }
      }
    }
    
    // Sort by spread (highest profit first)
    return matches.sort((a, b) => b.spread - a.spread);
  }
}
```

### Location-Aware Pricing

Energy at source ≠ energy at spawn. Buyers factor in transport.

```typescript
function effectivePrice(offer: Offer, buyerLocation: RoomPosition): number {
  if (!offer.location) return offer.price;
  
  const distance = buyerLocation.getRangeTo(offer.location);
  const transportCost = distance * 0.1;  // Rough transport penalty
  
  return offer.price + (transportCost * offer.quantity);
}
```

---

## Chain Planning

The core intelligence: find profitable loops that close.

### The Algorithm

```typescript
class ChainPlanner {
  
  // Find all chains that end in credit minting
  findProfitableChains(market: Market, nodes: Node[]): Chain[] {
    const chains: Chain[] = [];
    
    // Start from upgrade operations (they mint $)
    const upgradeOps = this.findUpgradeOperations(nodes);
    
    for (const upgrade of upgradeOps) {
      // What does upgrade need?
      const needs = upgrade.buys();
      
      // Trace backwards: who can supply these needs?
      const chain = this.traceBack(needs, market, []);
      
      if (chain && this.isChainComplete(chain)) {
        chain.roi = this.calculateChainROI(chain);
        chains.push(chain);
      }
    }
    
    // Sort by ROI, prune dominated chains
    return this.pruneChains(chains);
  }
  
  // Recursive backtracking
  private traceBack(
    needs: Offer[],
    market: Market,
    visited: string[]
  ): Chain | null {
    
    for (const need of needs) {
      // Find sellers for this need
      const sellers = market.findMatches(need.resource)
        .filter(m => !visited.includes(m.sell.operationId));
      
      if (sellers.length === 0) {
        // Can't fulfill this need - chain is incomplete
        return null;
      }
      
      // Take best seller
      const best = sellers[0];
      
      // What does this seller need?
      const sellerOp = this.getOperation(best.sell.operationId);
      const sellerNeeds = sellerOp.buys();
      
      // Recurse
      visited.push(best.sell.operationId);
      const subChain = this.traceBack(sellerNeeds, market, visited);
      
      if (!subChain) return null;
      
      // Build chain
      // ...
    }
  }
  
  // Prune: if chain A < chain B in ROI, and A uses subset of B's resources
  private pruneChains(chains: Chain[]): Chain[] {
    chains.sort((a, b) => b.roi - a.roi);
    
    const kept: Chain[] = [];
    
    for (const chain of chains) {
      // Keep if no better chain dominates it
      const dominated = kept.some(better => 
        better.roi > chain.roi && this.dominates(better, chain)
      );
      
      if (!dominated) {
        kept.push(chain);
      }
    }
    
    return kept;
  }
}
```

### Branch and Bound

Don't search chains that can't beat the best found.

```typescript
private searchWithBound(
  partialChain: Chain,
  bestROI: number
): Chain | null {
  
  // Estimate best possible ROI for this partial chain
  const upperBound = this.estimateUpperBound(partialChain);
  
  if (upperBound <= bestROI) {
    // Can't beat best - prune this branch
    return null;
  }
  
  // Continue searching...
}
```

---

## Colony Oversight

The colony monitors and steers the economy.

```typescript
class Colony {
  nodes: Node[];
  market: Market;
  ledger: CreditLedger;
  planner: ChainPlanner;
  
  // Main tick
  run(): void {
    // 1. Nodes survey and post offers
    for (const node of this.nodes) {
      const offers = node.survey();
      offers.forEach(o => this.market.post(o));
    }
    
    // 2. Find profitable chains
    const chains = this.planner.findProfitableChains(
      this.market, 
      this.nodes
    );
    
    // 3. Activate best chains (form contracts)
    for (const chain of chains) {
      this.activateChain(chain);
    }
    
    // 4. Run active operations
    for (const node of this.nodes) {
      for (const op of node.operations) {
        if (op.isActive) {
          op.work();
        }
      }
    }
    
    // 5. Settle contracts (transfer credits)
    this.settleContracts();
    
    // 6. Prune bankrupt operations
    this.pruneBankrupt();
    
    // 7. Policy minting (strategic incentives)
    this.applyPolicies();
  }
  
  // Kill operations that can't pay
  private pruneBankrupt(): void {
    for (const node of this.nodes) {
      node.operations = node.operations.filter(op => {
        if (op.balance <= 0 && !op.hasActiveContracts()) {
          console.log(`Pruning bankrupt operation: ${op.id}`);
          return false;
        }
        return true;
      });
    }
  }
  
  // Strategic credit injection
  private applyPolicies(): void {
    // Example: Bounty for first container in remote room
    // Example: Subsidy for defensive operations
    // Example: Emergency liquidity during recovery
  }
}
```

---

## Testing Strategy

### Unit Tests (Pure Functions)

Test chain planning, market matching, ROI calculation without Screeps.

```typescript
// test/unit/ChainPlanner.test.ts
describe('ChainPlanner', () => {
  it('finds complete chain from mining to upgrade', () => {
    const market = new MockMarket();
    market.addSell('energy', 100, 'miner-1');
    market.addBuy('energy', 100, 'upgrader-1');
    
    const planner = new ChainPlanner();
    const chains = planner.findProfitableChains(market, mockNodes);
    
    expect(chains.length).toBe(1);
    expect(chains[0].isComplete).toBe(true);
  });
  
  it('prunes incomplete chains', () => {
    // Chain that doesn't reach upgrade
    const market = new MockMarket();
    market.addSell('energy', 100, 'miner-1');
    // No buyer!
    
    const planner = new ChainPlanner();
    const chains = planner.findProfitableChains(market, mockNodes);
    
    expect(chains.length).toBe(0);
  });
  
  it('prefers higher ROI chains', () => {
    // Two competing chains
    // ...
  });
});
```

### Integration Tests (Simulation)

Test full economic cycles in headless server.

```typescript
// test/sim/scenarios/economic-cycle.scenario.ts
export async function runEconomicCycleScenario() {
  const sim = createSimulator();
  
  // Run 1000 ticks
  await sim.runSimulation(1000, {
    onTick: async (tick, state) => {
      // Check credit supply is growing
      // Check chains are forming
      // Check bankrupt ops are pruned
    }
  });
  
  return {
    creditsMinted: await sim.getCredits(),
    activeChains: await sim.getActiveChains(),
    bankruptcies: await sim.getBankruptcyCount()
  };
}
```

---

## Migration Path

### Phase 1: Foundation (No Behavior Change)

1. Add `CreditLedger` (tracks balances, no real effect yet)
2. Add `Operation` base class alongside `RoomRoutine`
3. Add `Offer` and `Contract` types
4. Add `Market` (collects offers, no matching yet)
5. Write unit tests for new types

### Phase 2: Shadow Economy

1. Existing routines post offers to market (but don't use them)
2. Chain planner runs and logs what it would do
3. Compare shadow economy decisions to actual behavior
4. Tune pricing and ROI calculations

### Phase 3: Cut Over

1. Replace `spawnQueue` with market-based spawning
2. `SpawnOperation` fulfills contracts, not direct requests
3. Operations live/die by balance
4. Remove `RoomRoutine`, use `Operation` everywhere

### Phase 4: Expansion

1. Add `ExpansionOperation` (evaluates remote rooms)
2. Multi-room chains become profitable
3. Watch the plague spread

---

## File Structure (Target)

```
src/
├── main.ts                 # Game loop
├── colony/
│   ├── Colony.ts           # Top-level orchestrator
│   ├── CreditLedger.ts     # Money supply
│   └── index.ts
├── market/
│   ├── Market.ts           # Offer matching
│   ├── Contract.ts         # Agreement tracking
│   ├── Offer.ts            # Buy/sell declarations
│   └── index.ts
├── planning/
│   ├── ChainPlanner.ts     # Find profitable loops
│   ├── Chain.ts            # Chain data structure
│   └── index.ts
├── nodes/
│   ├── Node.ts             # Spatial region
│   ├── NodeSurveyor.ts     # Analyze territory
│   └── index.ts
├── operations/
│   ├── Operation.ts        # Base class
│   ├── SpawnOperation.ts   # Sell creep services
│   ├── UpgradeOperation.ts # Mint credits
│   ├── MiningOperation.ts  # Sell energy
│   ├── CarryOperation.ts   # Logistics arbitrage
│   └── index.ts
├── spatial/                # Keep existing
│   ├── RoomMap.ts
│   ├── algorithms.ts
│   └── index.ts
├── types/
│   └── ...
└── utils/
    └── ...
```

---

## What Gets Deleted

From current codebase:

| File/Class | Reason |
|------------|--------|
| `RoomRoutine.spawnQueue` | Replaced by market contracts |
| `RoomRoutine.calcSpawnQueue()` | Operations post offers instead |
| `RoomRoutine.SpawnCreeps()` | SpawnOperation handles this |
| `Bootstrap` | Replaced by economic bootstrap (grant to first ops) |
| `EnergyMining` | Replaced by MiningOperation |
| `EnergyCarrying` | Replaced by CarryOperation |
| `Construction` | Replaced by BuildOperation |
| `room.memory.routines` | Operations stored differently |

---

## Open Questions

1. **Initial capital**: How do new operations get starting balance?
   - Option: Colony grants seed capital
   - Option: Parent operation funds child
   - Option: Deferred payment (spawn now, pay over lifetime)

2. **Contract enforcement**: What if an operation can't deliver?
   - Option: Penalty (lose deposit)
   - Option: Contract cancellation
   - Option: Reputation system

3. **Price discovery**: Fixed prices or dynamic?
   - Start simple: fixed prices based on game constants
   - Later: supply/demand adjustment

4. **Node boundaries**: Room-based or territory-based?
   - Start simple: one node per room
   - Later: territory peaks become nodes

---

## Success Metrics

The system is working when:

1. **Chains close**: Every active operation is part of a chain ending in $
2. **Credits flow**: Money circulates, not pooling
3. **Losers die**: Negative ROI operations get pruned
4. **Expansion happens**: Remote mining emerges when profitable
5. **Recovery works**: After wipe, colony rebuilds economically
