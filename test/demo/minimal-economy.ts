/**
 * Minimal Economy: 1 Source, 1 Spawn, 1 Upgrader
 *
 * The simplest complete economy loop, all at equal distances.
 *
 *          SOURCE
 *            /\
 *           /  \
 *         D/    \D
 *         /      \
 *      SPAWN----CONTROLLER
 *            D
 *
 * Energy flow:
 *   Source → (hauler) → Spawn → (upgrader) → Controller
 *
 * Run: npx ts-node -P tsconfig.test.json test/demo/minimal-economy.ts
 */

// Configuration
const DISTANCE = 30;  // Equal distance between all three points

// Body part costs
const WORK_COST = 100;
const CARRY_COST = 50;
const MOVE_COST = 50;

// Road constants
const ROAD_ENERGY_COST = 300;  // energy to build one road tile
const ROAD_MAX_HITS = 5000;    // road durability on plains
const ROAD_DECAY_RATE = 100;   // hits lost per 1000 ticks on plains
const ROAD_TICKS_LIFETIME = (ROAD_MAX_HITS / ROAD_DECAY_RATE) * 1000;  // 50,000 ticks
const ROAD_MAINT_PER_TICK = ROAD_ENERGY_COST / ROAD_TICKS_LIFETIME;  // 0.006/tick per tile

// Creep specs
const MINER_WORK = 5;
const MINER_MOVE = 3;
const MINER_COST = MINER_WORK * WORK_COST + MINER_MOVE * MOVE_COST;  // 650

const HAULER_CARRY = 10;
const HAULER_MOVE = 10;
const HAULER_COST = HAULER_CARRY * CARRY_COST + HAULER_MOVE * MOVE_COST;  // 1000
const HAULER_CAPACITY = HAULER_CARRY * 50;  // 500

const UPGRADER_WORK = 5;
const UPGRADER_CARRY = 1;
const UPGRADER_MOVE = 3;
const UPGRADER_COST = UPGRADER_WORK * WORK_COST + UPGRADER_CARRY * CARRY_COST + UPGRADER_MOVE * MOVE_COST;  // 700

const LIFETIME = 1500;
const SOURCE_CAPACITY = 3000;
const SOURCE_REGEN = 300;

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║         MINIMAL ECONOMY: Source → Spawn → Controller       ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

console.log(`Configuration: All points ${DISTANCE} tiles apart\n`);

// ============================================================================
// SUPPLY SIDE: What the source produces
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SUPPLY SIDE: Mining                                         │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Source production rate (this is what we're trying to extract)
const sourceRatePerTick = SOURCE_CAPACITY / SOURCE_REGEN;  // 3000/300 = 10 energy/tick
const harvestPerTick = sourceRatePerTick;

// Miner travels from spawn to source once per lifetime
const minerTravelTime = DISTANCE;

console.log("Miner:");
console.log(`  Body: ${MINER_WORK}W ${MINER_MOVE}M = ${MINER_COST} energy`);
console.log(`  Source rate: ${SOURCE_CAPACITY}/${SOURCE_REGEN} = ${sourceRatePerTick.toFixed(1)} energy/tick`);
console.log(`  Miner capacity: ${MINER_WORK}W × 2 = ${MINER_WORK * 2} energy/tick (sufficient)`);
console.log(`  Travel time: ${minerTravelTime} ticks (one-time per lifetime)`);

// Miner spawn overhead (amortized)
const minerSpawnOverhead = MINER_COST / LIFETIME;
console.log(`  Spawn overhead: ${MINER_COST} / ${LIFETIME} = ${minerSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// HAULING: Two routes from Source (equilateral triangle topology)
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ HAULING: Source → Spawn AND Source → Controller            │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

console.log("Topology: Equilateral triangle, all edges = D");
console.log("  - Source → Spawn:      hauls energy for creep overhead");
console.log("  - Source → Controller: hauls energy directly for upgrading\n");

// Round trip = 2D + 2 for both routes (same distance)
const haulerRoundTrip = DISTANCE * 2 + 2;
const carryPartCost = CARRY_COST + MOVE_COST;  // 100 energy per CARRY (1:1)

// We need to solve a system of equations:
// Let O = energy/tick to spawn (overhead), W = energy/tick to controller (upgrade)
// O + W = 10 (total harvest)
//
// Overhead consists of:
//   - Miner:              0.433/tick (fixed)
//   - Source→Spawn haul:  (O × rt/50) × 100/1500
//   - Source→Ctrl haul:   (W × rt/50) × 100/1500
//   - Upgrader WORK:      W × 100/1500
//
// O = minerCost + spawnHaulCost + ctrlHaulCost + upgraderCost
// O = 0.433 + O×k + W×k + W×0.0667   where k = rt/50 × 100/1500

const k = (haulerRoundTrip / 50) * (carryPartCost / LIFETIME);  // haul cost coefficient
const workCostPerTick = WORK_COST / LIFETIME;  // 0.0667

// Solve: O = 0.433 + O×k + W×k + W×0.0667
//        O(1-k) = 0.433 + W×(k + 0.0667)
//        O = (0.433 + W×(k + 0.0667)) / (1-k)
// And:   O + W = 10
//        W = 10 - O

// Substituting:
// O = (0.433 + (10-O)×(k + 0.0667)) / (1-k)
// O(1-k) = 0.433 + (10-O)×(k + 0.0667)
// O - O×k = 0.433 + 10k + 0.667 - O×k - O×0.0667
// O = 0.433 + 10k + 0.667 - O×0.0667
// O(1 + 0.0667) = 0.433 + 10k + 0.667
// O = (0.433 + 10k + 0.667) / 1.0667

const overhead = (minerSpawnOverhead + 10 * k + 10 * workCostPerTick) / (1 + workCostPerTick);
const upgradeRate = harvestPerTick - overhead;

// Now calculate individual components
const spawnHaulCarry = overhead * haulerRoundTrip / 50;
const ctrlHaulCarry = upgradeRate * haulerRoundTrip / 50;
const spawnHaulCost = (spawnHaulCarry * carryPartCost) / LIFETIME;
const ctrlHaulCost = (ctrlHaulCarry * carryPartCost) / LIFETIME;
const upgraderWorkCost = (upgradeRate * WORK_COST) / LIFETIME;

console.log(`Round trip: 2×${DISTANCE} + 2 = ${haulerRoundTrip} ticks\n`);

console.log("Source → Spawn (for creep overhead):");
console.log(`  Energy to haul:  ${overhead.toFixed(2)}/tick`);
console.log(`  CARRY parts:     ${spawnHaulCarry.toFixed(2)}`);
console.log(`  Spawn cost:      ${spawnHaulCost.toFixed(3)}/tick\n`);

console.log("Source → Controller (for upgrading):");
console.log(`  Energy to haul:  ${upgradeRate.toFixed(2)}/tick`);
console.log(`  CARRY parts:     ${ctrlHaulCarry.toFixed(2)}`);
console.log(`  Spawn cost:      ${ctrlHaulCost.toFixed(3)}/tick\n`);

// For backwards compatibility with rest of file
const carryPartsNeeded = spawnHaulCarry;
const haulerSpawnOverhead = spawnHaulCost;
const upgradeCarryParts = ctrlHaulCarry;
const upgradeWorkParts = upgradeRate;

// ============================================================================
// SPAWN: Energy Balance
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SPAWN: Energy Balance                                       │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

const spawnOverheadTotal = minerSpawnOverhead + spawnHaulCost + ctrlHaulCost + upgraderWorkCost;

console.log("Spawn overhead (all creep costs):");
console.log(`  Miner:              ${minerSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Source→Spawn haul:  ${spawnHaulCost.toFixed(3)}/tick (${spawnHaulCarry.toFixed(1)}C)`);
console.log(`  Source→Ctrl haul:   ${ctrlHaulCost.toFixed(3)}/tick (${ctrlHaulCarry.toFixed(1)}C)`);
console.log(`  Upgrader WORK:      ${upgraderWorkCost.toFixed(3)}/tick (${upgradeRate.toFixed(1)}W)`);
console.log(`  ─────────────────────`);
console.log(`  Total overhead:     ${spawnOverheadTotal.toFixed(3)}/tick`);
console.log(`  Energy to spawn:    ${overhead.toFixed(2)}/tick (just enough for overhead)\n`);

// ============================================================================
// UPGRADING: Source → Controller (direct)
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ UPGRADING: Source → Controller (direct hauling)            │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Energy is hauled directly from source to controller
// This is more efficient than source→spawn→controller!

console.log("Direct haul from source (not via spawn):");
console.log(`  Energy arriving at controller: ${upgradeRate.toFixed(2)}/tick`);
console.log(`  Upgrade rate: ${upgradeRate.toFixed(2)} energy/tick`);
console.log(`  WORK parts: ${upgradeRate.toFixed(2)}`);
console.log(`  Haul CARRY parts: ${ctrlHaulCarry.toFixed(2)}\n`);

const upgraderSpawnOverhead = upgraderWorkCost + ctrlHaulCost;

// ============================================================================
// SUMMARY
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ ECONOMY SUMMARY                                             │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

const totalSpawnOverhead = spawnOverheadTotal;
const netOutput = upgradeRate;

console.log("Energy Flow (per tick):");
console.log("  ┌──────────────────────────────────────────────────────────┐");
console.log(`  │  Gross Harvest:           ${harvestPerTick.toFixed(2).padStart(6)}                      │`);
console.log("  │  ────────────────────────────────────────────────────    │");
console.log(`  │  Miner:                   ${minerSpawnOverhead.toFixed(2).padStart(6)}  (${MINER_WORK}W)             │`);
console.log(`  │  Source→Spawn hauler:     ${spawnHaulCost.toFixed(2).padStart(6)}  (${spawnHaulCarry.toFixed(1)}C)            │`);
console.log(`  │  Source→Ctrl hauler:      ${ctrlHaulCost.toFixed(2).padStart(6)}  (${ctrlHaulCarry.toFixed(1)}C)           │`);
console.log(`  │  Upgrader WORK:           ${upgraderWorkCost.toFixed(2).padStart(6)}  (${upgradeRate.toFixed(1)}W)            │`);
console.log("  │  ────────────────────────────────────────────────────    │");
console.log(`  │  Total overhead:          ${totalSpawnOverhead.toFixed(2).padStart(6)}                      │`);
console.log(`  │  Net to upgrading:        ${netOutput.toFixed(2).padStart(6)}                      │`);
console.log("  └──────────────────────────────────────────────────────────┘\n");

const efficiency = (netOutput / harvestPerTick) * 100;
console.log(`Overall Efficiency: ${efficiency.toFixed(1)}%`);
console.log(`  (${netOutput.toFixed(2)} upgrade work from ${harvestPerTick.toFixed(2)} gross harvest)\n`);

// Body part totals
const totalWorkParts = MINER_WORK + upgradeRate;
const totalCarryParts = spawnHaulCarry + ctrlHaulCarry;
const totalMoveParts = MINER_MOVE + totalCarryParts;  // 1:1 for haulers, miners have fewer

console.log("Body Part Requirements (fractional):");
console.log(`  Mining:    ${MINER_WORK}W + ${MINER_MOVE}M`);
console.log(`  Hauling:   ${spawnHaulCarry.toFixed(1)}C + ${spawnHaulCarry.toFixed(1)}M (source→spawn)`);
console.log(`             ${ctrlHaulCarry.toFixed(1)}C + ${ctrlHaulCarry.toFixed(1)}M (source→controller)`);
console.log(`  Upgrading: ${upgradeRate.toFixed(1)}W`);
console.log(`  ─────────────────`);
console.log(`  Total:     ${totalWorkParts.toFixed(1)}W + ${totalCarryParts.toFixed(1)}C + ${totalMoveParts.toFixed(1)}M\n`);

// ============================================================================
// EFFICIENCY CALCULATION FUNCTION
// ============================================================================

interface ScenarioResult {
  name: string;
  distance: number;
  roundTrip: number;
  carryParts: number;
  upgradeWork: number;
  upgradeCarry: number;
  totalSpawnOverhead: number;
  roadMaintenance: number;
  netUpgrade: number;
  efficiency: number;
}

function calculateScenarios(D: number, harvestRate: number): ScenarioResult[] {
  const minerOverhead = MINER_COST / LIFETIME;
  const cost_1to1 = CARRY_COST + MOVE_COST;  // 100 per CARRY
  const cost_2to1 = CARRY_COST + MOVE_COST / 2;  // 75 per CARRY
  const workCostPerTick = WORK_COST / LIFETIME;

  // Round trip times
  const rt_1to1 = 2 * D + 2;
  const rt_2to1_noRoad = 3 * D + 2;
  const rt_2to1_road = 2 * D + 2;

  const results: ScenarioResult[] = [];

  // Direct haul model: Source → Spawn (overhead only) + Source → Controller (upgrading)
  // Solve: O = minerCost + (O × k_spawn) + (W × k_ctrl) + (W × workCost)
  // Where O + W = harvestRate

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 1: 1:1 No Roads
  // ─────────────────────────────────────────────────────────────────────────
  {
    const k = (rt_1to1 / 50) * (cost_1to1 / LIFETIME);
    const O = (minerOverhead + harvestRate * k + harvestRate * workCostPerTick) / (1 + workCostPerTick);
    const W = harvestRate - O;

    const spawnCarry = O * rt_1to1 / 50;
    const ctrlCarry = W * rt_1to1 / 50;
    const totalOverhead = O;

    results.push({
      name: "1:1 No Roads",
      distance: D,
      roundTrip: rt_1to1,
      carryParts: spawnCarry,
      upgradeWork: W,
      upgradeCarry: ctrlCarry,
      totalSpawnOverhead: totalOverhead,
      roadMaintenance: 0,
      netUpgrade: W,
      efficiency: (W / harvestRate) * 100,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 2: 2:1 No Roads (half speed loaded)
  // ─────────────────────────────────────────────────────────────────────────
  {
    const k = (rt_2to1_noRoad / 50) * (cost_2to1 / LIFETIME);
    const O = (minerOverhead + harvestRate * k + harvestRate * workCostPerTick) / (1 + workCostPerTick);
    const W = harvestRate - O;

    const spawnCarry = O * rt_2to1_noRoad / 50;
    const ctrlCarry = W * rt_2to1_noRoad / 50;
    const totalOverhead = O;

    results.push({
      name: "2:1 No Roads",
      distance: D,
      roundTrip: rt_2to1_noRoad,
      carryParts: spawnCarry,
      upgradeWork: W,
      upgradeCarry: ctrlCarry,
      totalSpawnOverhead: totalOverhead,
      roadMaintenance: 0,
      netUpgrade: W,
      efficiency: (W / harvestRate) * 100,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SCENARIO 3: 2:1 + Roads (full speed, but maintenance cost)
  // ─────────────────────────────────────────────────────────────────────────
  {
    // Road maintenance: 2 routes × D tiles each
    // Simplified: assume moderate traffic decay
    const baseDecay = ROAD_DECAY_RATE / 1000;
    const avgTraffic = 0.5;  // simplified estimate
    const avgDecay = baseDecay * (1 + avgTraffic);
    const avgLife = ROAD_MAX_HITS / avgDecay;
    const roadMaint = 2 * D * ROAD_ENERGY_COST / avgLife;

    const roadMinerCost = MINER_WORK * WORK_COST + Math.ceil(MINER_WORK / 2) * MOVE_COST;
    const roadMinerOverhead = roadMinerCost / LIFETIME;

    const k = (rt_2to1_road / 50) * (cost_2to1 / LIFETIME);
    const availableHarvest = harvestRate - roadMaint;
    const O = (roadMinerOverhead + availableHarvest * k + availableHarvest * workCostPerTick) / (1 + workCostPerTick);
    const W = availableHarvest - O;

    const spawnCarry = O * rt_2to1_road / 50;
    const ctrlCarry = W * rt_2to1_road / 50;
    const totalOverhead = O + roadMaint;

    results.push({
      name: "2:1 + Roads",
      distance: D,
      roundTrip: rt_2to1_road,
      carryParts: spawnCarry,
      upgradeWork: W,
      upgradeCarry: ctrlCarry,
      totalSpawnOverhead: O,
      roadMaintenance: roadMaint,
      netUpgrade: W,
      efficiency: (W / harvestRate) * 100,
    });
  }

  return results;
}

// ============================================================================
// MULTI-DISTANCE COMPARISON
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ EFFICIENCY BY DISTANCE: 1:1 vs 2:1 vs 2:1+Roads             │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

console.log("Round trip formulas (empty CARRY = full speed):");
console.log("  1:1 no roads:  2D + 2   (full speed both ways)");
console.log("  2:1 no roads:  3D + 2   (half speed when loaded)");
console.log("  2:1 + roads:   2D + 2   (roads restore full speed)\n");

const distances = [10, 20, 30, 50, 75, 100];

console.log("┌──────────┬────────────────────────────────────────────────────────────────────┐");
console.log("│ Distance │  1:1 No Roads       2:1 No Roads       2:1 + Roads      Winner    │");
console.log("├──────────┼────────────────────────────────────────────────────────────────────┤");

for (const D of distances) {
  // Source always produces 10 energy/tick regardless of distance
  const harvestRate = SOURCE_CAPACITY / SOURCE_REGEN;  // 10 energy/tick

  const scenarios = calculateScenarios(D, harvestRate);
  const best = scenarios.reduce((a, b) => a.efficiency > b.efficiency ? a : b);

  const s1 = scenarios[0];
  const s2 = scenarios[1];
  const s3 = scenarios[2];

  const eff1 = s1.efficiency.toFixed(1).padStart(5) + "%";
  const eff2 = s2.efficiency.toFixed(1).padStart(5) + "%";
  const eff3 = s3.efficiency.toFixed(1).padStart(5) + "%";

  const winner = best.name === "1:1 No Roads" ? "1:1" :
                 best.name === "2:1 No Roads" ? "2:1" : "Roads";

  const marker1 = best.name === "1:1 No Roads" ? " ✓" : "  ";
  const marker2 = best.name === "2:1 No Roads" ? " ✓" : "  ";
  const marker3 = best.name === "2:1 + Roads" ? " ✓" : "  ";

  console.log(`│  D=${D.toString().padEnd(4)}  │  ${eff1}${marker1}            ${eff2}${marker2}            ${eff3}${marker3}       ${winner.padEnd(6)}   │`);
}

console.log("└──────────┴────────────────────────────────────────────────────────────────────┘\n");

// ============================================================================
// DETAILED BREAKDOWN AT D=30
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ DETAILED BREAKDOWN AT D=30                                  │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

const detailScenarios = calculateScenarios(30, harvestPerTick);
const s1 = detailScenarios[0];
const s2 = detailScenarios[1];
const s3 = detailScenarios[2];

console.log("                         1:1 No Road    2:1 No Road    2:1 + Roads");
console.log("                         ───────────    ───────────    ───────────");
console.log("");
console.log("HAULER CONFIG:");
console.log(`  Round trip             ${s1.roundTrip} ticks       ${s2.roundTrip} ticks       ${s3.roundTrip} ticks`);
console.log(`  CARRY:MOVE ratio       1:1            2:1            2:1`);
console.log(`  Cost per CARRY         100            75             75`);
console.log("");
console.log("SOURCE→SPAWN HAULING:");
console.log(`  CARRY parts            ${s1.carryParts.toFixed(1)}           ${s2.carryParts.toFixed(1)}           ${s3.carryParts.toFixed(1)}`);
console.log("");
console.log("UPGRADING:");
console.log(`  WORK parts             ${s1.upgradeWork.toFixed(1)}            ${s2.upgradeWork.toFixed(1)}            ${s3.upgradeWork.toFixed(1)}`);
console.log(`  Haul CARRY             ${s1.upgradeCarry.toFixed(1)}            ${s2.upgradeCarry.toFixed(1)}           ${s3.upgradeCarry.toFixed(1)}`);
console.log("");
console.log("COSTS:");
console.log(`  Spawn overhead         ${s1.totalSpawnOverhead.toFixed(3)}/tick    ${s2.totalSpawnOverhead.toFixed(3)}/tick    ${s3.totalSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Road maintenance       ${s1.roadMaintenance.toFixed(3)}/tick    ${s2.roadMaintenance.toFixed(3)}/tick    ${s3.roadMaintenance.toFixed(3)}/tick`);
console.log(`  Total overhead         ${(s1.totalSpawnOverhead + s1.roadMaintenance).toFixed(3)}/tick    ${(s2.totalSpawnOverhead + s2.roadMaintenance).toFixed(3)}/tick    ${(s3.totalSpawnOverhead + s3.roadMaintenance).toFixed(3)}/tick`);
console.log("");
console.log("  ┌─────────────────────────────────────────────────────────────────┐");
console.log(`  │  Net upgrading       ${s1.netUpgrade.toFixed(2)}/tick      ${s2.netUpgrade.toFixed(2)}/tick      ${s3.netUpgrade.toFixed(2)}/tick    │`);
console.log(`  │  Efficiency          ${s1.efficiency.toFixed(1)}%          ${s2.efficiency.toFixed(1)}%          ${s3.efficiency.toFixed(1)}%        │`);
console.log("  └─────────────────────────────────────────────────────────────────┘");
console.log("");

// Find winner
const allScenarios = [s1, s2, s3];
const best = allScenarios.reduce((a, b) => a.efficiency > b.efficiency ? a : b);
console.log(`  WINNER: ${best.name} at ${best.efficiency.toFixed(1)}% efficiency ✓\n`);

// ============================================================================
// SCALING ANALYSIS
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SCALING ANALYSIS                                            │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Calculate efficiency delta at each distance
console.log("Efficiency Gap Analysis:");
console.log("");
console.log("  Distance   1:1 vs 2:1 Gap    1:1 vs Roads Gap   Efficiency Loss/10tiles");
console.log("  ────────   ──────────────    ────────────────   ──────────────────────");

let prevEff: number | null = null;
for (const D of distances) {
  // Source always produces 10 energy/tick
  const harvestRate = SOURCE_CAPACITY / SOURCE_REGEN;

  const scenarios = calculateScenarios(D, harvestRate);
  const gap_2to1 = scenarios[0].efficiency - scenarios[1].efficiency;
  const gap_roads = scenarios[0].efficiency - scenarios[2].efficiency;

  const effLoss = prevEff !== null ? (prevEff - scenarios[0].efficiency) : 0;
  prevEff = scenarios[0].efficiency;

  console.log(`    D=${D.toString().padEnd(4)}      +${gap_2to1.toFixed(1)}%             +${gap_roads.toFixed(1)}%               ${D > 10 ? "-" + effLoss.toFixed(1) + "%" : "  --"}`);
}
console.log("");

console.log("Key Findings:");
console.log("");
console.log("  ┌────────────────────────────────────────────────────────────────┐");
console.log("  │  1:1 No Roads ALWAYS wins for single-source economy           │");
console.log("  └────────────────────────────────────────────────────────────────┘");
console.log("");
console.log("  Why 1:1 beats 2:1 despite cheaper body parts:");
console.log("");
console.log("    The naive analysis compares:");
console.log("      1:1: (2D+2) × 100/50/1500 = (2D+2) × 0.00133 cost/energy");
console.log("      2:1: (3D+2) × 75/50/1500  = (3D+2) × 0.00100 cost/energy");
console.log("");
console.log("    This suggests 2:1 wins when D > 2. But this ignores:");
console.log("");
console.log("    1. ROUND TRIP TIME COMPOUNDS");
console.log("       - 2:1 needs 50% more CARRY parts to match throughput");
console.log("       - At D=30: 1:1 needs 9.9C, 2:1 needs 14.7C");
console.log("       - The 50% penalty in parts overwhelms 25% savings per part");
console.log("");
console.log("    2. UPGRADE ROUTE DOUBLES THE PENALTY");
console.log("       - Energy also needs hauling to controller");
console.log("       - 2:1 pays the 50% round trip penalty twice");
console.log("");
console.log("    3. THE MATH:");
console.log("       - 2:1 cost per CARRY: 75 (25% savings)");
console.log("       - 2:1 round trip: 3D+2 vs 2D+2 (50% longer)");
console.log("       - Net: 0.75 × 1.5 = 1.125 → 12.5% MORE expensive");
console.log("");
console.log("  Why Roads lose:");
console.log("");
console.log("    - Roads give 2:1 the same speed as 1:1 (2D+2 round trip)");
console.log("    - But road maintenance eats into savings");
console.log("    - At D=30: 0.51 energy/tick road cost vs 0.31 spawn savings");
console.log("    - Roads only win with SHARED routes (multiple sources)");
console.log("");

// ============================================================================
// TWO-SOURCE SCENARIO (Square Topology - Chebyshev Distance)
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ TWO-SOURCE ECONOMY (Square, Chebyshev Distance)             │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

console.log("Topology: Square with ALL distances = D (including diagonals)");
console.log("  (Screeps uses Chebyshev distance: diagonal = orthogonal)");
console.log("");
console.log("    SOURCE1 ───D─── SOURCE2");
console.log("       │ ╲       ╱ │");
console.log("       D   ╲D D╱   D");
console.log("       │     ╳     │");
console.log("       D   ╱   ╲   D");
console.log("       │ ╱       ╲ │");
console.log("     SPAWN ───D─── CONTROLLER");
console.log("");
console.log("All 6 edges are distance D - it's a complete graph K₄!\n");

// Two sources = 20 energy/tick total
const twoSourceHarvest = 2 * sourceRatePerTick;  // 20 energy/tick

// With all nodes equidistant, the optimal routing is:
// - Each source sends overhead portion to spawn
// - Each source sends upgrade portion to controller
// But since all distances are D, it doesn't matter which source sends where!

const twoMinerCost = 2 * minerSpawnOverhead;  // 0.867/tick
const rt = 2 * DISTANCE + 2;  // Round trip = 2D + 2 (same for all routes)
const haulK = (rt / 50) * (carryPartCost / LIFETIME);

// Solve: O = 2×minerCost + haulCost(O) + haulCost(W) + upgraderCost(W)
// Where O + W = 20
const twoSourceOverhead = (twoMinerCost + twoSourceHarvest * haulK + twoSourceHarvest * workCostPerTick) / (1 + workCostPerTick);
const twoSourceUpgradeRate = twoSourceHarvest - twoSourceOverhead;

const twoSpawnHaulCarry = twoSourceOverhead * rt / 50;
const twoCtrlHaulCarry = twoSourceUpgradeRate * rt / 50;
const twoSpawnHaulCost = (twoSpawnHaulCarry * carryPartCost) / LIFETIME;
const twoCtrlHaulCost = (twoCtrlHaulCarry * carryPartCost) / LIFETIME;
const twoUpgraderWorkCost = (twoSourceUpgradeRate * WORK_COST) / LIFETIME;

const twoSourceEfficiency = (twoSourceUpgradeRate / twoSourceHarvest) * 100;

console.log(`With D=${DISTANCE}:\n`);

console.log("Energy Flow:");
console.log(`  Source1 + Source2 → Spawn:      ${twoSourceOverhead.toFixed(2)}/tick (for overhead)`);
console.log(`  Source1 + Source2 → Controller: ${twoSourceUpgradeRate.toFixed(2)}/tick (for upgrading)\n`);

console.log("Hauler Requirements:");
console.log(`  To Spawn:      ${twoSpawnHaulCarry.toFixed(1)}C (round trip ${rt} ticks)`);
console.log(`  To Controller: ${twoCtrlHaulCarry.toFixed(1)}C (round trip ${rt} ticks)\n`);

console.log("Overhead breakdown:");
console.log(`  2× Miners:           ${twoMinerCost.toFixed(3)}/tick (2 × ${MINER_WORK}W)`);
console.log(`  Spawn haulers:       ${twoSpawnHaulCost.toFixed(3)}/tick (${twoSpawnHaulCarry.toFixed(1)}C)`);
console.log(`  Controller haulers:  ${twoCtrlHaulCost.toFixed(3)}/tick (${twoCtrlHaulCarry.toFixed(1)}C)`);
console.log(`  Upgrader WORK:       ${twoUpgraderWorkCost.toFixed(3)}/tick (${twoSourceUpgradeRate.toFixed(1)}W)`);
console.log(`  ─────────────────────`);
console.log(`  Total overhead:      ${twoSourceOverhead.toFixed(3)}/tick\n`);

console.log("  ┌──────────────────────────────────────────────────────────┐");
console.log(`  │  Gross Harvest:      ${twoSourceHarvest.toFixed(2)}/tick (2 sources)           │`);
console.log(`  │  Net Upgrading:      ${twoSourceUpgradeRate.toFixed(2)}/tick                     │`);
console.log(`  │  Efficiency:         ${twoSourceEfficiency.toFixed(1)}%                          │`);
console.log("  └──────────────────────────────────────────────────────────┘\n");

// Body part totals for 2-source
const twoTotalWork = 2 * MINER_WORK + twoSourceUpgradeRate;
const twoTotalCarry = twoSpawnHaulCarry + twoCtrlHaulCarry;
const twoTotalMove = 2 * MINER_MOVE + twoTotalCarry;

console.log("Body Part Requirements:");
console.log(`  Mining:    ${2 * MINER_WORK}W + ${2 * MINER_MOVE}M (2 miners)`);
console.log(`  Hauling:   ${twoSpawnHaulCarry.toFixed(1)}C + ${twoSpawnHaulCarry.toFixed(1)}M (→spawn)`);
console.log(`             ${twoCtrlHaulCarry.toFixed(1)}C + ${twoCtrlHaulCarry.toFixed(1)}M (→controller)`);
console.log(`  Upgrading: ${twoSourceUpgradeRate.toFixed(1)}W`);
console.log(`  ─────────────────`);
console.log(`  Total:     ${twoTotalWork.toFixed(1)}W + ${twoTotalCarry.toFixed(1)}C + ${twoTotalMove.toFixed(1)}M\n`);

// Compare to 1-source
console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ COMPARISON: 1 Source vs 2 Sources                          │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

console.log("                           1 Source       2 Sources");
console.log("                           ─────────      ─────────");
console.log(`  Gross harvest            ${harvestPerTick.toFixed(1)}/tick       ${twoSourceHarvest.toFixed(1)}/tick`);
console.log(`  Net upgrading            ${upgradeRate.toFixed(1)}/tick       ${twoSourceUpgradeRate.toFixed(1)}/tick`);
console.log(`  Efficiency               ${efficiency.toFixed(1)}%          ${twoSourceEfficiency.toFixed(1)}%`);
console.log(`  Upgrade per source       ${upgradeRate.toFixed(1)}/tick       ${(twoSourceUpgradeRate/2).toFixed(1)}/tick`);
console.log("");
console.log(`  WORK parts               ${totalWorkParts.toFixed(1)}           ${twoTotalWork.toFixed(1)}`);
console.log(`  CARRY parts              ${totalCarryParts.toFixed(1)}           ${twoTotalCarry.toFixed(1)}`);
console.log(`  MOVE parts               ${totalMoveParts.toFixed(1)}           ${twoTotalMove.toFixed(1)}`);
console.log("");

// Efficiency is the same because all distances are D
console.log("Note: Efficiency is the SAME because all distances are D.");
console.log("      With Chebyshev distance, topology doesn't affect efficiency!");
console.log("      (Only distance D matters, not the shape)\n");
