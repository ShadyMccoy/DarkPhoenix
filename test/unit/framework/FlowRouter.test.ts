import { expect } from "chai";
import {
  FlowGraph,
  buildFlowGraph,
  solveMinCostMaxFlow,
  formatFlowRouting,
} from "../../../src/framework/FlowRouter";
import { createCarryEdge, CarryEdge } from "../../../src/framework/FlowEdge";

describe("FlowRouter", () => {
  describe("FlowGraph", () => {
    it("should add nodes and arcs", () => {
      const graph = new FlowGraph();

      graph.addNode("source", 10, true, false);
      graph.addNode("sink", -10, false, true);
      graph.addArc("source", "sink", 5, 0.1);

      expect(graph.getSources()).to.have.length(1);
      expect(graph.getSinks()).to.have.length(1);
      expect(graph.getArcs()).to.have.length(1);
    });

    it("should get arcs from a node", () => {
      const graph = new FlowGraph();

      graph.addNode("A", 10, true, false);
      graph.addNode("B", 0, false, false);
      graph.addNode("C", -10, false, true);

      graph.addArc("A", "B", 5, 0.1);
      graph.addArc("A", "C", 5, 0.2);
      graph.addArc("B", "C", 5, 0.1);

      const arcsFromA = graph.getArcsFrom("A");
      expect(arcsFromA).to.have.length(2);
    });
  });

  describe("buildFlowGraph()", () => {
    it("should build graph from supplies and carry edges", () => {
      const supplies = new Map([["node-1", 10]]);
      const demands = new Map([["node-2", 10]]);
      const carryEdges: CarryEdge[] = [
        createCarryEdge({
          fromNodeId: "node-1",
          toNodeId: "node-2",
          spawnId: "spawn-1",
          walkingDistance: 50,
        }),
      ];

      const graph = buildFlowGraph(supplies, demands, carryEdges);

      expect(graph.getSources()).to.have.length(1);
      expect(graph.getSinks()).to.have.length(1);
      // Two arcs: forward and reverse direction
      expect(graph.getArcs()).to.have.length(2);
    });
  });

  describe("solveMinCostMaxFlow()", () => {
    it("should route flow from source to sink", () => {
      const graph = new FlowGraph();

      graph.addNode("source", 10, true, false);
      graph.addNode("sink", -10, false, true);
      graph.addArc("source", "sink", 20, 0.1);

      const result = solveMinCostMaxFlow(graph);

      expect(result.totalFlow).to.equal(10);
      expect(result.totalCost).to.be.closeTo(1, 0.01); // 10 * 0.1
      expect(result.unroutedSupply).to.equal(0);
      expect(result.unsatisfiedDemand).to.equal(0);
    });

    it("should respect capacity limits", () => {
      const graph = new FlowGraph();

      graph.addNode("source", 10, true, false);
      graph.addNode("sink", -10, false, true);
      graph.addArc("source", "sink", 5, 0.1); // Only 5 capacity

      const result = solveMinCostMaxFlow(graph);

      expect(result.totalFlow).to.equal(5); // Limited by capacity
      expect(result.unroutedSupply).to.equal(5); // 5 couldn't be routed
      expect(result.unsatisfiedDemand).to.equal(5); // Sink still needs 5
    });

    it("should use cheapest path first", () => {
      const graph = new FlowGraph();

      graph.addNode("source", 10, true, false);
      graph.addNode("middle", 0, false, false);
      graph.addNode("sink", -10, false, true);

      // Direct path: expensive
      graph.addArc("source", "sink", 10, 0.5);
      // Indirect path: cheap
      graph.addArc("source", "middle", 10, 0.1);
      graph.addArc("middle", "sink", 10, 0.1);

      const result = solveMinCostMaxFlow(graph);

      // Should prefer the cheaper indirect path (cost 0.2) over direct (cost 0.5)
      expect(result.totalFlow).to.equal(10);
      expect(result.totalCost).to.be.closeTo(2, 0.01); // 10 * (0.1 + 0.1)
    });

    it("should handle multiple sources and sinks", () => {
      const graph = new FlowGraph();

      graph.addNode("source1", 5, true, false);
      graph.addNode("source2", 5, true, false);
      graph.addNode("sink1", -5, false, true);
      graph.addNode("sink2", -5, false, true);

      graph.addArc("source1", "sink1", 10, 0.1);
      graph.addArc("source1", "sink2", 10, 0.2);
      graph.addArc("source2", "sink1", 10, 0.2);
      graph.addArc("source2", "sink2", 10, 0.1);

      const result = solveMinCostMaxFlow(graph);

      expect(result.totalFlow).to.equal(10);
      expect(result.sinkFlows.get("sink1")).to.equal(5);
      expect(result.sinkFlows.get("sink2")).to.equal(5);
    });

    it("should work with real carry edges", () => {
      const supplies = new Map([["node-source", 5]]); // 5/tick supply
      const demands = new Map([["node-spawn", 5]]);   // 5/tick demand

      const carryEdges: CarryEdge[] = [
        createCarryEdge({
          fromNodeId: "node-source",
          toNodeId: "node-spawn",
          spawnId: "spawn-1",
          walkingDistance: 30,
          haulerCarryParts: 10, // Gives ~7/tick throughput at 30 tiles
        }),
      ];

      const graph = buildFlowGraph(supplies, demands, carryEdges);
      const result = solveMinCostMaxFlow(graph);

      // Should route all 5 (within capacity)
      expect(result.totalFlow).to.equal(5);
      expect(result.unroutedSupply).to.equal(0);
      expect(result.unsatisfiedDemand).to.equal(0);
      // Should have transport cost
      expect(result.totalCost).to.be.greaterThan(0);
    });
  });

  describe("formatFlowRouting()", () => {
    it("should format result for display", () => {
      const graph = new FlowGraph();

      graph.addNode("source", 10, true, false);
      graph.addNode("sink", -10, false, true);
      graph.addArc("source", "sink", 20, 0.1);

      const result = solveMinCostMaxFlow(graph);
      const formatted = formatFlowRouting(result);

      expect(formatted).to.include("Flow Routing Result");
      expect(formatted).to.include("Total Flow");
      expect(formatted).to.include("Transport Cost");
      expect(formatted).to.include("Active Routes");
    });
  });
});
