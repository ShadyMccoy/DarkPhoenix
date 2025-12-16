/**
 * Demonstration of cost accumulation through production chains.
 *
 * Shows how margins compound as resources flow through the chain.
 */

import { buildSegment, createChain, calculateProfit, isViable, calculateChainROI } from "../../src/planning/Chain";
import { DEFAULT_MINT_VALUES } from "../../src/colony/MintValues";
import { calculateMargin, calculatePrice } from "../../src/corps/Corp";

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║           COST-PLUS PRICING DEMONSTRATION                            ║");
console.log("║           How margins compound through production chains             ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");

// ============================================================================
// EXAMPLE 1: Simple 2-segment chain
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("EXAMPLE 1: Mining → Upgrading (2 segments)");
console.log("=".repeat(70));

const miningMargin = calculateMargin(0);       // 10% (poor corp)
const upgradingMargin = calculateMargin(0);    // 10% (poor corp)

console.log(`\n  Step 1: Mining Corp (balance: 0, margin: ${(miningMargin * 100).toFixed(1)}%)`);
console.log(`    - Input cost: 0 (raw extraction)`);
const miningOutput = calculatePrice(0, miningMargin);
console.log(`    - Output price: ${miningOutput.toFixed(2)}`);

console.log(`\n  Step 2: Upgrading Corp (balance: 0, margin: ${(upgradingMargin * 100).toFixed(1)}%)`);
console.log(`    - Input cost: ${miningOutput.toFixed(2)} (from mining)`);
const upgradingOutput = calculatePrice(miningOutput, upgradingMargin);
console.log(`    - Output price: ${upgradingOutput.toFixed(2)}`);

const rclPoints = 100;
const mintValue = rclPoints * DEFAULT_MINT_VALUES.rcl_upgrade;
const profit = mintValue - upgradingOutput;

console.log(`\n  Chain Economics:`);
console.log(`    - RCL points produced: ${rclPoints}`);
console.log(`    - Mint value: ${rclPoints} × ${DEFAULT_MINT_VALUES.rcl_upgrade} = ${mintValue}`);
console.log(`    - Total cost: ${upgradingOutput.toFixed(2)}`);
console.log(`    - Profit: ${profit.toFixed(2)}`);
console.log(`    - Viable: ${profit > 0 ? '✓ YES' : '✗ NO'}`);

// ============================================================================
// EXAMPLE 2: 3-segment chain with real costs
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("EXAMPLE 2: Mining → Hauling → Upgrading (with base extraction cost)");
console.log("=".repeat(70));

// Assume mining has some base cost (spawn creep, etc)
const baseMiningCost = 50; // Energy cost to mine

const minerMargin = calculateMargin(0);     // 10% (poor)
const haulerMargin = calculateMargin(5000); // 7.5% (moderate wealth)
const upgraderMargin = calculateMargin(0);  // 10% (poor)

console.log(`\n  Step 1: Mining Corp`);
console.log(`    - Balance: 0, Margin: ${(minerMargin * 100).toFixed(1)}%`);
console.log(`    - Base cost (spawn + ops): ${baseMiningCost}`);
const minerOutput = calculatePrice(baseMiningCost, minerMargin);
console.log(`    - Output price: ${baseMiningCost} × ${(1 + minerMargin).toFixed(2)} = ${minerOutput.toFixed(2)}`);

console.log(`\n  Step 2: Hauling Corp`);
console.log(`    - Balance: 5000, Margin: ${(haulerMargin * 100).toFixed(1)}%`);
console.log(`    - Input cost: ${minerOutput.toFixed(2)}`);
const haulerOutput = calculatePrice(minerOutput, haulerMargin);
console.log(`    - Output price: ${minerOutput.toFixed(2)} × ${(1 + haulerMargin).toFixed(2)} = ${haulerOutput.toFixed(2)}`);

console.log(`\n  Step 3: Upgrading Corp`);
console.log(`    - Balance: 0, Margin: ${(upgraderMargin * 100).toFixed(1)}%`);
console.log(`    - Input cost: ${haulerOutput.toFixed(2)}`);
const upgraderOutput = calculatePrice(haulerOutput, upgraderMargin);
console.log(`    - Output price: ${haulerOutput.toFixed(2)} × ${(1 + upgraderMargin).toFixed(2)} = ${upgraderOutput.toFixed(2)}`);

const rclPoints2 = 100;
const mintValue2 = rclPoints2 * DEFAULT_MINT_VALUES.rcl_upgrade;
const profit2 = mintValue2 - upgraderOutput;

console.log(`\n  Chain Economics:`);
console.log(`    - Base cost: ${baseMiningCost}`);
console.log(`    - After mining margin: ${minerOutput.toFixed(2)} (+${(minerOutput - baseMiningCost).toFixed(2)})`);
console.log(`    - After hauling margin: ${haulerOutput.toFixed(2)} (+${(haulerOutput - minerOutput).toFixed(2)})`);
console.log(`    - After upgrading margin: ${upgraderOutput.toFixed(2)} (+${(upgraderOutput - haulerOutput).toFixed(2)})`);
console.log(`    - Total margin added: ${(upgraderOutput - baseMiningCost).toFixed(2)}`);
console.log(`    - Effective margin: ${((upgraderOutput / baseMiningCost - 1) * 100).toFixed(1)}%`);
console.log(`\n    - Mint value: ${mintValue2}`);
console.log(`    - Total cost: ${upgraderOutput.toFixed(2)}`);
console.log(`    - Profit: ${profit2.toFixed(2)}`);
console.log(`    - ROI: ${((profit2 / upgraderOutput) * 100).toFixed(1)}%`);

// ============================================================================
// EXAMPLE 3: Wealth affects competitiveness
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("EXAMPLE 3: Wealthy Corps vs Poor Corps Competition");
console.log("=".repeat(70));

const poorCorpMargin = calculateMargin(0);        // 10%
const wealthyCorpMargin = calculateMargin(10000); // 5%

console.log(`\n  Same base cost: 100`);
console.log(`\n  Poor Corp (balance: 0):`);
console.log(`    - Margin: ${(poorCorpMargin * 100).toFixed(1)}%`);
const poorOutput = calculatePrice(100, poorCorpMargin);
console.log(`    - Sells at: ${poorOutput.toFixed(2)}`);

console.log(`\n  Wealthy Corp (balance: 10000):`);
console.log(`    - Margin: ${(wealthyCorpMargin * 100).toFixed(1)}%`);
const wealthyOutput = calculatePrice(100, wealthyCorpMargin);
console.log(`    - Sells at: ${wealthyOutput.toFixed(2)}`);

console.log(`\n  Result: Wealthy corp undercuts by ${(poorOutput - wealthyOutput).toFixed(2)}`);
console.log(`  Buyers prefer wealthy corp's offer!`);

// ============================================================================
// EXAMPLE 4: Chain viability threshold
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("EXAMPLE 4: Finding the Break-Even Point");
console.log("=".repeat(70));

console.log(`\n  Mint value per RCL point: ${DEFAULT_MINT_VALUES.rcl_upgrade}`);
console.log(`  Question: What's the maximum cost we can afford per RCL point?`);

// Work backwards from mint value
const targetRclPoints = 100;
const totalMint = targetRclPoints * DEFAULT_MINT_VALUES.rcl_upgrade;
console.log(`\n  For ${targetRclPoints} RCL points:`);
console.log(`    - Total mint value: ${totalMint}`);
console.log(`    - Break-even cost: ${totalMint} per ${targetRclPoints} points = ${totalMint / targetRclPoints} per point`);

// Test different base costs
console.log(`\n  Cost scenarios (with 10% margin at each of 3 steps):`);
for (const baseCost of [100, 500, 1000, 2000, 5000, 10000]) {
  let cost = baseCost;
  for (let i = 0; i < 3; i++) {
    cost = calculatePrice(cost, 0.10);
  }
  const profit = totalMint - cost;
  const viable = profit > 0;
  console.log(`    Base ${baseCost.toString().padStart(5)} → Final ${cost.toFixed(0).padStart(6)} → Profit ${profit.toFixed(0).padStart(7)} ${viable ? '✓' : '✗'}`);
}

// ============================================================================
// EXAMPLE 5: Building actual Chain objects
// ============================================================================
console.log("\n" + "=".repeat(70));
console.log("EXAMPLE 5: Building Chain Data Structures");
console.log("=".repeat(70));

const seg1 = buildSegment("mining-corp", "mining", "energy", 1000, 50, 0.10);
const seg2 = buildSegment("hauling-corp", "hauling", "energy", 1000, seg1.outputPrice, 0.075);
const seg3 = buildSegment("upgrading-corp", "upgrading", "rcl-progress", 100, seg2.outputPrice, 0.10);

const chain = createChain("demo-chain", [seg1, seg2, seg3], 100 * DEFAULT_MINT_VALUES.rcl_upgrade);

console.log(`\n  Chain: ${chain.id}`);
console.log(`  Segments:`);
for (const seg of chain.segments) {
  console.log(`    ${seg.corpType}: ${seg.inputCost.toFixed(2)} → ${seg.outputPrice.toFixed(2)} (margin ${(seg.margin * 100).toFixed(1)}%)`);
}
console.log(`\n  Leaf cost: ${chain.leafCost.toFixed(2)}`);
console.log(`  Total cost: ${chain.totalCost.toFixed(2)}`);
console.log(`  Mint value: ${chain.mintValue.toFixed(2)}`);
console.log(`  Profit: ${chain.profit.toFixed(2)}`);
console.log(`  ROI: ${(calculateChainROI(chain) * 100).toFixed(1)}%`);
console.log(`  Viable: ${isViable(chain) ? '✓ YES' : '✗ NO'}`);

console.log("\n" + "=".repeat(70));
console.log("END OF DEMONSTRATION");
console.log("=".repeat(70) + "\n");
