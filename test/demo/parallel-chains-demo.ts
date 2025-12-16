/**
 * Demonstration of parallel chain execution with excess capacity.
 *
 * Shows that both local AND remote chains should run when:
 * - Both are profitable (profit > 0)
 * - They don't compete for the same resources (different corps)
 * - Treasury can afford to fund both
 */

import { buildSegment, createChain, Chain, isViable, calculateChainROI, selectNonOverlapping, chainsOverlap } from "../../src/planning/Chain";
import { DEFAULT_MINT_VALUES } from "../../src/colony/MintValues";
import { calculateMargin, calculatePrice } from "../../src/corps/Corp";

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║           PARALLEL CHAINS WITH EXCESS CAPACITY                       ║");
console.log("║           Running both local AND remote when both are profitable    ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ============================================================================
// SCENARIO: Two Sources, One Spawn, Excess Capacity
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("SCENARIO: Local + Remote Mining with Excess Spawn Capacity");
console.log("=".repeat(70));
console.log(`
  Colony has:
  - 1 local source (close, cheap hauling)
  - 1 remote source (far, expensive hauling)
  - 1 spawn with capacity for 2 upgrader creeps

  Question: Should we mine ONLY local, or BOTH?
  Answer: BOTH - if both chains are profitable!
`);

// Helper to build a mining chain
function buildMiningChain(
  name: string,
  baseCost: number,
  distancePenalty: number,
  energyQuantity: number,
  rclOutput: number
): Chain {
  const segments = [];
  let cost = baseCost;

  // Mining
  const mMargin = calculateMargin(1000);
  cost = calculatePrice(cost, mMargin);
  segments.push(buildSegment(`${name}-miner`, "mining", "energy", energyQuantity, baseCost, mMargin));

  // Hauling (includes distance penalty)
  const hMargin = calculateMargin(2000);
  const haulerInput = cost + distancePenalty;
  cost = calculatePrice(haulerInput, hMargin);
  segments.push(buildSegment(`${name}-hauler`, "hauling", "energy", energyQuantity, haulerInput, hMargin));

  // Spawning (dedicated upgrader)
  const sMargin = calculateMargin(5000);
  cost = calculatePrice(cost + 50, sMargin); // +50 spawn time cost
  segments.push(buildSegment(`${name}-spawn`, "spawning", "work-ticks", 1500, segments[1].outputPrice + 50, sMargin));

  // Upgrading
  const uMargin = calculateMargin(0);
  cost = calculatePrice(cost, uMargin);
  segments.push(buildSegment(`${name}-upgrader`, "upgrading", "rcl-progress", rclOutput, segments[2].outputPrice, uMargin));

  return createChain(`${name}-chain`, segments, rclOutput * DEFAULT_MINT_VALUES.rcl_upgrade);
}

// Local chain: close source, no distance penalty
const localChain = buildMiningChain("local", 30, 0, 3000, 300);

// Remote chain: far source, 50-tile distance penalty
const distancePenalty = 50 * 0.01 * 3000; // 50 tiles × 0.01/tile × 3000 energy
const remoteChain = buildMiningChain("remote", 20, distancePenalty, 3000, 300); // Richer source (lower base cost)

console.log(`\n  Chain Comparison:`);
console.log(`  ${"─".repeat(65)}`);
console.log(`  Chain     Base   Distance   Total    Mint      Profit     ROI`);
console.log(`            Cost   Penalty    Cost     Value`);
console.log(`  ${"─".repeat(65)}`);

for (const [name, chain] of [["Local", localChain], ["Remote", remoteChain]] as [string, Chain][]) {
  const distPen = name === "Remote" ? distancePenalty : 0;
  console.log(`  ${name.padEnd(8)} ${(name === "Local" ? 30 : 20).toString().padStart(5)}  ${distPen.toFixed(0).padStart(8)}  ${chain.totalCost.toFixed(0).padStart(7)}  ${chain.mintValue.toFixed(0).padStart(7)}  ${chain.profit.toFixed(0).padStart(9)}  ${(calculateChainROI(chain) * 100).toFixed(0).padStart(5)}%`);
}

console.log(`\n  Key insight: Remote is LESS profitable, but still VERY profitable!`);
console.log(`  Local ROI: ${(calculateChainROI(localChain) * 100).toFixed(0)}%`);
console.log(`  Remote ROI: ${(calculateChainROI(remoteChain) * 100).toFixed(0)}%`);

// ============================================================================
// Do the chains overlap?
// ============================================================================
console.log("\n" + "─".repeat(70));
console.log("  Chain Independence Check:");
console.log("─".repeat(70));

const overlap = chainsOverlap(localChain, remoteChain);
console.log(`\n  Do chains share any corps? ${overlap ? "YES ⚠️" : "NO ✓"}`);

console.log(`\n  Local chain corps:`);
for (const seg of localChain.segments) {
  console.log(`    - ${seg.corpId}`);
}

console.log(`\n  Remote chain corps:`);
for (const seg of remoteChain.segments) {
  console.log(`    - ${seg.corpId}`);
}

if (!overlap) {
  console.log(`\n  ✓ Chains are independent - can run in parallel!`);
}

// ============================================================================
// Total output when running both
// ============================================================================
console.log("\n" + "─".repeat(70));
console.log("  Combined Output Analysis:");
console.log("─".repeat(70));

const localOnly = {
  cost: localChain.totalCost,
  mint: localChain.mintValue,
  profit: localChain.profit,
  rcl: 300
};

const both = {
  cost: localChain.totalCost + remoteChain.totalCost,
  mint: localChain.mintValue + remoteChain.mintValue,
  profit: localChain.profit + remoteChain.profit,
  rcl: 600
};

console.log(`
  Option A: Local Only
    - Cost:   ${localOnly.cost.toFixed(0)}
    - Mint:   ${localOnly.mint.toFixed(0)}
    - Profit: ${localOnly.profit.toFixed(0)}
    - RCL output: ${localOnly.rcl} points

  Option B: Local + Remote (Parallel)
    - Cost:   ${both.cost.toFixed(0)}
    - Mint:   ${both.mint.toFixed(0)}
    - Profit: ${both.profit.toFixed(0)}
    - RCL output: ${both.rcl} points

  Improvement from running both:
    - Extra cost:   +${(both.cost - localOnly.cost).toFixed(0)}
    - Extra profit: +${(both.profit - localOnly.profit).toFixed(0)}
    - Extra RCL:    +${both.rcl - localOnly.rcl} points (${((both.rcl / localOnly.rcl - 1) * 100).toFixed(0)}% more!)
`);

// ============================================================================
// What if we have 3 sources?
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("SCENARIO: Three Sources - Prioritization");
console.log("=".repeat(70));
console.log(`
  Colony expands to have:
  - Local source (distance: 0)
  - Near remote (distance: 30 tiles)
  - Far remote (distance: 80 tiles)

  With limited spawn capacity, which should we prioritize?
`);

const chains = [
  buildMiningChain("local", 30, 0, 3000, 300),
  buildMiningChain("near-remote", 25, 30 * 0.01 * 3000, 3000, 300),
  buildMiningChain("far-remote", 20, 80 * 0.01 * 3000, 3000, 300),
];

// Sort by profit (what planner does)
chains.sort((a, b) => b.profit - a.profit);

console.log(`\n  Chains ranked by profit:`);
console.log(`  ${"─".repeat(55)}`);
console.log(`  Rank  Chain          Cost      Profit    ROI      Viable`);
console.log(`  ${"─".repeat(55)}`);

for (let i = 0; i < chains.length; i++) {
  const c = chains[i];
  const name = c.id.replace("-chain", "");
  console.log(`   ${i + 1}.   ${name.padEnd(14)} ${c.totalCost.toFixed(0).padStart(7)}  ${c.profit.toFixed(0).padStart(9)}  ${(calculateChainROI(c) * 100).toFixed(0).padStart(5)}%  ${isViable(c) ? "  ✓" : "  ✗"}`);
}

console.log(`\n  With unlimited capacity: Run ALL THREE (total profit: ${chains.reduce((s, c) => s + c.profit, 0).toFixed(0)})`);
console.log(`  With 2 spawn slots: Run #1 and #2 (total profit: ${(chains[0].profit + chains[1].profit).toFixed(0)})`);
console.log(`  With 1 spawn slot: Run #1 only (total profit: ${chains[0].profit.toFixed(0)})`);

// ============================================================================
// Shared resource scenario
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("SCENARIO: Shared Spawn - Chains DO Overlap");
console.log("=".repeat(70));
console.log(`
  What if both chains need the SAME spawn?

  Local:  LocalMiner → LocalHauler → [SharedSpawn] → LocalUpgrader
  Remote: RemoteMiner → RemoteHauler → [SharedSpawn] → RemoteUpgrader
                                          ↑
                                    Bottleneck!
`);

// Build chains that share a spawn corp
function buildChainWithSharedSpawn(name: string, distancePenalty: number): Chain {
  const segments = [];
  let cost = 30;

  // Mining (unique)
  const mMargin = calculateMargin(1000);
  cost = calculatePrice(cost, mMargin);
  segments.push(buildSegment(`${name}-miner`, "mining", "energy", 3000, 30, mMargin));

  // Hauling (unique)
  const hMargin = calculateMargin(2000);
  const haulerInput = cost + distancePenalty;
  cost = calculatePrice(haulerInput, hMargin);
  segments.push(buildSegment(`${name}-hauler`, "hauling", "energy", 3000, haulerInput, hMargin));

  // Spawning (SHARED!)
  const sMargin = calculateMargin(5000);
  cost = calculatePrice(cost + 50, sMargin);
  segments.push(buildSegment("shared-spawn", "spawning", "work-ticks", 1500, segments[1].outputPrice + 50, sMargin));

  // Upgrading (unique)
  const uMargin = calculateMargin(0);
  cost = calculatePrice(cost, uMargin);
  segments.push(buildSegment(`${name}-upgrader`, "upgrading", "rcl-progress", 300, segments[2].outputPrice, uMargin));

  return createChain(`${name}-shared-spawn`, segments, 300 * DEFAULT_MINT_VALUES.rcl_upgrade);
}

const localShared = buildChainWithSharedSpawn("local", 0);
const remoteShared = buildChainWithSharedSpawn("remote", 50 * 0.01 * 3000);

const sharedOverlap = chainsOverlap(localShared, remoteShared);
console.log(`\n  Do chains share corps? ${sharedOverlap ? "YES ⚠️" : "NO ✓"}`);

if (sharedOverlap) {
  console.log(`\n  Shared corp: "shared-spawn"`);
  console.log(`\n  Since chains overlap, planner must choose ONE:`);

  const sharedChains = [localShared, remoteShared];
  sharedChains.sort((a, b) => b.profit - a.profit);

  console.log(`\n  Selection (by profit):`);
  for (let i = 0; i < sharedChains.length; i++) {
    const c = sharedChains[i];
    const selected = i === 0;
    console.log(`    ${selected ? "✓" : "✗"} ${c.id.padEnd(25)} profit: ${c.profit.toFixed(0)}`);
  }

  const selected = selectNonOverlapping(sharedChains);
  console.log(`\n  Result: Only "${selected[0].id}" runs`);
  console.log(`  Lost profit from not running remote: ${remoteShared.profit.toFixed(0)}`);
}

// ============================================================================
// Solution: Add more spawns!
// ============================================================================
console.log("\n" + "─".repeat(70));
console.log("  Solution: Scale Up Spawns!");
console.log("─".repeat(70));
console.log(`
  If spawn is the bottleneck:
  - Build more spawns (each spawn = new SpawningCorp)
  - Each chain gets its own spawn corp
  - Chains no longer overlap → can run in parallel

  Investment calculation:
    - New spawn cost: ~15,000 energy
    - Mint value for spawn: ${DEFAULT_MINT_VALUES.extension_built * 5} (est.)
    - Enables: +${remoteShared.profit.toFixed(0)} profit from remote chain

  Payback period: Very fast if remote source is profitable!
`);

// ============================================================================
// Summary
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("SUMMARY: Parallel Chain Execution Strategy");
console.log("=".repeat(70));
console.log(`
  1. RUN ALL PROFITABLE CHAINS
     - Don't just pick the "best" one
     - If profit > 0 and no resource conflicts, run it!

  2. PROFIT RANKING MATTERS FOR CONFLICTS
     - When chains share corps, pick highest profit
     - Lower-profit chains get blocked

  3. SCALE BOTTLENECKS
     - If spawn is bottleneck, build more spawns
     - Each new spawn enables a new parallel chain
     - Investment pays off quickly if chains are profitable

  4. DISTANCE REDUCES PROFIT, NOT VIABILITY
     - Remote mining is less efficient per unit
     - But "less efficient profit" is still profit!
     - Total colony output = sum of all chain profits

  5. CAPACITY UTILIZATION IS KEY
     - Idle spawn capacity = wasted potential
     - Even low-margin chains beat idle corps
`);

console.log("=".repeat(70));
console.log("END OF PARALLEL CHAINS DEMONSTRATION");
console.log("=".repeat(70) + "\n");
