import { expect } from "chai";
import {
  createSupplyEdge,
  createCarryEdge,
  calculateSupplyEdgeNetEnergy,
  calculateSupplyEdgeNetPerTick,
  calculateCarryEdgeThroughput,
  calculateCarryEdgeCostPerEnergy,
  calculateCarryEdgeEfficiency,
  calculateOptimalMinerSize,
  calculateMinerSpawnCost,
  calculateHaulerSpawnCost,
  BODY_PART_COSTS,
} from "../../../src/framework/FlowEdge";

describe("FlowEdge", () => {
  describe("BODY_PART_COSTS", () => {
    it("should have correct costs", () => {
      expect(BODY_PART_COSTS.work).to.equal(100);
      expect(BODY_PART_COSTS.carry).to.equal(50);
      expect(BODY_PART_COSTS.move).to.equal(50);
    });
  });

  describe("calculateMinerSpawnCost()", () => {
    it("should calculate cost for 5 WORK miner", () => {
      // 5 WORK + 3 MOVE (ceil(5/2) = 3)
      // 5 * 100 + 3 * 50 = 500 + 150 = 650
      expect(calculateMinerSpawnCost(5)).to.equal(650);
    });

    it("should calculate cost for 1 WORK miner", () => {
      // 1 WORK + 1 MOVE
      // 1 * 100 + 1 * 50 = 150
      expect(calculateMinerSpawnCost(1)).to.equal(150);
    });

    it("should calculate cost for 10 WORK miner", () => {
      // 10 WORK + 5 MOVE
      // 10 * 100 + 5 * 50 = 1000 + 250 = 1250
      expect(calculateMinerSpawnCost(10)).to.equal(1250);
    });
  });

  describe("calculateHaulerSpawnCost()", () => {
    it("should calculate cost for 10 CARRY hauler", () => {
      // 10 CARRY + 10 MOVE (1:1 ratio)
      // 10 * (50 + 50) = 1000
      expect(calculateHaulerSpawnCost(10)).to.equal(1000);
    });

    it("should calculate cost for 1 CARRY hauler", () => {
      // 1 CARRY + 1 MOVE
      expect(calculateHaulerSpawnCost(1)).to.equal(100);
    });
  });

  describe("calculateOptimalMinerSize()", () => {
    it("should return 5 for standard source", () => {
      // 3000 energy / 300 ticks = 10 energy/tick
      // 10 / 2 = 5 WORK parts
      expect(calculateOptimalMinerSize(3000, 300)).to.equal(5);
    });

    it("should return 2 for smaller source", () => {
      // 1000 energy / 300 ticks = 3.33 energy/tick
      // ceil(3.33 / 2) = 2 WORK parts
      expect(calculateOptimalMinerSize(1000, 300)).to.equal(2);
    });
  });

  describe("createSupplyEdge()", () => {
    it("should create a supply edge with calculated values", () => {
      const edge = createSupplyEdge({
        sourceId: "source-1",
        sourceNodeId: "node-1",
        sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
        sourceCapacity: 3000,
        spawnId: "spawn-1",
        spawnNodeId: "node-2",
        spawnToSourceDistance: 50,
      });

      expect(edge.type).to.equal("supply");
      expect(edge.sourceId).to.equal("source-1");
      expect(edge.spawnId).to.equal("spawn-1");
      expect(edge.sourceCapacity).to.equal(3000);
      expect(edge.minerWorkParts).to.equal(5); // Optimal for 3000 capacity
      expect(edge.minerSpawnCost).to.equal(650); // 5 WORK + 3 MOVE
      expect(edge.minerLifetime).to.equal(1500);
    });

    it("should use custom miner size if provided", () => {
      const edge = createSupplyEdge({
        sourceId: "source-1",
        sourceNodeId: "node-1",
        sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
        sourceCapacity: 3000,
        spawnId: "spawn-1",
        spawnNodeId: "node-2",
        spawnToSourceDistance: 50,
        minerWorkParts: 3,
      });

      expect(edge.minerWorkParts).to.equal(3);
    });
  });

  describe("calculateSupplyEdgeNetEnergy()", () => {
    it("should calculate net energy for a standard source", () => {
      const edge = createSupplyEdge({
        sourceId: "source-1",
        sourceNodeId: "node-1",
        sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
        sourceCapacity: 3000,
        spawnId: "spawn-1",
        spawnNodeId: "node-2",
        spawnToSourceDistance: 50,
      });

      // 5 WORK * 2 energy/tick = 10 energy/tick
      // Source regen: 3000 every 300 ticks = 10 energy/tick
      // Over 1500 ticks: 5 regen cycles * 3000 = 15000 energy
      // Net = 15000 - 650 spawn cost = 14350
      const net = calculateSupplyEdgeNetEnergy(edge);
      expect(net).to.equal(14350);
    });
  });

  describe("calculateSupplyEdgeNetPerTick()", () => {
    it("should calculate net energy per tick", () => {
      const edge = createSupplyEdge({
        sourceId: "source-1",
        sourceNodeId: "node-1",
        sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
        sourceCapacity: 3000,
        spawnId: "spawn-1",
        spawnNodeId: "node-2",
        spawnToSourceDistance: 50,
      });

      // Net = 14350 over 1500 ticks = ~9.57/tick
      const netPerTick = calculateSupplyEdgeNetPerTick(edge);
      expect(netPerTick).to.be.closeTo(9.567, 0.01);
    });
  });

  describe("createCarryEdge()", () => {
    it("should create a carry edge with calculated values", () => {
      const edge = createCarryEdge({
        fromNodeId: "node-1",
        toNodeId: "node-2",
        spawnId: "spawn-1",
        walkingDistance: 50,
      });

      expect(edge.type).to.equal("carry");
      expect(edge.fromNodeId).to.equal("node-1");
      expect(edge.toNodeId).to.equal("node-2");
      expect(edge.walkingDistance).to.equal(50);
      expect(edge.roundTripTicks).to.equal(110); // 50 * 2 + 10
      expect(edge.haulerCarryCapacity).to.equal(500); // 10 CARRY * 50
      expect(edge.haulerSpawnCost).to.equal(1000); // 10 * (50+50)
    });
  });

  describe("calculateCarryEdgeThroughput()", () => {
    it("should calculate throughput for a carry edge", () => {
      const edge = createCarryEdge({
        fromNodeId: "node-1",
        toNodeId: "node-2",
        spawnId: "spawn-1",
        walkingDistance: 50,
      });

      // Round trip = 110 ticks
      // Trips per lifetime = 1500 / 110 = 13
      // Total carried = 13 * 500 = 6500
      // Throughput = 6500 / 1500 = 4.33/tick
      const throughput = calculateCarryEdgeThroughput(edge);
      expect(throughput).to.be.closeTo(4.33, 0.1);
    });
  });

  describe("calculateCarryEdgeCostPerEnergy()", () => {
    it("should calculate cost per energy unit", () => {
      const edge = createCarryEdge({
        fromNodeId: "node-1",
        toNodeId: "node-2",
        spawnId: "spawn-1",
        walkingDistance: 50,
      });

      // Spawn cost = 1000
      // Total carried = 6500
      // Cost per energy = 1000 / 6500 = 0.154
      const costPerEnergy = calculateCarryEdgeCostPerEnergy(edge);
      expect(costPerEnergy).to.be.closeTo(0.154, 0.01);
    });

    it("should return Infinity for zero throughput", () => {
      const edge = createCarryEdge({
        fromNodeId: "node-1",
        toNodeId: "node-2",
        spawnId: "spawn-1",
        walkingDistance: 1000, // Very long distance
        haulerLifetime: 100, // Short lifetime
      });

      // With 1000 distance, round trip = 2010 ticks
      // Lifetime = 100, so 0 complete trips
      const costPerEnergy = calculateCarryEdgeCostPerEnergy(edge);
      expect(costPerEnergy).to.equal(Infinity);
    });
  });

  describe("calculateCarryEdgeEfficiency()", () => {
    it("should calculate efficiency for a carry edge", () => {
      const edge = createCarryEdge({
        fromNodeId: "node-1",
        toNodeId: "node-2",
        spawnId: "spawn-1",
        walkingDistance: 50,
      });

      // Cost per energy = 0.154
      // Efficiency = 1 / (1 + 0.154) = 0.867
      const efficiency = calculateCarryEdgeEfficiency(edge);
      expect(efficiency).to.be.closeTo(0.867, 0.01);
    });

    it("should return 0 for zero throughput", () => {
      const edge = createCarryEdge({
        fromNodeId: "node-1",
        toNodeId: "node-2",
        spawnId: "spawn-1",
        walkingDistance: 1000,
        haulerLifetime: 100,
      });

      const efficiency = calculateCarryEdgeEfficiency(edge);
      expect(efficiency).to.equal(0);
    });

    it("should approach 1.0 for short distances", () => {
      const edge = createCarryEdge({
        fromNodeId: "node-1",
        toNodeId: "node-2",
        spawnId: "spawn-1",
        walkingDistance: 5, // Very short distance
      });

      const efficiency = calculateCarryEdgeEfficiency(edge);
      expect(efficiency).to.be.greaterThan(0.9);
    });
  });
});
