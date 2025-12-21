/**
 * Economic analysis utilities for node evaluation.
 *
 * This module provides market-driven analysis for finding optimal
 * nodes for various economic activities (upgrading, mining, etc.)
 */

// Constants (Screeps game mechanics)
const SOURCE_ENERGY_PER_TICK = 10; // 3000 energy / 300 ticks
const CREEP_LIFESPAN = 1500;

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

/**
 * Parse room coordinates from room name.
 */
function parseRoom(roomName) {
  const match = roomName.match(/^([EW])(\d+)([NS])(\d+)$/);
  if (!match) return null;
  const x = match[1] === 'E' ? parseInt(match[2]) : -parseInt(match[2]) - 1;
  const y = match[3] === 'N' ? -parseInt(match[4]) - 1 : parseInt(match[4]);
  return { x, y };
}

/**
 * Estimate distance between two positions (in tiles).
 */
function estimateDistance(pos1, pos2) {
  if (pos1.roomName === pos2.roomName) {
    return Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y));
  }
  const room1 = parseRoom(pos1.roomName);
  const room2 = parseRoom(pos2.roomName);
  if (!room1 || !room2) return Infinity;
  const roomDist = Math.abs(room1.x - room2.x) + Math.abs(room1.y - room2.y);
  return roomDist * 50 + Math.max(Math.abs(pos1.x - pos2.x), Math.abs(pos1.y - pos2.y));
}

/**
 * Calculate mining corp cost per tick for a source.
 * Standard miner: 5 WORK + 1 CARRY + 3 MOVE = 700 energy
 */
function miningCostPerTick(sourcePos, spawnPos) {
  const dist = estimateDistance(sourcePos, spawnPos);
  const minerBody = 5 * BODY_COSTS.work + 1 * BODY_COSTS.carry + 3 * BODY_COSTS.move;
  const baseCost = minerBody / CREEP_LIFESPAN;
  const travelOverhead = (dist * 2) / CREEP_LIFESPAN;
  return baseCost + travelOverhead * SOURCE_ENERGY_PER_TICK;
}

/**
 * Calculate hauling cost per energy unit transported.
 * Standard hauler: 10 CARRY + 10 MOVE = 1000 energy, carries 500/trip
 */
function haulingCostPerEnergy(sourcePos, destPos) {
  const dist = estimateDistance(sourcePos, destPos);
  const haulerBody = 10 * BODY_COSTS.carry + 10 * BODY_COSTS.move;
  const carryCapacity = 10 * 50;
  const ticksPerTrip = dist * 2;
  const energyPerTick = carryCapacity / ticksPerTrip;
  const costPerTick = haulerBody / CREEP_LIFESPAN;
  return costPerTick / energyPerTick;
}

/**
 * Build economic graph from network data.
 */
function buildEconomicGraph(network) {
  const nodeMap = new Map(network.nodes.map(n => [n.id, n]));
  const econAdjacency = new Map();

  for (const edge of network.economicEdges) {
    const [a, b] = edge.split('|');
    if (!econAdjacency.has(a)) econAdjacency.set(a, new Set());
    if (!econAdjacency.has(b)) econAdjacency.set(b, new Set());
    econAdjacency.get(a).add(b);
    econAdjacency.get(b).add(a);
  }

  return { nodeMap, econAdjacency };
}

/**
 * Find all sources reachable from a node via economic edges.
 */
function findReachableSources(node, nodeMap, econAdjacency) {
  const sources = [];

  // Local sources
  for (const r of node.resources) {
    if (r.type === 'source') {
      sources.push({
        nodeId: node.id,
        pos: { x: r.x, y: r.y, roomName: node.roomName },
        local: true
      });
    }
  }

  // Remote sources via economic edges
  const neighbors = econAdjacency.get(node.id) || new Set();
  for (const neighborId of neighbors) {
    const neighbor = nodeMap.get(neighborId);
    if (!neighbor) continue;
    for (const r of neighbor.resources) {
      if (r.type === 'source') {
        sources.push({
          nodeId: neighbor.id,
          pos: { x: r.x, y: r.y, roomName: neighbor.roomName },
          local: false
        });
      }
    }
  }

  return sources;
}

/**
 * Evaluate a source's profitability for a given destination.
 */
function evaluateSource(source, destPos, spawnPos, minEfficiency = 0.3) {
  const grossEnergy = SOURCE_ENERGY_PER_TICK;
  const miningCost = miningCostPerTick(source.pos, spawnPos);
  const haulCost = haulingCostPerEnergy(source.pos, destPos) * grossEnergy;
  const netEnergy = grossEnergy - miningCost - haulCost;
  const efficiency = netEnergy / grossEnergy;
  const distance = estimateDistance(source.pos, destPos);

  return {
    nodeId: source.nodeId,
    local: source.local,
    distance,
    grossEnergy,
    miningCost,
    haulCost,
    netEnergy,
    efficiency,
    profitable: efficiency >= minEfficiency
  };
}

/**
 * Evaluate a controller node for upgrading potential.
 */
function evaluateControllerNode(node, nodeMap, econAdjacency, options = {}) {
  const { minEfficiency = 0.3 } = options;

  const controller = node.resources.find(r => r.type === 'controller');
  if (!controller) return null;

  const controllerPos = { x: controller.x, y: controller.y, roomName: node.roomName };
  const spawnPos = { x: node.peakPosition.x, y: node.peakPosition.y, roomName: node.roomName };

  const reachableSources = findReachableSources(node, nodeMap, econAdjacency);

  let totalGrossEnergy = 0;
  let totalCosts = 0;
  const sources = [];

  for (const source of reachableSources) {
    const evaluation = evaluateSource(source, controllerPos, spawnPos, minEfficiency);

    if (evaluation.profitable) {
      totalGrossEnergy += evaluation.grossEnergy;
      totalCosts += evaluation.miningCost + evaluation.haulCost;
      sources.push(evaluation);
    }
  }

  sources.sort((a, b) => b.netEnergy - a.netEnergy);

  const netEnergy = totalGrossEnergy - totalCosts;
  const localSources = sources.filter(s => s.local).length;
  const remoteSources = sources.filter(s => !s.local).length;

  return {
    nodeId: node.id,
    roomName: node.roomName,
    controllerPos,
    sourceCount: sources.length,
    localSources,
    remoteSources,
    canBootstrap: localSources > 0,
    grossEnergy: totalGrossEnergy,
    totalCosts,
    netEnergy,
    efficiency: totalGrossEnergy > 0 ? netEnergy / totalGrossEnergy : 0,
    sources
  };
}

/**
 * Find the best node for upgrading from a network.
 */
function findBestUpgradingNode(network, options = {}) {
  const { nodeMap, econAdjacency } = buildEconomicGraph(network);

  const controllerNodes = network.nodes.filter(n =>
    n.resources.some(r => r.type === 'controller')
  );

  const evaluations = controllerNodes
    .map(n => evaluateControllerNode(n, nodeMap, econAdjacency, options))
    .filter(e => e !== null)
    .sort((a, b) => b.netEnergy - a.netEnergy);

  return {
    best: evaluations[0] || null,
    bestBootstrappable: evaluations.find(e => e.canBootstrap) || null,
    all: evaluations
  };
}

module.exports = {
  parseRoom,
  estimateDistance,
  miningCostPerTick,
  haulingCostPerEnergy,
  buildEconomicGraph,
  findReachableSources,
  evaluateSource,
  evaluateControllerNode,
  findBestUpgradingNode,
  SOURCE_ENERGY_PER_TICK,
  CREEP_LIFESPAN,
  BODY_COSTS
};
