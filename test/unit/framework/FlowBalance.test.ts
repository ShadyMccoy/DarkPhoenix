import { expect } from "chai";
import {
  solveFlowBalance,
  formatFlowAllocation,
  FlowAllocation,
  SupplyAllocation,
  CarryAllocation,
} from "../../../src/framework/FlowBalance";
import { createSupplyEdge, createCarryEdge, SupplyEdge, CarryEdge } from "../../../src/framework/FlowEdge";

describe("FlowBalance", () => {
  describe("solveFlowBalance()", () => {
    it("should solve for a single local source", () => {
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "source-1",
          sourceNodeId: "node-1", // Same as spawn node (local)
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 5,
        }),
      ];

      const carryEdges: CarryEdge[] = [];

      const result = solveFlowBalance(supplyEdges, carryEdges);

      expect(result.isSustainable).to.be.true;
      expect(result.totalProduction).to.be.greaterThan(0);
      expect(result.projectEnergy).to.be.greaterThan(0);
      expect(result.supplies).to.have.length(1);
      expect(result.supplies[0].isLocal).to.be.true;
    });

    it("should solve for a remote source with hauling", () => {
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "source-1",
          sourceNodeId: "node-2", // Different from spawn node (remote)
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 50,
        }),
      ];

      const carryEdges: CarryEdge[] = [
        createCarryEdge({
          fromNodeId: "node-1",
          toNodeId: "node-2",
          spawnId: "spawn-1",
          walkingDistance: 50,
        }),
      ];

      const result = solveFlowBalance(supplyEdges, carryEdges);

      expect(result.isSustainable).to.be.true;
      expect(result.supplies[0].isLocal).to.be.false;
      // Should have some hauling overhead
      expect(result.totalOverhead).to.be.greaterThan(0);
    });

    it("should handle multiple sources", () => {
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "source-1",
          sourceNodeId: "node-1",
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 5,
        }),
        createSupplyEdge({
          sourceId: "source-2",
          sourceNodeId: "node-1",
          sourcePosition: { x: 40, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 10,
        }),
      ];

      const result = solveFlowBalance(supplyEdges, []);

      expect(result.isSustainable).to.be.true;
      expect(result.supplies).to.have.length(2);
      // Total production should be roughly double a single source
      expect(result.totalProduction).to.be.greaterThan(15);
    });

    it("should identify unsustainable configurations", () => {
      // Create an absurd situation: very long distance with minimal capacity
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "source-1",
          sourceNodeId: "node-2",
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 100, // Very small source
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 200,
          minerWorkParts: 10, // Overkill miners
        }),
      ];

      const carryEdges: CarryEdge[] = [
        createCarryEdge({
          fromNodeId: "node-1",
          toNodeId: "node-2",
          spawnId: "spawn-1",
          walkingDistance: 200,
        }),
      ];

      const result = solveFlowBalance(supplyEdges, carryEdges);

      // The solver should trim allocations to try to make it sustainable
      // or report it as unsustainable
      // Either the minerCount is 0 or it's marked unsustainable
      const trimmed = result.supplies.every(s => s.minerCount === 0);
      expect(trimmed || !result.isSustainable).to.be.true;
    });
  });

  describe("formatFlowAllocation()", () => {
    it("should format a sustainable allocation", () => {
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "source-1",
          sourceNodeId: "node-1",
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 5,
        }),
      ];

      const result = solveFlowBalance(supplyEdges, []);
      const formatted = formatFlowAllocation(result);

      expect(formatted).to.include("Flow Allocation Summary");
      expect(formatted).to.include("Sustainable");
      expect(formatted).to.include("YES");
    });

    it("should include mining details", () => {
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "source-1",
          sourceNodeId: "node-1",
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 5,
        }),
      ];

      const result = solveFlowBalance(supplyEdges, []);
      const formatted = formatFlowAllocation(result);

      expect(formatted).to.include("Mining");
      expect(formatted).to.include("source-1");
      expect(formatted).to.include("local");
    });
  });

  describe("allocation details", () => {
    it("should correctly identify local vs remote sources", () => {
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "local-source",
          sourceNodeId: "node-1",
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1", // Same node = local
          spawnToSourceDistance: 5,
        }),
        createSupplyEdge({
          sourceId: "remote-source",
          sourceNodeId: "node-2",
          sourcePosition: { x: 10, y: 10, roomName: "E1N2" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1", // Different node = remote
          spawnToSourceDistance: 100,
        }),
      ];

      const result = solveFlowBalance(supplyEdges, []);

      const localSupply = result.supplies.find(s => s.edge.sourceId === "local-source");
      const remoteSupply = result.supplies.find(s => s.edge.sourceId === "remote-source");

      expect(localSupply).to.exist;
      expect(localSupply!.isLocal).to.be.true;
      expect(remoteSupply).to.exist;
      expect(remoteSupply!.isLocal).to.be.false;
    });

    it("should calculate harvest and spawn costs correctly", () => {
      const supplyEdges: SupplyEdge[] = [
        createSupplyEdge({
          sourceId: "source-1",
          sourceNodeId: "node-1",
          sourcePosition: { x: 10, y: 10, roomName: "E1N1" },
          sourceCapacity: 3000,
          spawnId: "spawn-1",
          spawnNodeId: "node-1",
          spawnToSourceDistance: 5,
        }),
      ];

      const result = solveFlowBalance(supplyEdges, []);
      const supply = result.supplies[0];

      // With 1 miner and 5 WORK parts
      // Harvest = min(5 * 2, 3000/300) = min(10, 10) = 10/tick
      expect(supply.harvestPerTick).to.equal(10);

      // Spawn cost = 650 / 1500 = 0.433/tick
      expect(supply.spawnCostPerTick).to.be.closeTo(0.433, 0.01);

      // Net = 10 - 0.433 = 9.567/tick
      expect(supply.netPerTick).to.be.closeTo(9.567, 0.01);
    });
  });
});
