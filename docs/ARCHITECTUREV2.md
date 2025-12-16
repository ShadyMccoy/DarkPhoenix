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
Colony (sets mint prices, tax rates, policy)
│
├── CreditLedger (tracks money supply)
│
├── ChainPlanner (find profitable chains, cost-plus)
│
└── Nodes[] (spatial territories)
      │
      └── Corps[] (business units with bank accounts)
            │
            ├── balance: number
            ├── margin: 5-10% (based on wealth)
            ├── type: 'mining' | 'spawning' | 'upgrading' | 'hauling'
            └── work(): void
```

## Money Lifecycle

```
MINT → $ created when goals achieved (upgrade, kills, expansion)
  ↓
FLOW → $ flows through chains, each corp takes margin
  ↓
ACCUMULATE → successful corps build balance
  ↓
TAX → colony destroys $ to prevent runaway accumulation
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

A territory-based spatial region. Derived from peak detection.

```typescript
interface Node {
  id: string;                    // e.g., "W1N1-25-30" (room-x-y of peak)
  
  // Spatial definition (from RoomMap territory)
  peakPosition: Position;        // Center of territory
  positions: Position[];         // All tiles in territory
  roomName: string;              // Which room (for Game API access)
  
  // Economic state
  corps: Corp[];                 // Business units in this territory
  
  // What resources exist in this territory
  resources: NodeResource[];
  
  // Survey territory and identify what corps could exist
  survey(): PotentialCorp[];
  
  // Get all offers from corps in this node
  collectOffers(): Offer[];
}

interface NodeResource {
  type: 'source' | 'controller' | 'mineral' | 'spawn' | 'storage';
  id: string;
  position: Position;
  // Resource-specific data
  capacity?: number;      // energy per regen for sources
  level?: number;         // RCL for controller
}

interface PotentialCorp {
  type: CorpType;
  resource: NodeResource; // What it would use
  estimatedROI: number;   // Expected return
}
```

**Node Creation**: Nodes are created from `RoomMap.territories`. Each territory peak becomes a node.

```typescript
// In Colony initialization
function createNodesFromRoom(room: Room): Node[] {
  const roomMap = new RoomMap(room);
  const nodes: Node[] = [];
  
  for (const [peakId, positions] of roomMap.getAllTerritories()) {
    nodes.push({
      id: peakId,
      peakPosition: roomMap.getPeakCenter(peakId),
      positions: positions,
      roomName: room.name,
      corps: [],
      resources: surveyResources(positions, room)
    });
  }
  
  return nodes;
}
```

### Corp

A business unit with a bank account. Corps compete within and across nodes.

```typescript
type CorpType = 'mining' | 'spawning' | 'upgrading' | 'hauling' | 'building';

interface Corp {
  id: string;
  type: CorpType;
  nodeId: string;
  
  // Economic state
  balance: number;           // Accumulated wealth
  totalRevenue: number;      // Lifetime earnings
  totalCost: number;         // Lifetime costs
  createdAt: number;         // Game.time when created
  
  // What I sell (my outputs)
  sells(): Offer[];
  
  // What I need (my inputs)
  buys(): Offer[];
  
  // Execute my work
  work(): void;
  
  // Calculate my margin (5-10% based on wealth)
  getMargin(): number;
  
  // Cost-plus pricing
  getPrice(inputCost: number): number;
  
  // Historical performance
  getActualROI(): number;
}

class BaseCorp implements Corp {
  id: string;
  type: CorpType;
  nodeId: string;
  balance: number = 0;
  totalRevenue: number = 0;
  totalCost: number = 0;
  createdAt: number;
  
  constructor(type: CorpType, nodeId: string) {
    this.id = `${nodeId}-${type}-${Game.time}`;
    this.type = type;
    this.nodeId = nodeId;
    this.createdAt = Game.time;
  }
  
  // Rich corps can charge lower margins (more competitive)
  getMargin(): number {
    const baseMargin = 0.10;                          // 10% default
    const wealthDiscount = Math.min(this.balance / 10000, 0.05);  // Up to 5% discount
    return baseMargin - wealthDiscount;               // Range: 5% to 10%
  }
  
  // Cost-plus pricing
  getPrice(inputCost: number): number {
    return inputCost * (1 + this.getMargin());
  }
  
  // Track revenue when paid
  recordRevenue(amount: number): void {
    this.balance += amount;
    this.totalRevenue += amount;
  }
  
  // Track costs when paying suppliers
  recordCost(amount: number): void {
    this.balance -= amount;
    this.totalCost += amount;
  }
  
  // Actual ROI from historical performance
  getActualROI(): number {
    if (this.totalCost === 0) return 0;
    return (this.totalRevenue - this.totalCost) / this.totalCost;
  }
  
  // Abstract - implemented by specific corp types
  sells(): Offer[] { return []; }
  buys(): Offer[] { return []; }
  work(): void {}
}
```

### Competition Dynamics

Corps compete on price. Wealthy corps can undercut:

```
Node A Mining Corp (balance: $800)
  → margin: 5%
  → sells energy at $0.0105/unit

Node B Mining Corp (balance: $50)
  → margin: 10%
  → sells energy at $0.011/unit

Buyer picks Node A (cheaper).
Node A gets richer. Node B struggles.
Natural selection through markets.
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

## Core Corps (Built-in)

These are the fundamental corp types that ship with the framework.

### SpawningCorp

Sells creeps (work-ticks, carry-ticks) at a location.

```typescript
class SpawningCorp extends BaseCorp {
  private spawnId: Id<StructureSpawn>;
  
  constructor(nodeId: string, spawnId: Id<StructureSpawn>) {
    super('spawning', nodeId);
    this.spawnId = spawnId;
  }
  
  // What we need (energy to spawn)
  buys(): Offer[] {
    return [
      {
        corpId: this.id,
        type: 'buy',
        resource: 'energy',
        quantity: 300,              // Typical body cost
        location: this.getPosition()
      }
    ];
  }
  
  // What we sell (creep services)
  sells(): Offer[] {
    const margin = this.getMargin();
    const energyCost = 0;  // We'll buy energy, price TBD by market
    const spawnTimeCost = 50;  // Fixed cost for spawn time
    
    return [
      {
        corpId: this.id,
        type: 'sell',
        resource: 'work-ticks',
        quantity: 3000,             // 2 WORK × 1500 ticks
        price: this.getPrice(energyCost + spawnTimeCost),
        location: this.getPosition()
      },
      {
        corpId: this.id,
        type: 'sell',
        resource: 'carry-ticks',
        quantity: 3000,             // 2 CARRY × 1500 ticks
        price: this.getPrice(energyCost + spawnTimeCost),
        location: this.getPosition()
      }
    ];
  }
  
  work(): void {
    // Spawn creeps for active contracts
    // Track which creeps belong to which buyer
    // Direct creeps to buyer's location
  }
}
```

### MiningCorp

Buys work-ticks at source, sells energy at source.

```typescript
class MiningCorp extends BaseCorp {
  private sourceId: Id<Source>;
  private harvestPosition: RoomPosition;
  
  constructor(nodeId: string, sourceId: Id<Source>, pos: RoomPosition) {
    super('mining', nodeId);
    this.sourceId = sourceId;
    this.harvestPosition = pos;
  }
  
  buys(): Offer[] {
    return [
      {
        corpId: this.id,
        type: 'buy',
        resource: 'work-ticks',
        quantity: 3000,             // Need harvester for 1500 ticks
        location: this.harvestPosition
      }
    ];
  }
  
  sells(): Offer[] {
    // Price = input cost + margin
    // Input cost determined when chain is built
    return [
      {
        corpId: this.id,
        type: 'sell',
        resource: 'energy',
        quantity: 15000,            // ~10/tick × 1500 ticks
        location: this.harvestPosition
        // price: calculated from input costs + margin
      }
    ];
  }
  
  work(): void {
    // Creep (from spawning corp) harvests
    // Energy drops at harvestPosition
    // Record delivery for payment
  }
}
```

### HaulingCorp

Buys energy at source, sells energy at destination. Arbitrage.

```typescript
class HaulingCorp extends BaseCorp {
  private fromLocation: RoomPosition;
  private toLocation: RoomPosition;
  
  constructor(nodeId: string, from: RoomPosition, to: RoomPosition) {
    super('hauling', nodeId);
    this.fromLocation = from;
    this.toLocation = to;
  }
  
  buys(): Offer[] {
    return [
      {
        corpId: this.id,
        type: 'buy',
        resource: 'energy',
        quantity: 10000,
        location: this.fromLocation
      },
      {
        corpId: this.id,
        type: 'buy',
        resource: 'carry-ticks',
        quantity: 3000,
        location: this.fromLocation  // Carrier starts here
      }
    ];
  }
  
  sells(): Offer[] {
    // Sells energy at destination (higher value due to location)
    return [
      {
        corpId: this.id,
        type: 'sell',
        resource: 'energy',
        quantity: 10000,
        location: this.toLocation
        // price: input costs + margin
      }
    ];
  }
  
  work(): void {
    // Direct carrier creeps
    // Pick up at fromLocation
    // Drop at toLocation
    // Record delivery
  }
}
```

### UpgradingCorp

Buys energy + work-ticks at controller, mints credits.

```typescript
class UpgradingCorp extends BaseCorp {
  private controllerId: Id<StructureController>;
  
  constructor(nodeId: string, controllerId: Id<StructureController>) {
    super('upgrading', nodeId);
    this.controllerId = controllerId;
  }
  
  buys(): Offer[] {
    const controllerPos = this.getControllerPosition();
    return [
      {
        corpId: this.id,
        type: 'buy',
        resource: 'energy',
        quantity: 15000,
        location: controllerPos
      },
      {
        corpId: this.id,
        type: 'buy',
        resource: 'work-ticks',
        quantity: 1500,
        location: controllerPos
      }
    ];
  }
  
  sells(): Offer[] {
    // Upgrade corps sell "upgrade work" — colony buys it
    return [
      {
        corpId: this.id,
        type: 'sell',
        resource: 'rcl-progress',
        quantity: 1500,             // 1 work-tick = 1 upgrade point
        // price: input costs + margin
      }
    ];
  }
  
  work(): void {
    // Direct upgrader creeps
    // Record upgrade progress
  }
  
  getUpgradeWorkThisTick(): number {
    // Return actual upgrade progress this tick
    return this.deliveredThisTick;
  }
  
  getControllerLevel(): number {
    const controller = Game.getObjectById(this.controllerId);
    return controller?.level ?? 1;
  }
}
```

---

## Chain Planning (Cost-Plus)

The planner builds chains from leaves up, calculating total cost.

### Chain Building

```typescript
interface ChainSegment {
  corpId: string;
  corpType: CorpType;
  resource: string;          // What this corp produces
  quantity: number;
  inputCost: number;         // What this corp pays suppliers
  margin: number;            // This corp's margin (5-10%)
  outputPrice: number;       // inputCost × (1 + margin)
}

interface Chain {
  id: string;
  segments: ChainSegment[];
  
  // Calculated values
  leafCost: number;          // Cost at the bottom (raw resources = $0)
  totalCost: number;         // What Colony pays (top of chain)
  mintValue: number;         // What Colony gets back (from mint policy)
  profit: number;            // mintValue - totalCost
  
  // State
  funded: boolean;
}
```

### The Algorithm

```typescript
class ChainPlanner {
  
  findViableChains(offers: Offer[], mintValues: MintValues): Chain[] {
    const chains: Chain[] = [];
    
    // Find all upgrade corps (they produce RCL-progress)
    const upgradeCorps = this.findCorpsByType('upgrading');
    
    for (const upgradeCorp of upgradeCorps) {
      // Build chain backwards from upgrade
      const chain = this.buildChain(upgradeCorp, offers);
      
      if (chain) {
        // Calculate mint value based on policy
        chain.mintValue = chain.segments
          .filter(s => s.resource === 'rcl-progress')
          .reduce((sum, s) => sum + s.quantity, 0) * mintValues.rcl_upgrade;
        
        chain.profit = chain.mintValue - chain.totalCost;
        
        if (chain.profit > 0) {
          chains.push(chain);
        }
      }
    }
    
    // Sort by profit (best first)
    chains.sort((a, b) => b.profit - a.profit);
    
    return chains;
  }
  
  // Build chain from a corp, tracing its inputs recursively
  private buildChain(corp: Corp, offers: Offer[]): Chain | null {
    const segments: ChainSegment[] = [];
    
    // What does this corp need?
    const needs = corp.buys();
    let inputCost = 0;
    
    for (const need of needs) {
      // Find cheapest supplier for this need
      const supplier = this.findCheapestSupplier(need, offers);
      
      if (!supplier) {
        // Check if this is a leaf (raw resource)
        if (this.isLeafResource(need.resource)) {
          // Raw resources cost $0
          continue;
        }
        // Can't fulfill this need — chain is incomplete
        return null;
      }
      
      // Recursively build supplier's chain
      const supplierChain = this.buildChain(supplier.corp, offers);
      if (!supplierChain && !this.isLeafResource(need.resource)) {
        return null;
      }
      
      // Add supplier's segments
      if (supplierChain) {
        segments.push(...supplierChain.segments);
      }
      
      inputCost += supplier.price * need.quantity;
    }
    
    // Add this corp's segment
    const margin = corp.getMargin();
    const outputPrice = inputCost * (1 + margin);
    
    segments.push({
      corpId: corp.id,
      corpType: corp.type,
      resource: corp.sells()[0]?.resource ?? 'unknown',
      quantity: corp.sells()[0]?.quantity ?? 0,
      inputCost,
      margin,
      outputPrice
    });
    
    return {
      id: `chain-${corp.id}-${Game.time}`,
      segments,
      leafCost: 0,  // Raw resources are free
      totalCost: outputPrice,
      mintValue: 0, // Calculated by caller
      profit: 0,    // Calculated by caller
      funded: false
    };
  }
  
  // Leaf resources: things the game provides free
  private isLeafResource(resource: string): boolean {
    return resource === 'raw-energy';  // Energy at source
  }
  
  // Find the cheapest supplier for a need
  private findCheapestSupplier(
    need: Offer, 
    offers: Offer[]
  ): { corp: Corp, price: number } | null {
    
    const suppliers = offers
      .filter(o => o.type === 'sell' && o.resource === need.resource)
      .filter(o => o.quantity >= need.quantity);
    
    if (suppliers.length === 0) return null;
    
    // Factor in distance if locations matter
    const scored = suppliers.map(o => {
      let effectivePrice = o.price / o.quantity;  // Unit price
      
      if (need.location && o.location) {
        const distance = this.getDistance(need.location, o.location);
        effectivePrice += distance * 0.001;  // Distance penalty
      }
      
      return { offer: o, effectivePrice };
    });
    
    // Sort by effective price
    scored.sort((a, b) => a.effectivePrice - b.effectivePrice);
    
    const best = scored[0];
    const corp = this.getCorp(best.offer.corpId);
    
    return { corp, price: best.effectivePrice };
  }
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

The colony orchestrates the economy: finds chains, funds them, collects mints, applies tax.

```typescript
class Colony {
  nodes: Node[];
  ledger: CreditLedger;
  planner: ChainPlanner;
  activeChains: Chain[];
  mintValues: MintValues;
  taxRate: number = 0.001;
  
  // Colony treasury balance
  get treasury(): number {
    return this.ledger.getBalance();
  }
  
  // Main tick
  run(): void {
    // 1. Survey nodes for potential corps
    this.surveyNodes();
    
    // 2. Collect offers from all corps (cost-plus pricing)
    const offers = this.collectAllOffers();
    
    // 3. Find viable chains (cost < mint value)
    const chains = this.planner.findViableChains(offers, this.mintValues);
    
    // 4. Fund best chains from treasury
    this.fundChains(chains);
    
    // 5. Run active corps
    this.runCorps();
    
    // 6. Pay corps for delivered work
    this.settlePayments();
    
    // 7. Mint $ for achieved goals
    this.mintForAchievements();
    
    // 8. Apply taxation (money destruction)
    this.applyTaxation();
    
    // 9. Prune dead corps
    this.pruneDead();
  }
  
  // Fund chains: pay the chain cost from treasury
  private fundChains(chains: Chain[]): void {
    for (const chain of chains) {
      if (chain.totalCost <= this.treasury) {
        // Reserve funds for this chain
        this.ledger.spend(chain.totalCost);
        chain.funded = true;
        this.activeChains.push(chain);
        
        // Mark participating corps as active
        for (const segment of chain.segments) {
          const corp = this.getCorp(segment.corpId);
          corp.isActive = true;
        }
      }
    }
  }
  
  // Pay corps as they deliver
  private settlePayments(): void {
    for (const chain of this.activeChains) {
      if (!chain.funded) continue;
      
      // $ flows down the chain
      // Each corp gets paid by its buyer (the next corp up)
      for (const segment of chain.segments) {
        const corp = this.getCorp(segment.corpId);
        const delivered = corp.getDeliveredThisTick();
        
        if (delivered > 0) {
          // Pay based on their quoted price (cost + margin)
          const payment = delivered * segment.unitPrice;
          corp.recordRevenue(payment);
        }
      }
    }
  }
  
  // Mint $ when goals are achieved
  private mintForAchievements(): void {
    // RCL upgrades
    for (const node of this.nodes) {
      for (const corp of node.corps) {
        if (corp.type === 'upgrading') {
          const upgradeWork = (corp as UpgradeCorp).getUpgradeWorkThisTick();
          if (upgradeWork > 0) {
            const rcl = (corp as UpgradeCorp).getControllerLevel();
            const value = rcl < 8 
              ? this.mintValues.rcl_upgrade 
              : this.mintValues.gcl_upgrade;
            const mintAmount = upgradeWork * value;
            this.ledger.mint(mintAmount, 'upgrade');
          }
        }
      }
    }
    
    // Other achievements (container built, enemy killed, etc.)
    this.checkBounties();
  }
  
  // Tax: destroy money to prevent inflation
  private applyTaxation(): void {
    for (const node of this.nodes) {
      for (const corp of node.corps) {
        if (corp.balance > 0) {
          const tax = corp.balance * this.taxRate;
          corp.balance -= tax;
          this.ledger.recordTaxDestroyed(tax);
        }
      }
    }
  }
  
  // Kill corps with no money and no activity
  private pruneDead(): void {
    for (const node of this.nodes) {
      node.corps = node.corps.filter(corp => {
        // Keep if: has money OR is part of active chain
        if (corp.balance > 10) return true;
        if (corp.isActive) return true;
        
        // Grace period for new corps
        const age = Game.time - corp.createdAt;
        if (age < 1500) return true;
        
        console.log(`Pruning dead corp: ${corp.id}`);
        return false;
      });
    }
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
│   ├── CreditLedger.ts     # Money supply & destruction
│   ├── MintValues.ts       # Policy levers
│   └── index.ts
├── planning/
│   ├── ChainPlanner.ts     # Build chains, find viable ones
│   ├── Chain.ts            # Chain data structure
│   ├── OfferCollector.ts   # Gather offers from corps
│   └── index.ts
├── nodes/
│   ├── Node.ts             # Territory region
│   ├── NodeSurveyor.ts     # Find resources in territory
│   └── index.ts
├── corps/
│   ├── Corp.ts             # Base class (balance, margin, pricing)
│   ├── SpawningCorp.ts     # Sell creeps
│   ├── MiningCorp.ts       # Sell energy at source
│   ├── HaulingCorp.ts      # Move energy (arbitrage)
│   ├── UpgradingCorp.ts    # Buy inputs, trigger mint
│   ├── BuildingCorp.ts     # Construction
│   └── index.ts
├── spatial/                # Keep existing
│   ├── RoomMap.ts          # Territory detection
│   ├── algorithms.ts       # Pure spatial functions
│   └── index.ts
├── types/
│   ├── Offer.ts
│   ├── Position.ts
│   └── index.ts
└── utils/
    └── ErrorMapper.ts
```

---

## What Gets Deleted

From current codebase:

| File/Class | Reason |
|------------|--------|
| `RoomRoutine` | Replaced by `Corp` base class |
| `RoomRoutine.spawnQueue` | Corps buy from SpawningCorp instead |
| `RoomRoutine.calcSpawnQueue()` | Corps post offers, planner decides |
| `RoomRoutine.SpawnCreeps()` | SpawningCorp handles this |
| `Bootstrap` | Replaced by seed capital + economic bootstrap |
| `EnergyMining` | Replaced by MiningCorp |
| `EnergyCarrying` | Replaced by HaulingCorp |
| `Construction` | Replaced by BuildingCorp |
| `room.memory.routines` | Corps stored in nodes |
| `ResourceContract` | Replaced by Offer |

## What Gets Kept

| File/Class | Reason |
|------------|--------|
| `RoomMap` | Territory detection feeds Node creation |
| `algorithms.ts` | Pure spatial functions still needed |
| `Peak`, `Territory` | Define node boundaries |
| `ErrorMapper` | Still useful |
| `SourceMine` (modified) | Resource info for MiningCorp |

---

## Key Design Decisions

### 1. Money Flow: Colony as Buyer

Operations don't trade with each other. **Colony is the market maker.**

```
Upgrade mints $100
    ↓
Colony treasury receives $100
    ↓
Colony pays chain participants for their role:
    ├── Mine op:    $25 (produced energy)
    ├── Carry op:   $15 (moved energy)
    ├── Spawn op:   $20 (produced creeps)
    └── Upgrade op: $10 (did the upgrading)
    
Remaining $30 → Colony treasury (funds next chains)
```

Each operation keeps a margin (5-10% of value passing through). Colony pays directly — no inter-operation accounting.

**Bootstrap**: Colony grants seed capital to first spawn operation. From there, $ flows naturally as chains complete.

### 2. Contract Enforcement: ROI-Weighted Trust

Operations might fail to deliver. That's okay.

- Track **actual ROI** alongside expected ROI
- Weight contract decisions: `score = 0.3 * expected + 0.7 * actual`
- New operations start with expected only, build track record
- Colony tolerates some waste — **greedy expansion matters more than efficiency**

Bad operations naturally starve: low actual ROI → fewer contracts → no income → pruned.

### 3. Pricing: Cost-Plus from Leaves

Prices flow **upward** from free resources to final products.

```
LEAF: Raw energy at source
  Cost: $0 (game provides free)

SPAWN CORP (making harvester):
  Input cost: 250 energy × $0 = $0
  Fixed costs: spawn time = $50
  Margin: 10%
  Price: ($0 + $50) × 1.10 = $55

MINING CORP:
  Input cost: harvester = $55
  Margin: 10%
  Total cost: $55 × 1.10 = $60.50
  Output: 15000 energy over lifetime
  Price per energy: $60.50 / 15000 = $0.004

SPAWN CORP (making upgrader):
  Input cost: 200 energy × $0.004 = $0.80
  Fixed costs: spawn time = $40
  Margin: 10%
  Price: ($0.80 + $40) × 1.10 = $44.88

UPGRADE CORP:
  Input cost: 15000 energy × $0.004 = $60.50
  Input cost: upgrader = $44.88
  Margin: 10%
  Total price: ($60.50 + $44.88) × 1.10 = $115.92

COLONY PAYS: $115.92 for RCL upgrade
COLONY MINTS: $1000 (policy decision)
COLONY PROFIT: $884.08 → funds more chains
```

**Key insight**: The market determines the *cost*. Colony policy determines the *value*. Chains are profitable when value > cost.

### 4. Mint Values: Policy Levers

Colony announces what outcomes are worth. This steers behavior.

```typescript
// Colony policy - adjust to direct the plague
const MINT_VALUES = {
  // Core economy
  rcl_upgrade: 1000,          // Per upgrade point, RCL < 8
  gcl_upgrade: 300,           // Per upgrade point, RCL 8
  
  // Expansion incentives
  remote_source_tap: 500,     // First harvest from new source
  room_claim: 5000,           // Claiming a new room
  
  // Infrastructure bounties
  container_built: 100,
  storage_built: 500,
  road_built: 10,
  
  // Defense bounties
  enemy_creep_killed: 200,
  invasion_repelled: 1000,
};

// Steering examples:
// - Want faster expansion? Raise remote_source_tap
// - Want consolidation? Lower it
// - Under attack? Raise defense bounties
// - Need infrastructure? Raise build bounties
```

### 5. Taxation: Money Destruction

Tax prevents runaway accumulation. Colony doesn't keep it — money evaporates.

```typescript
class Colony {
  // Tax rate per tick (e.g., 0.001 = 0.1% per tick)
  private taxRate: number = 0.001;
  
  applyTaxation(): void {
    for (const node of this.nodes) {
      for (const corp of node.corps) {
        if (corp.balance > 0) {
          const tax = corp.balance * this.taxRate;
          corp.balance -= tax;
          // Tax just disappears - money destruction
          this.ledger.recordTaxDestroyed(tax);
        }
      }
    }
  }
}
```

**Why tax?**
- Prevents corps from hoarding infinite wealth
- Keeps money circulating
- Idle corps slowly lose advantage
- Active corps stay competitive

**Balance**: Mint rate ≈ Tax destruction rate → stable money supply

### 4. Node Boundaries: Territory-Based

Nodes are **not** rooms. Nodes are **territories** from the spatial system.

```
Room W1N1
├── Territory A (peak near spawn) → Node A
│     └── Operations: SpawnOp, UpgradeOp
├── Territory B (peak near source 1) → Node B  
│     └── Operations: MineOp
└── Territory C (peak near source 2) → Node C
      └── Operations: MineOp

Room W2N1 (remote)
└── Territory D (around source) → Node D
      └── Operations: MineOp
```

A chain crosses territories (and rooms):
```
Node D (mine) → Node C (carry waypoint) → Node A (spawn + upgrade)
```

**Why territories not rooms?**
- Room boundaries are arbitrary game constraints
- Territories reflect actual spatial structure
- Remote mining is just "another territory" — no special case
- Defense zones, logistics hubs emerge naturally

---

## Success Metrics

The system is working when:

1. **Chains are viable**: totalCost < mintValue for active chains
2. **$ flows through**: Corps accumulate balance, pay suppliers
3. **Tax balances mint**: Money supply stays roughly stable
4. **Competition works**: Efficient corps undercut, win business
5. **Losers die**: Corps with no balance or contracts get pruned
6. **Expansion emerges**: Remote territories become corps when profitable
7. **Recovery works**: After wipe, colony rebuilds via seed capital
8. **Policy steers**: Changing mint values redirects colony behavior
