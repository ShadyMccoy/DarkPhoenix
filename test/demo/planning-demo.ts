/**
 * Demonstration of the ChainPlanner finding viable production chains.
 *
 * Run with: npx ts-node -r tsconfig-paths/register test/demo/planning-demo.ts
 */

import { ChainPlanner } from "../../src/planning/ChainPlanner";
import { OfferCollector } from "../../src/planning/OfferCollector";
import { Corp, CorpType } from "../../src/corps/Corp";
import { Offer, Position } from "../../src/market/Offer";
import { DEFAULT_MINT_VALUES, MintValues } from "../../src/colony/MintValues";
import { Chain } from "../../src/planning/Chain";

// Test Corp implementation
class TestCorp extends Corp {
  private _sells: Offer[] = [];
  private _buys: Offer[] = [];
  private _position: Position;

  constructor(id: string, type: CorpType, nodeId: string, position: Position, balance: number = 0) {
    super(type, nodeId);
    (this as any).id = id;
    this._position = position;
    this.balance = balance;
  }

  sells(): Offer[] { return this._sells; }
  buys(): Offer[] { return this._buys; }
  work(): void {}
  getPosition(): Position { return this._position; }
  setSells(offers: Offer[]): void { this._sells = offers; }
  setBuys(offers: Offer[]): void { this._buys = offers; }
}

function createOffer(
  corpId: string,
  type: "buy" | "sell",
  resource: string,
  overrides: Partial<Offer> = {}
): Offer {
  return {
    id: `${corpId}-${resource}-${type}`,
    corpId,
    type,
    resource,
    quantity: 1000,
    price: 100,
    duration: 150,
    location: { x: 25, y: 25, roomName: "W1N1" },
    ...overrides
  };
}

function printChain(chain: Chain, index: number): void {
  console.log(`\n  Chain #${index + 1}: ${chain.id}`);
  console.log(`  ├─ Segments: ${chain.segments.length}`);
  for (const seg of chain.segments) {
    console.log(`  │  └─ ${seg.corpType}(${seg.corpId}): ${seg.resource}`);
    console.log(`  │     input: ${seg.inputCost.toFixed(2)} → output: ${seg.outputPrice.toFixed(2)} (margin: ${(seg.margin * 100).toFixed(1)}%)`);
  }
  console.log(`  ├─ Total Cost: ${chain.totalCost.toFixed(2)}`);
  console.log(`  ├─ Mint Value: ${chain.mintValue.toFixed(2)}`);
  console.log(`  ├─ Profit: ${chain.profit.toFixed(2)}`);
  console.log(`  └─ Viable: ${chain.profit > 0 ? '✓ YES' : '✗ NO'}`);
}

// ============================================================================
// SCENARIO 1: Simple Mining → Upgrading Chain
// ============================================================================
function scenario1_SimpleChain(): void {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 1: Simple Mining → Upgrading Chain");
  console.log("=".repeat(70));
  console.log("\nSetup:");
  console.log("  - MiningCorp: Sells energy at cost 0 (raw extraction)");
  console.log("  - UpgradingCorp: Buys energy, sells rcl-progress");
  console.log(`  - Mint value per RCL point: ${DEFAULT_MINT_VALUES.rcl_upgrade}`);

  const pos: Position = { x: 25, y: 25, roomName: "W1N1" };
  const collector = new OfferCollector();
  const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);

  // Mining corp - sells energy at base cost (0 + margin)
  const miningCorp = new TestCorp("mining1", "mining", "node1", pos, 0);
  miningCorp.setSells([
    createOffer("mining1", "sell", "energy", { price: 0, quantity: 10000 })
  ]);
  miningCorp.setBuys([]); // No inputs needed (raw extraction)

  // Upgrading corp - buys energy, produces RCL progress
  const upgradingCorp = new TestCorp("upgrading1", "upgrading", "node1", pos, 0);
  upgradingCorp.setBuys([
    createOffer("upgrading1", "buy", "energy", { quantity: 10000 })
  ]);
  upgradingCorp.setSells([
    createOffer("upgrading1", "sell", "rcl-progress", { quantity: 1000 })
  ]);

  collector.collectFromCorps([miningCorp, upgradingCorp]);
  planner.registerCorps([miningCorp, upgradingCorp]);

  console.log("\nOffers Collected:");
  const stats = collector.getStats();
  console.log(`  - Total offers: ${stats.totalOffers}`);
  console.log(`  - Sell offers: ${stats.sellOffers}`);
  console.log(`  - Buy offers: ${stats.buyOffers}`);

  const chains = planner.findViableChains(1000);

  console.log(`\nViable Chains Found: ${chains.length}`);
  chains.forEach((c, i) => printChain(c, i));

  if (chains.length === 0) {
    console.log("\n  (No viable chains - cost exceeds mint value or missing inputs)");
  }
}

// ============================================================================
// SCENARIO 2: Competing Miners (Different Costs)
// ============================================================================
function scenario2_CompetingMiners(): void {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 2: Competing Miners with Different Costs");
  console.log("=".repeat(70));
  console.log("\nSetup:");
  console.log("  - CheapMiner: Poor (balance=0), 10% margin, sells at 0 cost");
  console.log("  - WealthyMiner: Rich (balance=10000), 5% margin, sells at 0 cost");
  console.log("  - UpgradingCorp: Buys from cheapest supplier");

  const pos: Position = { x: 25, y: 25, roomName: "W1N1" };
  const collector = new OfferCollector();
  const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);

  // Poor miner - 10% margin
  const poorMiner = new TestCorp("poor-miner", "mining", "node1", pos, 0);
  poorMiner.setSells([
    createOffer("poor-miner", "sell", "energy", {
      price: poorMiner.getPrice(0), // 0 * 1.10 = 0
      quantity: 5000
    })
  ]);
  poorMiner.setBuys([]);

  // Wealthy miner - 5% margin (undercuts poor miner)
  const wealthyMiner = new TestCorp("wealthy-miner", "mining", "node2", pos, 10000);
  wealthyMiner.setSells([
    createOffer("wealthy-miner", "sell", "energy", {
      price: wealthyMiner.getPrice(0), // 0 * 1.05 = 0
      quantity: 5000
    })
  ]);
  wealthyMiner.setBuys([]);

  console.log(`\n  Poor miner margin: ${(poorMiner.getMargin() * 100).toFixed(1)}%`);
  console.log(`  Wealthy miner margin: ${(wealthyMiner.getMargin() * 100).toFixed(1)}%`);

  // Upgrading corp
  const upgradingCorp = new TestCorp("upgrading1", "upgrading", "node1", pos, 0);
  upgradingCorp.setBuys([
    createOffer("upgrading1", "buy", "energy", { quantity: 5000 })
  ]);
  upgradingCorp.setSells([
    createOffer("upgrading1", "sell", "rcl-progress", { quantity: 500 })
  ]);

  collector.collectFromCorps([poorMiner, wealthyMiner, upgradingCorp]);
  planner.registerCorps([poorMiner, wealthyMiner, upgradingCorp]);

  const chains = planner.findViableChains(1000);

  console.log(`\nViable Chains Found: ${chains.length}`);
  chains.forEach((c, i) => printChain(c, i));
}

// ============================================================================
// SCENARIO 3: Non-Viable Chain (Cost > Mint Value)
// ============================================================================
function scenario3_NonViableChain(): void {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 3: Non-Viable Chain (Expensive Mining)");
  console.log("=".repeat(70));
  console.log("\nSetup:");
  console.log("  - ExpensiveMiner: Sells energy at very high cost (1,000,000)");
  console.log("  - UpgradingCorp: Only produces 1 rcl-progress point");
  console.log(`  - Mint value: 1 × ${DEFAULT_MINT_VALUES.rcl_upgrade} = ${DEFAULT_MINT_VALUES.rcl_upgrade}`);
  console.log("  - Expected: Chain should be filtered out (cost >> mint value)");

  const pos: Position = { x: 25, y: 25, roomName: "W1N1" };
  const collector = new OfferCollector();
  const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);

  const expensiveMiner = new TestCorp("expensive-miner", "mining", "node1", pos, 0);
  expensiveMiner.setSells([
    createOffer("expensive-miner", "sell", "energy", { price: 1000000, quantity: 100 })
  ]);
  expensiveMiner.setBuys([]);

  const upgradingCorp = new TestCorp("upgrading1", "upgrading", "node1", pos, 0);
  upgradingCorp.setBuys([
    createOffer("upgrading1", "buy", "energy", { quantity: 100 })
  ]);
  upgradingCorp.setSells([
    createOffer("upgrading1", "sell", "rcl-progress", { quantity: 1 }) // Only 1 point!
  ]);

  collector.collectFromCorps([expensiveMiner, upgradingCorp]);
  planner.registerCorps([expensiveMiner, upgradingCorp]);

  const chains = planner.findViableChains(1000);

  console.log(`\nViable Chains Found: ${chains.length}`);
  if (chains.length === 0) {
    console.log("  ✓ Correctly filtered out non-viable chain");
    console.log(`    (Cost ~1,000,000 >> Mint value ${DEFAULT_MINT_VALUES.rcl_upgrade})`);
  } else {
    chains.forEach((c, i) => printChain(c, i));
  }
}

// ============================================================================
// SCENARIO 4: Multi-Segment Chain (Mine → Haul → Upgrade)
// ============================================================================
function scenario4_MultiSegmentChain(): void {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 4: Multi-Segment Chain (Mine → Haul → Upgrade)");
  console.log("=".repeat(70));
  console.log("\nSetup:");
  console.log("  - MiningCorp: Extracts energy (no input cost)");
  console.log("  - HaulingCorp: Buys energy at mine, sells at controller");
  console.log("  - UpgradingCorp: Buys energy, produces rcl-progress");
  console.log("  - Each corp adds margin, costs accumulate through chain");

  const minePos: Position = { x: 10, y: 10, roomName: "W1N1" };
  const controllerPos: Position = { x: 40, y: 40, roomName: "W1N1" };

  const collector = new OfferCollector();
  const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);

  // Mining corp at source
  const miningCorp = new TestCorp("miner", "mining", "node-mine", minePos, 0);
  miningCorp.setSells([
    createOffer("miner", "sell", "energy", {
      price: miningCorp.getPrice(0), // 0 cost + 10% margin = 0
      quantity: 5000,
      location: minePos
    })
  ]);
  miningCorp.setBuys([]);

  // Hauling corp - moves energy from mine to controller
  const haulingCorp = new TestCorp("hauler", "hauling", "node-haul", minePos, 5000);
  const energyBuyCost = 0; // Gets energy from miner at 0
  haulingCorp.setBuys([
    createOffer("hauler", "buy", "energy", { quantity: 5000, location: minePos })
  ]);
  haulingCorp.setSells([
    createOffer("hauler", "sell", "energy", {
      price: haulingCorp.getPrice(energyBuyCost), // Adds margin to input cost
      quantity: 5000,
      location: controllerPos
    })
  ]);

  // Upgrading corp at controller
  const upgradingCorp = new TestCorp("upgrader", "upgrading", "node-ctrl", controllerPos, 0);
  upgradingCorp.setBuys([
    createOffer("upgrader", "buy", "energy", { quantity: 5000, location: controllerPos })
  ]);
  upgradingCorp.setSells([
    createOffer("upgrader", "sell", "rcl-progress", { quantity: 500 })
  ]);

  console.log(`\n  Miner margin: ${(miningCorp.getMargin() * 100).toFixed(1)}%`);
  console.log(`  Hauler margin: ${(haulingCorp.getMargin() * 100).toFixed(1)}%`);
  console.log(`  Upgrader margin: ${(upgradingCorp.getMargin() * 100).toFixed(1)}%`);

  collector.collectFromCorps([miningCorp, haulingCorp, upgradingCorp]);
  planner.registerCorps([miningCorp, haulingCorp, upgradingCorp]);

  const chains = planner.findViableChains(1000);

  console.log(`\nViable Chains Found: ${chains.length}`);
  chains.forEach((c, i) => printChain(c, i));
}

// ============================================================================
// SCENARIO 5: Budget-Constrained Selection
// ============================================================================
function scenario5_BudgetConstrained(): void {
  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 5: Budget-Constrained Chain Selection");
  console.log("=".repeat(70));
  console.log("\nSetup:");
  console.log("  - Three potential upgrading chains with different costs");
  console.log("  - Treasury budget: 500 credits");
  console.log("  - Only affordable chains should be selected");

  const pos: Position = { x: 25, y: 25, roomName: "W1N1" };
  const collector = new OfferCollector();
  const planner = new ChainPlanner(collector, DEFAULT_MINT_VALUES);

  // Three miners with different costs
  const miners = [
    { id: "miner-cheap", cost: 100, quantity: 1000 },
    { id: "miner-medium", cost: 300, quantity: 1000 },
    { id: "miner-expensive", cost: 800, quantity: 1000 }
  ];

  const corps: TestCorp[] = [];

  for (const m of miners) {
    const miner = new TestCorp(m.id, "mining", `node-${m.id}`, pos, 0);
    miner.setSells([
      createOffer(m.id, "sell", "energy", { price: m.cost, quantity: m.quantity })
    ]);
    miner.setBuys([]);
    corps.push(miner);

    const upgrader = new TestCorp(`upgrader-${m.id}`, "upgrading", `node-${m.id}`, pos, 0);
    upgrader.setBuys([
      createOffer(`upgrader-${m.id}`, "buy", "energy", { quantity: m.quantity })
    ]);
    upgrader.setSells([
      createOffer(`upgrader-${m.id}`, "sell", "rcl-progress", { quantity: 100 })
    ]);
    corps.push(upgrader);
  }

  collector.collectFromCorps(corps);
  planner.registerCorps(corps);

  console.log("\n  All viable chains:");
  const allChains = planner.findViableChains(1000);
  allChains.forEach((c, i) => {
    console.log(`    ${i + 1}. Cost: ${c.totalCost.toFixed(0)}, Profit: ${c.profit.toFixed(0)}`);
  });

  const budget = 500;
  const affordable = planner.findBestChains(1000, budget);

  console.log(`\n  Budget: ${budget} credits`);
  console.log(`  Affordable Chains: ${affordable.length}`);

  const totalCost = affordable.reduce((sum, c) => sum + c.totalCost, 0);
  console.log(`  Total cost of selected: ${totalCost.toFixed(0)}`);

  affordable.forEach((c, i) => printChain(c, i));
}

// ============================================================================
// Run all scenarios
// ============================================================================
console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║           CHAIN PLANNER DEMONSTRATION                                ║");
console.log("║           Economic Colony Type System                                ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

scenario1_SimpleChain();
scenario2_CompetingMiners();
scenario3_NonViableChain();
scenario4_MultiSegmentChain();
scenario5_BudgetConstrained();

console.log("\n" + "=".repeat(70));
console.log("END OF DEMONSTRATION");
console.log("=".repeat(70) + "\n");
