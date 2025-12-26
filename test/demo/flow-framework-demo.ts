/**
 * Flow Framework Demo - From Simple to Complex
 *
 * This demo walks through the flow-based edge framework,
 * starting with trivial examples and building up to real game data.
 *
 * Run with: npx ts-node test/demo/flow-framework-demo.ts
 */

import {
  createSupplyEdge,
  createCarryEdge,
  calculateSupplyEdgeNetEnergy,
  calculateSupplyEdgeNetPerTick,
  calculateCarryEdgeThroughput,
  calculateCarryEdgeCostPerEnergy,
  calculateCarryEdgeEfficiency,
  calculateMinerSpawnCost,
  calculateHaulerSpawnCost,
  SupplyEdge,
  CarryEdge,
} from "../../src/framework/FlowEdge";

import {
  solveFlowBalance,
  formatFlowAllocation,
} from "../../src/framework/FlowBalance";

// ANSI colors for pretty output
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function header(title: string): void {
  console.log("\n" + colors.bright + colors.cyan + "═".repeat(60) + colors.reset);
  console.log(colors.bright + colors.cyan + " " + title + colors.reset);
  console.log(colors.cyan + "═".repeat(60) + colors.reset + "\n");
}

function section(title: string): void {
  console.log("\n" + colors.yellow + "── " + title + " ──" + colors.reset + "\n");
}

function metric(label: string, value: string | number, unit: string = ""): void {
  const v = typeof value === "number" ? value.toFixed(2) : value;
  console.log(`  ${colors.dim}${label}:${colors.reset} ${colors.green}${v}${colors.reset} ${unit}`);
}

// ============================================================================
// EXAMPLE 1: Single Miner Basics
// ============================================================================

function example1_singleMiner(): void {
  header("EXAMPLE 1: Single Miner Basics");

  console.log("The most fundamental unit: one miner at one source.");
  console.log("Let's understand the energy math.\n");

  section("Body Cost Calculation");

  // A standard miner: 5 WORK parts for a 3000-capacity source
  const workParts = 5;
  const minerCost = calculateMinerSpawnCost(workParts);

  console.log(`  Miner body: ${workParts} WORK + ${Math.ceil(workParts / 2)} MOVE`);
  console.log(`  Body cost breakdown:`);
  console.log(`    - WORK parts: ${workParts} × 100 = ${workParts * 100} energy`);
  console.log(`    - MOVE parts: ${Math.ceil(workParts / 2)} × 50 = ${Math.ceil(workParts / 2) * 50} energy`);
  metric("Total spawn cost", minerCost, "energy");

  section("Harvest Rate");

  const harvestPerTick = workParts * 2;
  const sourceCapacity = 3000;
  const regenPeriod = 300;
  const sourceRateLimit = sourceCapacity / regenPeriod;

  console.log(`  Each WORK part harvests 2 energy/tick`);
  console.log(`  ${workParts} WORK parts → ${harvestPerTick} energy/tick`);
  console.log(`  Source regenerates ${sourceCapacity} energy every ${regenPeriod} ticks`);
  console.log(`  Source rate limit: ${sourceCapacity}/${regenPeriod} = ${sourceRateLimit} energy/tick`);
  metric("Actual harvest rate", Math.min(harvestPerTick, sourceRateLimit), "energy/tick");

  section("Lifetime Production");

  const lifetime = 1500;
  const regenCycles = Math.floor(lifetime / regenPeriod);
  const totalHarvested = regenCycles * sourceCapacity;
  const netEnergy = totalHarvested - minerCost;
  const netPerTick = netEnergy / lifetime;

  console.log(`  Creep lifetime: ${lifetime} ticks`);
  console.log(`  Regen cycles during lifetime: ${regenCycles}`);
  console.log(`  Total energy harvested: ${regenCycles} × ${sourceCapacity} = ${totalHarvested}`);
  console.log(`  Minus spawn cost: ${totalHarvested} - ${minerCost} = ${netEnergy}`);
  metric("Net energy", netEnergy, "energy over lifetime");
  metric("Net per tick", netPerTick, "energy/tick");
  metric("Efficiency", ((netEnergy / totalHarvested) * 100), "%");
}

// ============================================================================
// EXAMPLE 2: Local Source (No Hauling Needed)
// ============================================================================

function example2_localSource(): void {
  header("EXAMPLE 2: Local Source (Spawn Adjacent)");

  console.log("When a source is in the same node as the spawn,");
  console.log("we don't need haulers - the miner can drop energy directly.\n");

  const edge = createSupplyEdge({
    sourceId: "source-local",
    sourceNodeId: "node-spawn",  // Same node as spawn
    sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
    sourceCapacity: 3000,
    spawnId: "spawn-1",
    spawnNodeId: "node-spawn",
    spawnToSourceDistance: 5,  // Very close
  });

  section("Supply Edge Properties");

  metric("Source capacity", edge.sourceCapacity, "energy/regen");
  metric("Miner WORK parts", edge.minerWorkParts);
  metric("Miner spawn cost", edge.minerSpawnCost, "energy");
  metric("Distance to source", edge.spawnToSourceDistance, "tiles");

  section("Energy Production");

  const netEnergy = calculateSupplyEdgeNetEnergy(edge);
  const netPerTick = calculateSupplyEdgeNetPerTick(edge);

  metric("Net energy (lifetime)", netEnergy, "energy");
  metric("Net per tick", netPerTick, "energy/tick");

  section("Flow Balance (Single Local Source)");

  const result = solveFlowBalance([edge], []);

  console.log(`  Sustainable: ${result.isSustainable ? colors.green + "YES" : colors.red + "NO"}${colors.reset}`);
  metric("Total production", result.totalProduction, "/tick");
  metric("Total overhead", result.totalOverhead, "/tick");
  metric("Available for projects", result.projectEnergy, "/tick");
}

// ============================================================================
// EXAMPLE 3: Remote Source (Hauling Required)
// ============================================================================

function example3_remoteSource(): void {
  header("EXAMPLE 3: Remote Source (Hauling Required)");

  console.log("When a source is in a different node, we need haulers");
  console.log("to transport energy back to the spawn.\n");

  // Source is 50 tiles away
  const supplyEdge = createSupplyEdge({
    sourceId: "source-remote",
    sourceNodeId: "node-source",  // Different from spawn
    sourcePosition: { x: 10, y: 10, roomName: "E2N1" },
    sourceCapacity: 3000,
    spawnId: "spawn-1",
    spawnNodeId: "node-spawn",
    spawnToSourceDistance: 50,
  });

  const carryEdge = createCarryEdge({
    fromNodeId: "node-spawn",
    toNodeId: "node-source",
    spawnId: "spawn-1",
    walkingDistance: 50,
  });

  section("Supply Edge (Mining)");

  metric("Source capacity", supplyEdge.sourceCapacity, "/regen");
  metric("Miner spawn cost", supplyEdge.minerSpawnCost, "energy");
  metric("Net per tick", calculateSupplyEdgeNetPerTick(supplyEdge), "energy/tick");

  section("Carry Edge (Hauling)");

  metric("Distance (one way)", carryEdge.walkingDistance, "tiles");
  metric("Round trip time", carryEdge.roundTripTicks, "ticks");
  metric("Hauler capacity", carryEdge.haulerCarryCapacity, "energy");
  metric("Hauler spawn cost", carryEdge.haulerSpawnCost, "energy");

  const throughput = calculateCarryEdgeThroughput(carryEdge);
  const costPerEnergy = calculateCarryEdgeCostPerEnergy(carryEdge);
  const efficiency = calculateCarryEdgeEfficiency(carryEdge);

  metric("Throughput", throughput, "energy/tick");
  metric("Cost per energy", costPerEnergy, "energy");
  metric("Efficiency", (efficiency * 100), "%");

  section("Flow Balance (Remote Source)");

  const result = solveFlowBalance([supplyEdge], [carryEdge]);

  console.log(`  Sustainable: ${result.isSustainable ? colors.green + "YES" : colors.red + "NO"}${colors.reset}`);
  metric("Total production", result.totalProduction, "/tick");
  metric("Total overhead", result.totalOverhead, "/tick");
  metric("Available for projects", result.projectEnergy, "/tick");

  // Show the overhead breakdown
  const miningOverhead = result.supplies.reduce((sum, s) => sum + s.spawnCostPerTick, 0);
  const haulingOverhead = result.carries.reduce((sum, c) => sum + c.spawnCostPerTick, 0);

  section("Overhead Breakdown");

  metric("Mining overhead", miningOverhead, "/tick");
  metric("Hauling overhead", haulingOverhead, "/tick");
  console.log(`\n  ${colors.dim}(Hauling cost is ${((haulingOverhead / result.totalProduction) * 100).toFixed(1)}% of production)${colors.reset}`);
}

// ============================================================================
// EXAMPLE 4: Multiple Sources, Single Spawn
// ============================================================================

function example4_multipleSources(): void {
  header("EXAMPLE 4: Multiple Sources, Single Spawn");

  console.log("A typical early-game setup: one spawn harvesting");
  console.log("two sources - one local, one remote.\n");

  const localSource = createSupplyEdge({
    sourceId: "source-local",
    sourceNodeId: "node-spawn",
    sourcePosition: { x: 12, y: 10, roomName: "E1N1" },
    sourceCapacity: 3000,
    spawnId: "spawn-1",
    spawnNodeId: "node-spawn",
    spawnToSourceDistance: 5,
  });

  const remoteSource = createSupplyEdge({
    sourceId: "source-remote",
    sourceNodeId: "node-remote",
    sourcePosition: { x: 35, y: 25, roomName: "E1N1" },
    sourceCapacity: 3000,
    spawnId: "spawn-1",
    spawnNodeId: "node-spawn",
    spawnToSourceDistance: 30,
  });

  const carryEdge = createCarryEdge({
    fromNodeId: "node-spawn",
    toNodeId: "node-remote",
    spawnId: "spawn-1",
    walkingDistance: 30,
  });

  section("Source Summary");

  console.log("  Source 1 (local):");
  console.log(`    - Distance: ${localSource.spawnToSourceDistance} tiles`);
  console.log(`    - Net: ${calculateSupplyEdgeNetPerTick(localSource).toFixed(2)} energy/tick`);
  console.log(`    - Needs hauling: NO`);

  console.log("\n  Source 2 (remote):");
  console.log(`    - Distance: ${remoteSource.spawnToSourceDistance} tiles`);
  console.log(`    - Net: ${calculateSupplyEdgeNetPerTick(remoteSource).toFixed(2)} energy/tick`);
  console.log(`    - Needs hauling: YES`);

  section("Flow Balance");

  const result = solveFlowBalance([localSource, remoteSource], [carryEdge]);

  console.log(`  Sustainable: ${result.isSustainable ? colors.green + "YES" : colors.red + "NO"}${colors.reset}`);
  metric("Total production", result.totalProduction, "/tick");
  metric("Mining overhead", result.supplies.reduce((sum, s) => sum + s.spawnCostPerTick, 0), "/tick");
  metric("Hauling overhead", result.carries.reduce((sum, c) => sum + c.spawnCostPerTick, 0), "/tick");
  metric("Available for projects", result.projectEnergy, "/tick");

  section("Allocation Details");

  for (const supply of result.supplies) {
    const sourceType = supply.isLocal ? "local" : "remote";
    console.log(`  ${supply.edge.sourceId} (${sourceType}):`);
    console.log(`    - Miners: ${supply.minerCount}`);
    console.log(`    - Harvest: ${supply.harvestPerTick.toFixed(1)}/tick`);
    console.log(`    - Net: ${supply.netPerTick.toFixed(1)}/tick`);
  }
}

// ============================================================================
// EXAMPLE 5: Distance Impact Analysis
// ============================================================================

function example5_distanceImpact(): void {
  header("EXAMPLE 5: Distance Impact Analysis");

  console.log("How does distance affect hauling efficiency?");
  console.log("Let's compare the same source at different distances.\n");

  const distances = [10, 25, 50, 75, 100, 150, 200];

  console.log("  Distance │ Round Trip │ Throughput │ Cost/Energy │ Efficiency");
  console.log("  ─────────┼────────────┼────────────┼─────────────┼───────────");

  for (const distance of distances) {
    const edge = createCarryEdge({
      fromNodeId: "node-spawn",
      toNodeId: "node-source",
      spawnId: "spawn-1",
      walkingDistance: distance,
    });

    const throughput = calculateCarryEdgeThroughput(edge);
    const costPerEnergy = calculateCarryEdgeCostPerEnergy(edge);
    const efficiency = calculateCarryEdgeEfficiency(edge);

    console.log(
      `  ${distance.toString().padStart(8)} │ ` +
      `${edge.roundTripTicks.toString().padStart(10)} │ ` +
      `${throughput.toFixed(2).padStart(10)} │ ` +
      `${costPerEnergy.toFixed(3).padStart(11)} │ ` +
      `${(efficiency * 100).toFixed(1).padStart(9)}%`
    );
  }

  section("Key Insights");

  console.log("  • At 10 tiles: ~98% efficiency - negligible hauling cost");
  console.log("  • At 50 tiles: ~87% efficiency - noticeable but acceptable");
  console.log("  • At 100 tiles: ~77% efficiency - significant overhead");
  console.log("  • At 200 tiles: ~63% efficiency - consider if worth mining");
}

// ============================================================================
// EXAMPLE 6: Bootstrap Problem Demonstration
// ============================================================================

function example6_bootstrapProblem(): void {
  header("EXAMPLE 6: The Bootstrap Problem");

  console.log("The circular dependency:");
  console.log("  • Hauling requires creeps");
  console.log("  • Creeps require spawning");
  console.log("  • Spawning requires energy");
  console.log("  • Energy requires hauling\n");

  console.log("Let's see how the solver handles this.\n");

  section("Scenario: Very Long Distance Source");

  // Extreme case: very long distance with minimal source
  const supplyEdge = createSupplyEdge({
    sourceId: "source-far",
    sourceNodeId: "node-far",
    sourcePosition: { x: 10, y: 10, roomName: "E3N1" },
    sourceCapacity: 1500,  // Smaller source (SK room source)
    spawnId: "spawn-1",
    spawnNodeId: "node-spawn",
    spawnToSourceDistance: 150,
    minerWorkParts: 3,  // Smaller miner
  });

  const carryEdge = createCarryEdge({
    fromNodeId: "node-spawn",
    toNodeId: "node-far",
    spawnId: "spawn-1",
    walkingDistance: 150,
    haulerCarryParts: 10,
  });

  console.log("  Setup:");
  console.log(`    - Source capacity: ${supplyEdge.sourceCapacity}/regen`);
  console.log(`    - Distance: ${carryEdge.walkingDistance} tiles`);
  console.log(`    - Hauler efficiency: ${(calculateCarryEdgeEfficiency(carryEdge) * 100).toFixed(1)}%`);

  section("Flow Balance Result");

  const result = solveFlowBalance([supplyEdge], [carryEdge]);

  console.log(`  Sustainable: ${result.isSustainable ? colors.green + "YES" : colors.red + "NO"}${colors.reset}`);
  metric("Production", result.totalProduction, "/tick");
  metric("Overhead", result.totalOverhead, "/tick");
  metric("Net for projects", result.projectEnergy, "/tick");

  if (!result.isSustainable) {
    console.log(`\n  ${colors.red}⚠ The system cannot sustain itself!${colors.reset}`);
    console.log("  The solver trimmed miners to minimize the deficit.");
  }

  section("What the Solver Did");

  for (const supply of result.supplies) {
    console.log(`  ${supply.edge.sourceId}:`);
    console.log(`    - Miners allocated: ${supply.minerCount}`);
    console.log(`    - Harvest rate: ${supply.harvestPerTick.toFixed(2)}/tick`);
  }

  for (const carry of result.carries) {
    if (carry.haulerCount > 0) {
      console.log(`  Hauling route:`);
      console.log(`    - Haulers allocated: ${carry.haulerCount}`);
      console.log(`    - Throughput: ${carry.throughputPerTick.toFixed(2)}/tick`);
    }
  }
}

// ============================================================================
// EXAMPLE 7: Real Game Data Simulation
// ============================================================================

function example7_realGameData(): void {
  header("EXAMPLE 7: Real Game Data Simulation");

  console.log("Simulating a typical RCL 3-4 room with real distances.\n");

  // Based on E75N8 from the snapshot
  const sources: SupplyEdge[] = [
    createSupplyEdge({
      sourceId: "5bbcaeb69099fc012e63b66e",  // Real source ID format
      sourceNodeId: "E75N8-47-36",
      sourcePosition: { x: 33, y: 3, roomName: "E75N8" },
      sourceCapacity: 3000,
      spawnId: "Spawn1",
      spawnNodeId: "E75N8-26-24",
      spawnToSourceDistance: 25,
    }),
    createSupplyEdge({
      sourceId: "5bbcaeb69099fc012e63b66f",
      sourceNodeId: "E75N8-4-12",
      sourcePosition: { x: 4, y: 16, roomName: "E75N8" },
      sourceCapacity: 3000,
      spawnId: "Spawn1",
      spawnNodeId: "E75N8-26-24",
      spawnToSourceDistance: 30,
    }),
  ];

  const carryEdges: CarryEdge[] = [
    createCarryEdge({
      fromNodeId: "E75N8-26-24",
      toNodeId: "E75N8-47-36",
      spawnId: "Spawn1",
      walkingDistance: 25,
      haulerCarryParts: 8,
    }),
    createCarryEdge({
      fromNodeId: "E75N8-26-24",
      toNodeId: "E75N8-4-12",
      spawnId: "Spawn1",
      walkingDistance: 30,
      haulerCarryParts: 8,
    }),
  ];

  section("Room Layout");

  console.log("  Room: E75N8 (RCL 4)");
  console.log("  Spawn: E75N8-26-24");
  console.log("\n  Sources:");
  for (const source of sources) {
    console.log(`    - ${source.sourceId.slice(-4)}: ${source.spawnToSourceDistance} tiles away`);
  }

  section("Energy Analysis");

  const result = solveFlowBalance(sources, carryEdges);

  console.log(`  Sustainable: ${result.isSustainable ? colors.green + "YES" : colors.red + "NO"}${colors.reset}\n`);

  // Detailed breakdown
  console.log("  Per-tick flows:");
  console.log("  ┌──────────────────────────────────────────────────┐");
  console.log(`  │  Gross Production:  ${result.totalProduction.toFixed(1).padStart(8)} energy/tick      │`);
  console.log("  │  ────────────────────────────────────────────    │");
  console.log(`  │  Mining Overhead:   ${result.supplies.reduce((s, x) => s + x.spawnCostPerTick, 0).toFixed(1).padStart(8)} energy/tick      │`);
  console.log(`  │  Hauling Overhead:  ${result.carries.reduce((s, x) => s + x.spawnCostPerTick, 0).toFixed(1).padStart(8)} energy/tick      │`);
  console.log("  │  ────────────────────────────────────────────    │");
  console.log(`  │  ${colors.green}Project Energy:    ${result.projectEnergy.toFixed(1).padStart(8)} energy/tick${colors.reset}      │`);
  console.log("  └──────────────────────────────────────────────────┘");

  section("What Can We Do With This?");

  const upgradeWorkParts = Math.floor(result.projectEnergy / 1);  // 1 energy per upgrade per WORK
  const buildWorkParts = Math.floor(result.projectEnergy / 5);     // 5 energy per build per WORK

  console.log(`  Upgrading: ~${upgradeWorkParts} WORK parts worth of upgraders`);
  console.log(`  Building:  ~${buildWorkParts} WORK parts worth of builders`);
  console.log(`\n  Or any combination thereof!`);
}

// ============================================================================
// EXAMPLE 8: Full Economy Summary
// ============================================================================

function example8_fullEconomy(): void {
  header("EXAMPLE 8: Full Economy Summary");

  console.log("Putting it all together - a complete room economy.\n");

  // Simulate a mature room
  const sources = [
    createSupplyEdge({
      sourceId: "source-1",
      sourceNodeId: "node-spawn",
      sourcePosition: { x: 20, y: 20, roomName: "E1N1" },
      sourceCapacity: 3000,
      spawnId: "spawn-1",
      spawnNodeId: "node-spawn",
      spawnToSourceDistance: 8,
    }),
    createSupplyEdge({
      sourceId: "source-2",
      sourceNodeId: "node-2",
      sourcePosition: { x: 40, y: 20, roomName: "E1N1" },
      sourceCapacity: 3000,
      spawnId: "spawn-1",
      spawnNodeId: "node-spawn",
      spawnToSourceDistance: 25,
    }),
  ];

  const carries = [
    createCarryEdge({
      fromNodeId: "node-spawn",
      toNodeId: "node-2",
      spawnId: "spawn-1",
      walkingDistance: 25,
    }),
  ];

  const result = solveFlowBalance(sources, carries);

  section("Economy Dashboard");

  console.log(formatFlowAllocation(result));

  section("Efficiency Metrics");

  const grossProduction = result.supplies.reduce((s, x) => s + x.harvestPerTick, 0);
  const miningCost = result.supplies.reduce((s, x) => s + x.spawnCostPerTick, 0);
  const haulingCost = result.carries.reduce((s, x) => s + x.spawnCostPerTick, 0);

  console.log(`  Mining efficiency:  ${((1 - miningCost / grossProduction) * 100).toFixed(1)}%`);
  console.log(`  Hauling efficiency: ${((1 - haulingCost / grossProduction) * 100).toFixed(1)}%`);
  console.log(`  Overall efficiency: ${((result.projectEnergy / grossProduction) * 100).toFixed(1)}%`);
}

// ============================================================================
// Main
// ============================================================================

function main(): void {
  console.log(colors.bright + colors.white);
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║                                                            ║");
  console.log("║            FLOW FRAMEWORK DEMO                             ║");
  console.log("║        From Simple to Complex Examples                     ║");
  console.log("║                                                            ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(colors.reset);

  example1_singleMiner();
  example2_localSource();
  example3_remoteSource();
  example4_multipleSources();
  example5_distanceImpact();
  example6_bootstrapProblem();
  example7_realGameData();
  example8_fullEconomy();

  console.log("\n" + colors.green + "Demo complete!" + colors.reset + "\n");
}

main();
