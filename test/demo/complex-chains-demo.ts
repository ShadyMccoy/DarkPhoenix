/**
 * Demonstration of complex, multi-segment production chains.
 *
 * Shows longer chains, multiple inputs, remote mining, and competing chains.
 */

import { buildSegment, createChain, calculateChainROI, isViable, Chain, ChainSegment } from "../../src/planning/Chain";
import { DEFAULT_MINT_VALUES } from "../../src/colony/MintValues";
import { calculateMargin, calculatePrice } from "../../src/corps/Corp";
import { manhattanDistance, effectivePrice, Position } from "../../src/market/Offer";

function printChainDetailed(chain: Chain, title: string): void {
  console.log(`\n  ${title}`);
  console.log(`  ${"─".repeat(60)}`);

  let maxWidth = 0;
  for (const seg of chain.segments) {
    maxWidth = Math.max(maxWidth, seg.corpType.length + seg.corpId.length + 3);
  }

  for (let i = 0; i < chain.segments.length; i++) {
    const seg = chain.segments[i];
    const isLast = i === chain.segments.length - 1;
    const prefix = isLast ? "  └─" : "  ├─";
    const label = `${seg.corpType}(${seg.corpId})`;

    console.log(`${prefix} ${label}`);
    console.log(`  ${isLast ? " " : "│"}    Resource: ${seg.resource} (qty: ${seg.quantity})`);
    console.log(`  ${isLast ? " " : "│"}    Input: ${seg.inputCost.toFixed(2)} → Output: ${seg.outputPrice.toFixed(2)}`);
    console.log(`  ${isLast ? " " : "│"}    Margin: ${(seg.margin * 100).toFixed(1)}% (+${(seg.outputPrice - seg.inputCost).toFixed(2)})`);
  }

  console.log(`\n  Summary:`);
  console.log(`    Leaf cost:   ${chain.leafCost.toFixed(2)}`);
  console.log(`    Total cost:  ${chain.totalCost.toFixed(2)}`);
  console.log(`    Mint value:  ${chain.mintValue.toFixed(2)}`);
  console.log(`    Profit:      ${chain.profit.toFixed(2)}`);
  console.log(`    ROI:         ${(calculateChainROI(chain) * 100).toFixed(1)}%`);
  console.log(`    Viable:      ${isViable(chain) ? "✓ YES" : "✗ NO"}`);
}

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║           COMPLEX CHAIN DEMONSTRATIONS                               ║");
console.log("║           Multi-segment, multi-input, and remote chains             ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ============================================================================
// CHAIN 1: Full 5-Segment Upgrading Pipeline
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("CHAIN 1: Full 5-Segment Upgrading Pipeline");
console.log("=".repeat(70));
console.log(`
  This chain models the complete flow for controller upgrading:

  Source → Mining → Hauling → Storage → Distribution → Upgrading

  Each corp adds margin based on their wealth level.
`);

// Simulate different wealth levels
const corps = [
  { type: "mining", id: "source-miner", balance: 0, baseCost: 0 },
  { type: "hauling", id: "source-hauler", balance: 2000, baseCost: 0 },  // Hauls from source
  { type: "storage", id: "storage-mgr", balance: 8000, baseCost: 0 },    // Manages storage
  { type: "hauling", id: "ctrl-hauler", balance: 3000, baseCost: 0 },    // Hauls to controller
  { type: "upgrading", id: "upgrader", balance: 0, baseCost: 0 },
];

const segments1: ChainSegment[] = [];
let currentCost = 50; // Base extraction cost

for (const corp of corps) {
  const margin = calculateMargin(corp.balance);
  const outputPrice = calculatePrice(currentCost, margin);

  segments1.push({
    corpId: corp.id,
    corpType: corp.type as any,
    resource: corp.type === "upgrading" ? "rcl-progress" : "energy",
    quantity: 1000,
    inputCost: currentCost,
    margin,
    outputPrice
  });

  currentCost = outputPrice;
}

const chain1 = createChain("full-upgrade-pipeline", segments1, 100 * DEFAULT_MINT_VALUES.rcl_upgrade);
printChainDetailed(chain1, "5-Segment Upgrade Pipeline");

// Show margin breakdown
console.log(`\n  Margin Breakdown by Corp Wealth:`);
for (const corp of corps) {
  const margin = calculateMargin(corp.balance);
  console.log(`    ${corp.id.padEnd(15)} balance: ${corp.balance.toString().padStart(5)} → margin: ${(margin * 100).toFixed(1)}%`);
}

// ============================================================================
// CHAIN 2: Remote Mining Chain (Cross-Room)
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("CHAIN 2: Remote Mining Chain (Cross-Room with Distance Costs)");
console.log("=".repeat(70));
console.log(`
  Remote mining adds distance-based hauling costs:

  [Remote Room W2N1]          [Home Room W1N1]
  Source → RemoteMiner → LongHauler → Storage → Upgrader
           (far away)    (50+ tiles)

  Distance penalty: 0.01 credits per tile per unit hauled
`);

const remoteSource: Position = { x: 25, y: 25, roomName: "W2N1" };
const homeStorage: Position = { x: 25, y: 25, roomName: "W1N1" };
const distance = manhattanDistance(remoteSource, homeStorage);

console.log(`\n  Distance from remote source to home: ${distance} tiles`);
console.log(`  (Cross-room estimated at ~50 tiles per room)`);

const remoteSegments: ChainSegment[] = [];
let remoteCost = 30; // Lower base cost (richer source)

// Remote miner
const remoteMinerMargin = calculateMargin(0);
remoteCost = calculatePrice(remoteCost, remoteMinerMargin);
remoteSegments.push(buildSegment("remote-miner", "mining", "energy", 5000, 30, remoteMinerMargin));

// Long-distance hauler (adds distance penalty)
const haulerMargin = calculateMargin(1000);
const distancePenalty = distance * 0.01 * 5000; // 0.01 per tile per unit
const haulerInputCost = remoteCost + distancePenalty;
const haulerOutput = calculatePrice(haulerInputCost, haulerMargin);
remoteSegments.push({
  corpId: "long-hauler",
  corpType: "hauling",
  resource: "energy",
  quantity: 5000,
  inputCost: haulerInputCost,
  margin: haulerMargin,
  outputPrice: haulerOutput
});

// Home storage
const storageMargin = calculateMargin(5000);
const storageOutput = calculatePrice(haulerOutput, storageMargin);
remoteSegments.push(buildSegment("home-storage", "building", "energy", 5000, haulerOutput, storageMargin));

// Upgrader
const upgraderMargin = calculateMargin(0);
const upgraderOutput = calculatePrice(storageOutput, upgraderMargin);
remoteSegments.push(buildSegment("upgrader", "upgrading", "rcl-progress", 500, storageOutput, upgraderMargin));

const chain2 = createChain("remote-mining-chain", remoteSegments, 500 * DEFAULT_MINT_VALUES.rcl_upgrade);
printChainDetailed(chain2, "Remote Mining Chain");

console.log(`\n  Distance Cost Analysis:`);
console.log(`    Base energy cost at remote:  ${30}`);
console.log(`    After mining margin:         ${remoteCost.toFixed(2)}`);
console.log(`    Distance penalty (${distance} tiles):  +${distancePenalty.toFixed(2)}`);
console.log(`    Hauler input cost:           ${haulerInputCost.toFixed(2)}`);

// ============================================================================
// CHAIN 3: Spawning Chain (Multiple Outputs)
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("CHAIN 3: Spawning Chain (Energy → Creeps)");
console.log("=".repeat(70));
console.log(`
  Spawning converts energy into creeps:

  Mining → Hauling → Spawning → [spawning] → Miners, Upgraders, Haulers

  spawning: Unified spawn capacity measured in energy units.
  CreepSpec on the contract defines what kind of creep to spawn.
`);

// Build the supply chain to spawner
const spawnSegments: ChainSegment[] = [];
let spawnCost = 50;

// Mining
const sMinerMargin = calculateMargin(500);
spawnCost = calculatePrice(spawnCost, sMinerMargin);
spawnSegments.push(buildSegment("spawn-miner", "mining", "energy", 3000, 50, sMinerMargin));

// Hauling to spawn
const sHaulerMargin = calculateMargin(2000);
spawnCost = calculatePrice(spawnCost, sHaulerMargin);
spawnSegments.push(buildSegment("spawn-hauler", "hauling", "energy", 3000, spawnSegments[0].outputPrice, sHaulerMargin));

// Spawning (converts energy to spawn capacity)
// Spawning cost: energy for body + spawn time opportunity cost
const spawnMargin = calculateMargin(3000);
const bodyEnergyCost = spawnCost; // Energy consumed by spawn
const spawnTimeCost = 50; // Opportunity cost of spawn time
const totalSpawnInput = bodyEnergyCost + spawnTimeCost;
const spawnOutput = calculatePrice(totalSpawnInput, spawnMargin);
spawnSegments.push({
  corpId: "spawner",
  corpType: "spawning",
  resource: "spawning",
  quantity: 550, // Energy cost of creep body
  inputCost: totalSpawnInput,
  margin: spawnMargin,
  outputPrice: spawnOutput
});

// Work-ticks consumed by upgrader
const workConsumerMargin = calculateMargin(0);
const workConsumerOutput = calculatePrice(spawnOutput, workConsumerMargin);
spawnSegments.push(buildSegment("work-consumer", "upgrading", "rcl-progress", 150, spawnOutput, workConsumerMargin));

const chain3 = createChain("spawn-to-upgrade", spawnSegments, 150 * DEFAULT_MINT_VALUES.rcl_upgrade);
printChainDetailed(chain3, "Spawning → Upgrading Chain");

// ============================================================================
// CHAIN 4: Construction Chain
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("CHAIN 4: Construction Chain (Building Infrastructure)");
console.log("=".repeat(70));
console.log(`
  Building structures has different mint values:

  Mining → Hauling → Spawning → Building → [Container]
                                         → [Extension]
                                         → [Road]

  Mint values: Container=${DEFAULT_MINT_VALUES.container_built}, Extension=${DEFAULT_MINT_VALUES.extension_built}, Road=${DEFAULT_MINT_VALUES.road_built}
`);

function buildConstructionChain(structureType: string, mintValue: number): Chain {
  const segs: ChainSegment[] = [];
  let cost = 100; // Base energy cost

  // Mining
  const m = calculateMargin(1000);
  cost = calculatePrice(cost, m);
  segs.push(buildSegment("builder-miner", "mining", "energy", 2000, 100, m));

  // Hauling
  const h = calculateMargin(500);
  cost = calculatePrice(cost, h);
  segs.push(buildSegment("builder-hauler", "hauling", "energy", 2000, segs[0].outputPrice, h));

  // Spawning builder creep
  const s = calculateMargin(2000);
  cost = calculatePrice(cost + 30, s); // +30 for spawn time
  segs.push(buildSegment("builder-spawn", "spawning", "spawning", 400, segs[1].outputPrice + 30, s));

  // Building
  const b = calculateMargin(0);
  cost = calculatePrice(cost, b);
  segs.push(buildSegment("builder", "building", structureType, 1, segs[2].outputPrice, b));

  return createChain(`build-${structureType}`, segs, mintValue);
}

const containerChain = buildConstructionChain("container", DEFAULT_MINT_VALUES.container_built);
const extensionChain = buildConstructionChain("extension", DEFAULT_MINT_VALUES.extension_built);
const roadChain = buildConstructionChain("road", DEFAULT_MINT_VALUES.road_built);

console.log(`\n  Construction Chain Comparison:`);
console.log(`  ${"─".repeat(60)}`);
console.log(`  Structure     Cost      Mint     Profit    ROI      Viable`);
console.log(`  ${"─".repeat(60)}`);

for (const [name, chain] of [["Container", containerChain], ["Extension", extensionChain], ["Road", roadChain]] as [string, Chain][]) {
  const roi = calculateChainROI(chain);
  console.log(`  ${name.padEnd(12)} ${chain.totalCost.toFixed(0).padStart(8)}  ${chain.mintValue.toFixed(0).padStart(8)}  ${chain.profit.toFixed(0).padStart(8)}  ${(roi * 100).toFixed(0).padStart(5)}%  ${isViable(chain) ? "  ✓" : "  ✗"}`);
}

// ============================================================================
// CHAIN 5: Competing Parallel Chains
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("CHAIN 5: Competing Parallel Chains (Resource Allocation)");
console.log("=".repeat(70));
console.log(`
  Multiple chains compete for the same energy source:

                    ┌→ Upgrading Chain (RCL progress)
  Source → Mining ──┼→ Building Chain (Extensions)
                    └→ Defense Chain (Tower energy)

  The planner must choose which chains to fund based on profit.
`);

// Shared mining segment
const sharedMiningCost = 50;
const sharedMiningMargin = calculateMargin(5000);
const sharedMiningOutput = calculatePrice(sharedMiningCost, sharedMiningMargin);

function buildCompetingChain(name: string, finalResource: string, mintPerUnit: number, quantity: number): Chain {
  const segs: ChainSegment[] = [];

  // Shared mining
  segs.push(buildSegment("shared-miner", "mining", "energy", 1000, sharedMiningCost, sharedMiningMargin));

  // Dedicated hauler
  const hMargin = calculateMargin(Math.random() * 5000); // Varying wealth
  const hOutput = calculatePrice(sharedMiningOutput, hMargin);
  segs.push(buildSegment(`${name}-hauler`, "hauling", "energy", 1000, sharedMiningOutput, hMargin));

  // Final consumer
  const cMargin = calculateMargin(Math.random() * 3000);
  const cOutput = calculatePrice(hOutput, cMargin);
  segs.push(buildSegment(`${name}-consumer`, "upgrading", finalResource, quantity, hOutput, cMargin));

  return createChain(`${name}-chain`, segs, quantity * mintPerUnit);
}

const upgradingChain = buildCompetingChain("upgrade", "rcl-progress", DEFAULT_MINT_VALUES.rcl_upgrade, 100);
const extensionChain2 = buildCompetingChain("extension", "extension", DEFAULT_MINT_VALUES.extension_built, 5);
const towerChain = buildCompetingChain("defense", "tower-energy", DEFAULT_MINT_VALUES.tower_built / 10, 50); // Partial tower

console.log(`\n  Competing Chain Analysis:`);
console.log(`  ${"─".repeat(70)}`);
console.log(`  Chain           Cost      Mint       Profit     ROI      Priority`);
console.log(`  ${"─".repeat(70)}`);

const competingChains = [
  ["Upgrading", upgradingChain],
  ["Extensions", extensionChain2],
  ["Defense", towerChain]
] as [string, Chain][];

// Sort by profit (what the planner does)
competingChains.sort((a, b) => b[1].profit - a[1].profit);

for (let i = 0; i < competingChains.length; i++) {
  const [name, chain] = competingChains[i];
  const roi = calculateChainROI(chain);
  const priority = i === 0 ? "★ HIGHEST" : i === 1 ? "  Medium" : "  Lowest";
  console.log(`  ${name.padEnd(14)} ${chain.totalCost.toFixed(0).padStart(8)}  ${chain.mintValue.toFixed(0).padStart(8)}  ${chain.profit.toFixed(0).padStart(9)}  ${(roi * 100).toFixed(0).padStart(6)}%  ${priority}`);
}

console.log(`\n  → Planner would fund "${competingChains[0][0]}" chain first (highest profit)`);
console.log(`  → If corps overlap, lower-priority chains may be blocked`);

// ============================================================================
// CHAIN 6: Very Long Chain (8 segments)
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("CHAIN 6: Very Long Chain (8 Segments - Full Economy Loop)");
console.log("=".repeat(70));
console.log(`
  A complete economic loop with many intermediaries:

  RemoteMine → RemoteHaul → BorderTransfer → HomeHaul →
  Storage → SpawnFill → Spawning → UpgradeWork → RCL Progress

  Shows how margins compound over many steps.
`);

const longChainCorps = [
  { id: "remote-mine", type: "mining", balance: 0, desc: "Extract at remote" },
  { id: "remote-haul", type: "hauling", balance: 1000, desc: "Haul to border" },
  { id: "border-xfer", type: "hauling", balance: 500, desc: "Cross room boundary" },
  { id: "home-haul", type: "hauling", balance: 2000, desc: "Haul to storage" },
  { id: "storage-mgr", type: "building", balance: 8000, desc: "Manage storage" },
  { id: "spawn-fill", type: "hauling", balance: 3000, desc: "Fill spawn energy" },
  { id: "spawner", type: "spawning", balance: 5000, desc: "Spawn upgrader" },
  { id: "upgrader", type: "upgrading", balance: 0, desc: "Upgrade controller" },
];

const longSegments: ChainSegment[] = [];
let longCost = 30; // Low base cost (rich remote source)

console.log(`\n  Step-by-step cost accumulation:`);
console.log(`  ${"─".repeat(70)}`);

for (let i = 0; i < longChainCorps.length; i++) {
  const corp = longChainCorps[i];
  const margin = calculateMargin(corp.balance);
  const prevCost = longCost;
  longCost = calculatePrice(longCost, margin);

  const resource = corp.type === "upgrading" ? "rcl-progress" :
                   corp.type === "spawning" ? "spawning" : "energy";

  longSegments.push({
    corpId: corp.id,
    corpType: corp.type as any,
    resource,
    quantity: corp.type === "upgrading" ? 100 : 1000,
    inputCost: prevCost,
    margin,
    outputPrice: longCost
  });

  console.log(`  ${(i + 1).toString().padStart(2)}. ${corp.id.padEnd(14)} ${corp.desc.padEnd(22)} ${prevCost.toFixed(2).padStart(8)} → ${longCost.toFixed(2).padStart(8)} (+${(longCost - prevCost).toFixed(2).padStart(6)}) [${(margin * 100).toFixed(1)}%]`);
}

const longChain = createChain("full-economy-loop", longSegments, 100 * DEFAULT_MINT_VALUES.rcl_upgrade);

console.log(`  ${"─".repeat(70)}`);
console.log(`\n  Final Analysis:`);
console.log(`    Starting cost:      ${30}`);
console.log(`    Final cost:         ${longCost.toFixed(2)}`);
console.log(`    Total margin added: ${(longCost - 30).toFixed(2)}`);
console.log(`    Compounded margin:  ${((longCost / 30 - 1) * 100).toFixed(1)}%`);
console.log(`\n    Mint value:         ${longChain.mintValue}`);
console.log(`    Profit:             ${longChain.profit.toFixed(2)}`);
console.log(`    ROI:                ${(calculateChainROI(longChain) * 100).toFixed(1)}%`);
console.log(`    Viable:             ${isViable(longChain) ? "✓ YES" : "✗ NO"}`);

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("SUMMARY: Key Insights from Complex Chains");
console.log("=".repeat(70));

console.log(`
  1. MARGIN COMPOUNDING
     - Each segment adds 5-10% margin
     - 8 segments with 7.5% avg margin: (1.075)^8 = 1.78x cost increase
     - Wealthy corps (lower margins) significantly reduce chain costs

  2. DISTANCE MATTERS
     - Remote mining adds ~0.01 credits per tile per unit
     - 50-tile haul of 5000 energy adds 2500 to costs
     - Closer sources are more profitable

  3. CHAIN LENGTH TRADE-OFFS
     - Longer chains = more margin accumulation
     - But specialization may increase efficiency
     - Balance between overhead and optimization

  4. COMPETING CHAINS
     - Same resources can serve multiple goals
     - Planner prioritizes by profit
     - Resource constraints prevent parallel execution

  5. MINT VALUES DRIVE BEHAVIOR
     - High mint values (RCL upgrade: ${DEFAULT_MINT_VALUES.rcl_upgrade}) → prioritized
     - Low mint values (Road: ${DEFAULT_MINT_VALUES.road_built}) → deprioritized
     - Adjusting mint values steers colony behavior
`);

console.log("=".repeat(70));
console.log("END OF COMPLEX CHAINS DEMONSTRATION");
console.log("=".repeat(70) + "\n");
