/**
 * Find the best node for upgrading based on energy supply economics.
 *
 * Key factors:
 * - Sources reachable via economic edges
 * - Distance costs for mining and hauling
 * - Net energy available for upgrading
 */

const fs = require('fs');
const path = require('path');

// Load network data
const network = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/econ-network.json'), 'utf-8'
));

// Constants (Screeps game mechanics)
const SOURCE_ENERGY_PER_TICK = 10; // 3000 energy / 300 ticks
const SPAWN_ENERGY_COST_PER_PART = 50; // Average body part cost
const CREEP_LIFESPAN = 1500;

// Body costs
const BODY_COSTS = {
  move: 50,
  work: 100,
  carry: 50,
  attack: 80,
  ranged_attack: 150,
  heal: 250,
  claim: 600,
  tough: 10,
};

// Build node lookup and adjacency
const nodeMap = new Map(network.nodes.map(n => [n.id, n]));
const econAdjacency = new Map();

for (const edge of network.economicEdges) {
  const [a, b] = edge.split('|');
  if (!econAdjacency.has(a)) econAdjacency.set(a, new Set());
  if (!econAdjacency.has(b)) econAdjacency.set(b, new Set());
  econAdjacency.get(a).add(b);
  econAdjacency.get(b).add(a);
}

// Parse room coordinates for distance calculation
function parseRoom(roomName) {
  const match = roomName.match(/^([EW])(\d+)([NS])(\d+)$/);
  if (!match) return null;
  const x = match[1] === 'E' ? parseInt(match[2]) : -parseInt(match[2]) - 1;
  const y = match[3] === 'N' ? -parseInt(match[4]) - 1 : parseInt(match[4]);
  return { x, y };
}

// Estimate distance between two positions (in tiles)
function estimateDistance(pos1, pos2) {
  if (pos1.roomName === pos2.roomName) {
    // Same room: Chebyshev distance
    return Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y));
  }
  // Different rooms: estimate based on room distance
  const room1 = parseRoom(pos1.roomName);
  const room2 = parseRoom(pos2.roomName);
  if (!room1 || !room2) return Infinity;

  const roomDist = Math.abs(room1.x - room2.x) + Math.abs(room1.y - room2.y);
  // ~50 tiles per room + position offset
  return roomDist * 50 + Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y));
}

/**
 * Calculate mining corp cost per tick for a source.
 * Miner: 5 WORK + 1 CARRY + 3 MOVE = 5*100 + 50 + 3*50 = 700 energy
 * Harvests 10 energy/tick, costs 700/1500 = 0.47 energy/tick to maintain
 */
function miningCostPerTick(sourcePos, spawnPos) {
  const dist = estimateDistance(sourcePos, spawnPos);
  const minerBody = 5 * BODY_COSTS.work + 1 * BODY_COSTS.carry + 3 * BODY_COSTS.move;
  const baseCost = minerBody / CREEP_LIFESPAN;

  // Add travel overhead: miner walks dist tiles, loses that many ticks per life
  const travelOverhead = (dist * 2) / CREEP_LIFESPAN; // round trip at spawn

  return baseCost + travelOverhead * SOURCE_ENERGY_PER_TICK;
}

/**
 * Calculate hauling cost per energy unit transported.
 * Hauler with 10 CARRY + 10 MOVE = 10*50 + 10*50 = 1000 energy
 * Carries 500 energy per trip
 */
function haulingCostPerEnergy(sourcePos, destPos) {
  const dist = estimateDistance(sourcePos, destPos);
  const haulerBody = 10 * BODY_COSTS.carry + 10 * BODY_COSTS.move;
  const carryCapacity = 10 * 50; // 500 energy per trip

  // Ticks per round trip (assuming road speed = 1 tile/tick)
  const ticksPerTrip = dist * 2;

  // Energy moved per tick
  const energyPerTick = carryCapacity / ticksPerTrip;

  // Cost per tick to maintain hauler
  const costPerTick = haulerBody / CREEP_LIFESPAN;

  // Cost per energy unit = costPerTick / energyPerTick
  return costPerTick / energyPerTick;
}

/**
 * Evaluate a controller node for upgrading potential.
 */
function evaluateControllerNode(node) {
  const controller = node.resources.find(r => r.type === 'controller');
  if (!controller) return null;

  const controllerPos = { x: controller.x, y: controller.y, roomName: node.roomName };

  // Assume spawn is near controller (in same node)
  const spawnPos = { x: node.peakPosition.x, y: node.peakPosition.y, roomName: node.roomName };

  // Find all reachable sources via economic edges (including local sources)
  const reachableSources = [];

  // Local sources in this node
  for (const r of node.resources) {
    if (r.type === 'source') {
      reachableSources.push({
        nodeId: node.id,
        pos: { x: r.x, y: r.y, roomName: node.roomName },
        local: true
      });
    }
  }

  // Sources in adjacent economic nodes
  const neighbors = econAdjacency.get(node.id) || new Set();
  for (const neighborId of neighbors) {
    const neighbor = nodeMap.get(neighborId);
    if (!neighbor) continue;

    for (const r of neighbor.resources) {
      if (r.type === 'source') {
        reachableSources.push({
          nodeId: neighbor.id,
          pos: { x: r.x, y: r.y, roomName: neighbor.roomName },
          local: false
        });
      }
    }
  }

  // Calculate total energy and costs
  let totalGrossEnergy = 0;
  let totalCosts = 0;
  const sourceDetails = [];

  // Minimum efficiency threshold - don't mine sources that cost more than 70% of output
  const MIN_EFFICIENCY = 0.3; // At least 30% net

  for (const source of reachableSources) {
    const grossEnergy = SOURCE_ENERGY_PER_TICK;
    const miningCost = miningCostPerTick(source.pos, spawnPos);
    const haulCost = haulingCostPerEnergy(source.pos, controllerPos) * grossEnergy;
    const netEnergy = grossEnergy - miningCost - haulCost;
    const efficiency = netEnergy / grossEnergy;

    // Skip unprofitable sources
    if (efficiency < MIN_EFFICIENCY) {
      continue;
    }

    totalGrossEnergy += grossEnergy;
    totalCosts += miningCost + haulCost;

    sourceDetails.push({
      nodeId: source.nodeId,
      local: source.local,
      distance: estimateDistance(source.pos, controllerPos),
      grossEnergy,
      miningCost: miningCost.toFixed(2),
      haulCost: haulCost.toFixed(2),
      netEnergy: netEnergy.toFixed(2),
      efficiency: (efficiency * 100).toFixed(1) + '%'
    });
  }

  // Sort by efficiency (best first)
  sourceDetails.sort((a, b) => parseFloat(b.netEnergy) - parseFloat(a.netEnergy));

  const netEnergy = totalGrossEnergy - totalCosts;

  return {
    nodeId: node.id,
    roomName: node.roomName,
    controllerPos,
    sourceCount: reachableSources.length,
    localSources: reachableSources.filter(s => s.local).length,
    remoteSources: reachableSources.filter(s => !s.local).length,
    grossEnergy: totalGrossEnergy,
    totalCosts: totalCosts.toFixed(2),
    netEnergy: netEnergy.toFixed(2),
    efficiency: ((netEnergy / totalGrossEnergy) * 100).toFixed(1) + '%',
    sources: sourceDetails
  };
}

// Find all nodes with controllers
const controllerNodes = network.nodes.filter(n =>
  n.resources.some(r => r.type === 'controller')
);

console.log('=== BEST NODE ANALYSIS ===');
console.log(`Controller nodes: ${controllerNodes.length}`);
console.log(`Economic edges: ${network.economicEdges.length}`);
console.log('');

// Evaluate each controller node
const evaluations = controllerNodes
  .map(n => evaluateControllerNode(n))
  .filter(e => e !== null)
  .sort((a, b) => parseFloat(b.netEnergy) - parseFloat(a.netEnergy));

// Show top 10
console.log('=== TOP 10 NODES BY NET ENERGY ===');
console.log('');

for (let i = 0; i < Math.min(10, evaluations.length); i++) {
  const e = evaluations[i];
  const bootstrap = e.localSources > 0 ? '✓ can bootstrap' : '✗ needs external spawn';
  console.log(`#${i + 1}: ${e.nodeId}`);
  console.log(`    Room: ${e.roomName} ${bootstrap}`);
  console.log(`    Sources: ${e.sourceCount} (${e.localSources} local, ${e.remoteSources} remote)`);
  console.log(`    Gross energy: ${e.grossEnergy}/tick`);
  console.log(`    Total costs: ${e.totalCosts}/tick`);
  console.log(`    Net energy: ${e.netEnergy}/tick`);
  console.log(`    Efficiency: ${e.efficiency}`);
  console.log('');
}

// Also show best bootstrappable node
console.log('=== BEST BOOTSTRAPPABLE NODE ===');
const bootstrappable = evaluations.filter(e => e.localSources > 0);
if (bootstrappable.length > 0) {
  const bestBootstrap = bootstrappable[0];
  console.log(`${bestBootstrap.nodeId} (${bestBootstrap.roomName})`);
  console.log(`  Local sources: ${bestBootstrap.localSources}`);
  console.log(`  Net energy: ${bestBootstrap.netEnergy}/tick`);
  console.log(`  Efficiency: ${bestBootstrap.efficiency}`);
} else {
  console.log('No bootstrappable nodes found');
}
console.log('');

// Show the best node in detail
console.log('=== BEST NODE DETAILS ===');
const best = evaluations[0];
console.log(`Node: ${best.nodeId}`);
console.log(`Room: ${best.roomName}`);
console.log('');
console.log('Source breakdown (sorted by net energy):');
for (const s of best.sources) {
  console.log(`  ${s.local ? 'LOCAL' : 'REMOTE'} ${s.nodeId}`);
  console.log(`    Distance: ${s.distance} tiles, Efficiency: ${s.efficiency}`);
  console.log(`    Gross: ${s.grossEnergy}/tick, Mining: ${s.miningCost}/tick, Haul: ${s.haulCost}/tick`);
  console.log(`    Net: ${s.netEnergy}/tick`);
}

// Also show nodes filtered out
console.log('');
console.log('=== SOURCES FILTERED OUT (efficiency < 30%) ===');
const allControllerNodes = network.nodes.filter(n =>
  n.resources.some(r => r.type === 'controller')
);
const bestNode = allControllerNodes.find(n => n.id === best.nodeId);
const bestControllerPos = {
  x: bestNode.resources.find(r => r.type === 'controller').x,
  y: bestNode.resources.find(r => r.type === 'controller').y,
  roomName: bestNode.roomName
};
const bestSpawnPos = { x: bestNode.peakPosition.x, y: bestNode.peakPosition.y, roomName: bestNode.roomName };

// Find all reachable sources
const allReachable = [];
for (const r of bestNode.resources) {
  if (r.type === 'source') {
    allReachable.push({ nodeId: bestNode.id, pos: { x: r.x, y: r.y, roomName: bestNode.roomName }, local: true });
  }
}
const neighbors = econAdjacency.get(bestNode.id) || new Set();
for (const neighborId of neighbors) {
  const neighbor = nodeMap.get(neighborId);
  if (!neighbor) continue;
  for (const r of neighbor.resources) {
    if (r.type === 'source') {
      allReachable.push({ nodeId: neighbor.id, pos: { x: r.x, y: r.y, roomName: neighbor.roomName }, local: false });
    }
  }
}

let filteredCount = 0;
for (const source of allReachable) {
  const grossEnergy = SOURCE_ENERGY_PER_TICK;
  const mCost = miningCostPerTick(source.pos, bestSpawnPos);
  const hCost = haulingCostPerEnergy(source.pos, bestControllerPos) * grossEnergy;
  const netE = grossEnergy - mCost - hCost;
  const eff = netE / grossEnergy;
  if (eff < 0.3) {
    const dist = estimateDistance(source.pos, bestControllerPos);
    console.log(`  ${source.nodeId}: dist=${dist}, net=${netE.toFixed(2)}/tick, eff=${(eff*100).toFixed(1)}%`);
    filteredCount++;
  }
}
console.log(`Total filtered: ${filteredCount} sources`);
