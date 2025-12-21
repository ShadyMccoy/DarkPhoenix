/**
 * Tests for economic analysis module.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseRoom,
  estimateDistance,
  miningCostPerTick,
  haulingCostPerEnergy,
  findBestUpgradingNode,
  SOURCE_ENERGY_PER_TICK
} = require('./lib/economic-analysis');

// Load fixture data
const network = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures/econ-network.json'), 'utf-8'
));

describe('Economic Analysis', function() {

  describe('parseRoom', function() {
    it('parses east-north rooms', function() {
      const coords = parseRoom('E75N8');
      assert.strictEqual(coords.x, 75);
      assert.strictEqual(coords.y, -9);
    });

    it('parses west-south rooms', function() {
      const coords = parseRoom('W10S5');
      assert.strictEqual(coords.x, -11);
      assert.strictEqual(coords.y, 5);
    });
  });

  describe('estimateDistance', function() {
    it('calculates same-room distance', function() {
      const pos1 = { x: 10, y: 10, roomName: 'E75N8' };
      const pos2 = { x: 20, y: 15, roomName: 'E75N8' };
      const dist = estimateDistance(pos1, pos2);
      assert.strictEqual(dist, 10); // Chebyshev distance
    });

    it('calculates cross-room distance', function() {
      const pos1 = { x: 25, y: 25, roomName: 'E75N8' };
      const pos2 = { x: 25, y: 25, roomName: 'E76N8' };
      const dist = estimateDistance(pos1, pos2);
      assert.strictEqual(dist, 50); // 1 room = 50 tiles
    });
  });

  describe('miningCostPerTick', function() {
    it('calculates mining cost for local source', function() {
      const sourcePos = { x: 30, y: 30, roomName: 'E75N8' };
      const spawnPos = { x: 25, y: 25, roomName: 'E75N8' };
      const cost = miningCostPerTick(sourcePos, spawnPos);
      // Should be low for nearby source
      assert(cost < 1, `Expected cost < 1, got ${cost}`);
    });

    it('calculates higher cost for remote source', function() {
      const sourcePos = { x: 25, y: 25, roomName: 'E76N8' };
      const spawnPos = { x: 25, y: 25, roomName: 'E75N8' };
      const cost = miningCostPerTick(sourcePos, spawnPos);
      // Should be higher for far source
      assert(cost > 1, `Expected cost > 1, got ${cost}`);
    });
  });

  describe('haulingCostPerEnergy', function() {
    it('calculates low cost for short distance', function() {
      const sourcePos = { x: 30, y: 30, roomName: 'E75N8' };
      const destPos = { x: 25, y: 25, roomName: 'E75N8' };
      const cost = haulingCostPerEnergy(sourcePos, destPos);
      assert(cost < 0.1, `Expected cost < 0.1, got ${cost}`);
    });

    it('calculates higher cost for long distance', function() {
      const sourcePos = { x: 25, y: 25, roomName: 'E77N8' };
      const destPos = { x: 25, y: 25, roomName: 'E75N8' };
      const cost = haulingCostPerEnergy(sourcePos, destPos);
      assert(cost > 0.2, `Expected cost > 0.2, got ${cost}`);
    });
  });

  describe('findBestUpgradingNode', function() {
    it('finds the best node from fixture data', function() {
      const result = findBestUpgradingNode(network);

      assert(result.best !== null, 'Should find a best node');
      assert(result.best.nodeId, 'Best node should have an ID');
      assert(result.best.netEnergy > 0, 'Best node should have positive net energy');
    });

    it('finds a bootstrappable node', function() {
      const result = findBestUpgradingNode(network);

      assert(result.bestBootstrappable !== null, 'Should find a bootstrappable node');
      assert(result.bestBootstrappable.canBootstrap === true);
      assert(result.bestBootstrappable.localSources > 0);
    });

    it('best node has highest net energy', function() {
      const result = findBestUpgradingNode(network);

      for (const node of result.all) {
        assert(node.netEnergy <= result.best.netEnergy,
          `Node ${node.nodeId} has higher net energy than best`);
      }
    });

    it('respects minEfficiency option', function() {
      const loose = findBestUpgradingNode(network, { minEfficiency: 0.1 });
      const strict = findBestUpgradingNode(network, { minEfficiency: 0.5 });

      // Loose threshold should include more sources
      assert(loose.best.sourceCount >= strict.best.sourceCount,
        'Loose threshold should include more sources');
    });

    it('all sources meet efficiency threshold', function() {
      const result = findBestUpgradingNode(network, { minEfficiency: 0.3 });

      for (const source of result.best.sources) {
        assert(source.efficiency >= 0.3,
          `Source ${source.nodeId} has efficiency ${source.efficiency} < 0.3`);
      }
    });
  });

  describe('fixture data integrity', function() {
    it('has expected structure', function() {
      assert(network.nodes.length > 0, 'Should have nodes');
      assert(network.economicEdges.length > 0, 'Should have economic edges');
      assert(network.spatialEdges.length > 0, 'Should have spatial edges');
    });

    it('has controller nodes', function() {
      const controllerNodes = network.nodes.filter(n =>
        n.resources.some(r => r.type === 'controller')
      );
      assert(controllerNodes.length > 0, 'Should have controller nodes');
    });

    it('has source nodes', function() {
      const sourceNodes = network.nodes.filter(n =>
        n.resources.some(r => r.type === 'source')
      );
      assert(sourceNodes.length > 0, 'Should have source nodes');
    });
  });
});
