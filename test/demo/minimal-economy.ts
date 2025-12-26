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

// Miner travels from spawn to source
const minerTravelTime = DISTANCE;
const minerEffectiveTime = LIFETIME - minerTravelTime;
const minerRegenCycles = Math.floor(minerEffectiveTime / SOURCE_REGEN);
const grossHarvest = minerRegenCycles * SOURCE_CAPACITY;
const harvestPerTick = grossHarvest / LIFETIME;

console.log("Miner:");
console.log(`  Body: ${MINER_WORK}W ${MINER_MOVE}M = ${MINER_COST} energy`);
console.log(`  Travel to source: ${minerTravelTime} ticks`);
console.log(`  Effective mining time: ${minerEffectiveTime} ticks`);
console.log(`  Regen cycles captured: ${minerRegenCycles}`);
console.log(`  Gross harvest: ${grossHarvest} energy/lifetime`);
console.log(`  Harvest rate: ${harvestPerTick.toFixed(2)} energy/tick\n`);

// Miner spawn overhead (amortized)
const minerSpawnOverhead = MINER_COST / LIFETIME;
console.log(`  Spawn overhead: ${MINER_COST} / ${LIFETIME} = ${minerSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// HAULING: Source → Spawn
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ HAULING: Source → Spawn                                     │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Formula: CARRY_parts = S × (2D + 2) / 50
// Round trip = 2D + 2 (walking both ways + 1 tick pickup + 1 tick dropoff)
const haulerRoundTrip = DISTANCE * 2 + 2;

// Exact CARRY parts needed (no rounding!)
const carryPartsNeeded = harvestPerTick * haulerRoundTrip / 50;

// Spawn cost: each CARRY part needs 1 MOVE part (1:1 ratio for roads)
// Cost per CARRY part = CARRY_COST + MOVE_COST = 100
const carryPartCost = CARRY_COST + MOVE_COST;  // 100 energy per CARRY part
const haulerSpawnOverhead = (carryPartsNeeded * carryPartCost) / LIFETIME;

// For display: equivalent hauler count (fractional)
const equivalentHaulers = carryPartsNeeded / HAULER_CARRY;

console.log("Hauling (Source → Spawn):");
console.log(`  Round trip: 2×${DISTANCE} + 2 = ${haulerRoundTrip} ticks`);
console.log(`  Required throughput: ${harvestPerTick.toFixed(2)} energy/tick`);
console.log(`  CARRY parts needed: ${harvestPerTick.toFixed(2)} × ${haulerRoundTrip} / 50 = ${carryPartsNeeded.toFixed(2)}`);
console.log(`  Equivalent haulers: ${equivalentHaulers.toFixed(2)} (at ${HAULER_CARRY}C each)`);
console.log(`  Spawn cost: ${carryPartsNeeded.toFixed(2)} × ${carryPartCost} / ${LIFETIME} = ${haulerSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// SPAWN: Energy arriving
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ SPAWN: Energy Balance                                       │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// With exact CARRY parts, throughput matches harvest exactly
const energyArriving = harvestPerTick;
const spawnOverheadTotal = minerSpawnOverhead + haulerSpawnOverhead;

console.log("Energy arriving at spawn:");
console.log(`  From haulers: ${energyArriving.toFixed(2)} energy/tick\n`);

console.log("Spawn overhead (creep costs):");
console.log(`  Miner:   ${minerSpawnOverhead.toFixed(3)}/tick`);
console.log(`  Haulers: ${haulerSpawnOverhead.toFixed(3)}/tick (${carryPartsNeeded.toFixed(1)} CARRY parts)`);
console.log(`  ─────────────────────`);
console.log(`  Subtotal: ${spawnOverheadTotal.toFixed(3)}/tick\n`);

// ============================================================================
// UPGRADING: Spawn → Controller
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ UPGRADING: Spawn → Controller                               │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Upgrader model: WORK parts stationed at controller, haulers bring energy
// Each WORK part upgrades 1 energy/tick (when energy available)
// Upgrader body: need CARRY to pick up from container, MOVE to get there once

// Hauling to controller: same formula as source→spawn
// CARRY_parts = S × (2D + 2) / 50
const upgradeHaulDistance = DISTANCE;  // spawn → controller
const upgradeHaulRoundTrip = upgradeHaulDistance * 2 + 2;

// Energy available for upgrading (after mining/hauling overhead)
const energyForUpgrading = energyArriving - spawnOverheadTotal;

// For each 1 energy/tick of upgrading, we need:
//   - Hauling: (2D + 2) / 50 CARRY parts → cost = (2D + 2) / 50 × 100 / 1500 per tick
//   - Working: 1 WORK part → cost = 100 / 1500 per tick (simplified, ignoring MOVE/CARRY on upgrader)
const upgradeHaulCostPerTick = (upgradeHaulRoundTrip / 50) * carryPartCost / LIFETIME;
const upgradeWorkCostPerTick = WORK_COST / LIFETIME;  // per WORK part
const upgradeTotalCostPerEnergyTick = upgradeHaulCostPerTick + upgradeWorkCostPerTick + 1;  // +1 for the energy itself

// How much can we upgrade?
const actualUpgradeRate = energyForUpgrading / upgradeTotalCostPerEnergyTick;
const upgradeWorkParts = actualUpgradeRate;  // 1 WORK = 1 energy/tick
const upgradeCarryParts = actualUpgradeRate * upgradeHaulRoundTrip / 50;
const upgraderSpawnOverhead = (upgradeWorkParts * WORK_COST + upgradeCarryParts * carryPartCost) / LIFETIME;

console.log("Upgrading (Spawn → Controller):");
console.log(`  Haul distance: ${upgradeHaulDistance} tiles (round trip: ${upgradeHaulRoundTrip} ticks)`);
console.log(`  Energy available: ${energyForUpgrading.toFixed(2)}/tick`);
console.log(`  Cost per 1 energy/tick upgrade:`);
console.log(`    - Energy consumed: 1.000`);
console.log(`    - Haul cost: ${upgradeHaulCostPerTick.toFixed(3)}/tick (${(upgradeHaulRoundTrip/50).toFixed(2)} CARRY parts)`);
console.log(`    - Work cost: ${upgradeWorkCostPerTick.toFixed(3)}/tick (1 WORK part)`);
console.log(`    - Total: ${upgradeTotalCostPerEnergyTick.toFixed(3)}/tick`);
console.log(`  Upgrade rate: ${actualUpgradeRate.toFixed(2)} energy/tick`);
console.log(`  WORK parts: ${upgradeWorkParts.toFixed(2)}`);
console.log(`  CARRY parts (hauling): ${upgradeCarryParts.toFixed(2)}`);
console.log(`  Spawn overhead: ${upgraderSpawnOverhead.toFixed(3)}/tick\n`);

// ============================================================================
// SUMMARY
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ ECONOMY SUMMARY                                             │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

const totalSpawnOverhead = minerSpawnOverhead + haulerSpawnOverhead + upgraderSpawnOverhead;
const netOutput = actualUpgradeRate;

console.log("Energy Flow (per tick):");
console.log("  ┌────────────────────────────────────────────────────────┐");
console.log(`  │  Gross Harvest:        ${harvestPerTick.toFixed(2).padStart(8)}                    │`);
console.log("  │  ──────────────────────────────────────────────────    │");
console.log(`  │  Miner spawn cost:     ${minerSpawnOverhead.toFixed(2).padStart(8)}  (${MINER_WORK}W)           │`);
console.log(`  │  Hauler spawn cost:    ${haulerSpawnOverhead.toFixed(2).padStart(8)}  (${carryPartsNeeded.toFixed(1)}C)          │`);
console.log(`  │  Upgrader spawn cost:  ${upgraderSpawnOverhead.toFixed(2).padStart(8)}  (${upgradeWorkParts.toFixed(1)}W + ${upgradeCarryParts.toFixed(1)}C) │`);
console.log("  │  ──────────────────────────────────────────────────    │");
console.log(`  │  Total overhead:       ${totalSpawnOverhead.toFixed(2).padStart(8)}                    │`);
console.log(`  │  Net to upgrading:     ${netOutput.toFixed(2).padStart(8)}                    │`);
console.log("  └────────────────────────────────────────────────────────┘\n");

const efficiency = (netOutput / harvestPerTick) * 100;
console.log(`Overall Efficiency: ${efficiency.toFixed(1)}%`);
console.log(`  (${netOutput.toFixed(2)} upgrade work from ${harvestPerTick.toFixed(2)} gross harvest)\n`);

// Body part totals
const totalWorkParts = MINER_WORK + upgradeWorkParts;
const totalCarryParts = carryPartsNeeded + upgradeCarryParts;
const totalMoveParts = MINER_MOVE + totalCarryParts;  // 1:1 for haulers, miners have fewer

console.log("Body Part Requirements (fractional):");
console.log(`  Mining:    ${MINER_WORK}W + ${MINER_MOVE}M`);
console.log(`  Hauling:   ${carryPartsNeeded.toFixed(1)}C + ${carryPartsNeeded.toFixed(1)}M (source→spawn)`);
console.log(`             ${upgradeCarryParts.toFixed(1)}C + ${upgradeCarryParts.toFixed(1)}M (spawn→controller)`);
console.log(`  Upgrading: ${upgradeWorkParts.toFixed(1)}W`);
console.log(`  ─────────────────`);
console.log(`  Total:     ${totalWorkParts.toFixed(1)}W + ${totalCarryParts.toFixed(1)}C + ${totalMoveParts.toFixed(1)}M\n`);

// ============================================================================
// ROADS ANALYSIS: Is it worth paving?
// ============================================================================

console.log("┌─────────────────────────────────────────────────────────────┐");
console.log("│ ROADS ANALYSIS: Worth paving?                               │");
console.log("└─────────────────────────────────────────────────────────────┘\n");

// Without roads: 1:1 CARRY:MOVE ratio
// With roads: 2:1 CARRY:MOVE ratio (creeps move at full speed on roads)
const noRoadCarryPartCost = CARRY_COST + MOVE_COST;  // 100 (1:1)
const roadCarryPartCost = CARRY_COST + MOVE_COST / 2;  // 75 (2:1)
const savingsPerCarryPart = noRoadCarryPartCost - roadCarryPartCost;  // 25

console.log("Hauler efficiency:");
console.log(`  Without roads: ${noRoadCarryPartCost} energy per CARRY part (1:1 CARRY:MOVE)`);
console.log(`  With roads:    ${roadCarryPartCost} energy per CARRY part (2:1 CARRY:MOVE)`);
console.log(`  Savings:       ${savingsPerCarryPart} energy per CARRY part\n`);

// Road infrastructure cost
// Need roads: Spawn→Source (D) + Spawn→Controller (D) = 2D tiles
const roadTiles = 2 * DISTANCE;
const roadMaintenanceCost = roadTiles * ROAD_MAINT_PER_TICK;

console.log("Road infrastructure:");
console.log(`  Tiles needed: ${roadTiles} (spawn→source + spawn→controller)`);
console.log(`  Build cost:   ${roadTiles} × ${ROAD_ENERGY_COST} = ${roadTiles * ROAD_ENERGY_COST} energy (one-time)`);
console.log(`  Maintenance:  ${roadTiles} × ${ROAD_MAINT_PER_TICK.toFixed(4)} = ${roadMaintenanceCost.toFixed(3)}/tick`);
console.log(`  Road lifetime: ${ROAD_TICKS_LIFETIME.toLocaleString()} ticks (${(ROAD_TICKS_LIFETIME/1500).toFixed(0)} creep lifetimes)\n`);

// Calculate savings from reduced MOVE parts
const totalCarryPartsForRoads = totalCarryParts;  // same CARRY needed, just fewer MOVE
const movePartsSaved = totalCarryPartsForRoads / 2;  // save half the MOVE parts
const spawnSavingsPerTick = (movePartsSaved * MOVE_COST) / LIFETIME;

console.log("Spawn cost savings:");
console.log(`  CARRY parts (hauling): ${totalCarryPartsForRoads.toFixed(1)}`);
console.log(`  MOVE parts saved:      ${movePartsSaved.toFixed(1)} (half of CARRY)`);
console.log(`  Spawn savings:         ${movePartsSaved.toFixed(1)} × ${MOVE_COST} / ${LIFETIME} = ${spawnSavingsPerTick.toFixed(3)}/tick\n`);

// Net benefit
const netRoadBenefit = spawnSavingsPerTick - roadMaintenanceCost;
const roadsWorthIt = netRoadBenefit > 0;

console.log("Net analysis:");
console.log(`  Spawn savings:     +${spawnSavingsPerTick.toFixed(3)}/tick`);
console.log(`  Road maintenance:  -${roadMaintenanceCost.toFixed(3)}/tick`);
console.log(`  ─────────────────────`);
console.log(`  Net benefit:       ${netRoadBenefit >= 0 ? '+' : ''}${netRoadBenefit.toFixed(3)}/tick`);
console.log(`  Roads worth it?    ${roadsWorthIt ? 'YES ✓' : 'NO ✗'}\n`);

// Recalculate efficiency with roads
if (roadsWorthIt) {
  const roadAdjustedOverhead = totalSpawnOverhead - spawnSavingsPerTick + roadMaintenanceCost;
  const roadAdjustedNet = harvestPerTick - roadAdjustedOverhead;
  const roadEfficiency = (roadAdjustedNet / harvestPerTick) * 100;

  console.log("With roads:");
  console.log(`  Adjusted overhead: ${roadAdjustedOverhead.toFixed(2)}/tick`);
  console.log(`  Net to upgrading:  ${roadAdjustedNet.toFixed(2)}/tick`);
  console.log(`  Efficiency:        ${roadEfficiency.toFixed(1)}% (was ${efficiency.toFixed(1)}%)`);
  console.log(`  Improvement:       +${(roadEfficiency - efficiency).toFixed(1)} percentage points\n`);
}

// Break-even analysis
const breakEvenCarryParts = roadMaintenanceCost * LIFETIME / (savingsPerCarryPart);
console.log("Break-even analysis:");
console.log(`  Roads pay off when CARRY parts > ${breakEvenCarryParts.toFixed(1)}`);
console.log(`  Current CARRY parts: ${totalCarryPartsForRoads.toFixed(1)}`);
console.log(`  Margin: ${(totalCarryPartsForRoads - breakEvenCarryParts).toFixed(1)} CARRY parts above break-even\n`);
