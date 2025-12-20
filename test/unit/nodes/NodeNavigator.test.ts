import { expect } from "chai";
import {
  NodeNavigator,
  createEdgeKey,
  parseEdgeKey,
  estimateWalkingDistance,
  createNodeNavigator,
  buildEconomicEdges,
  addEconomicEdgesToNavigator,
  EdgeType
} from "../../../src/nodes/NodeNavigator";
import { Node, createNode } from "../../../src/nodes/Node";
import { Position } from "../../../src/market/Offer";

describe("NodeNavigator", () => {
  // Helper to create test nodes
  function makeNode(
    id: string,
    roomName: string,
    x: number,
    y: number
  ): Node {
    const position: Position = { x, y, roomName };
    return createNode(id, roomName, position, 100, [roomName], 0);
  }

  describe("createEdgeKey()", () => {
    it("should create sorted edge key", () => {
      expect(createEdgeKey("node-a", "node-b")).to.equal("node-a|node-b");
      expect(createEdgeKey("node-b", "node-a")).to.equal("node-a|node-b");
    });

    it("should handle complex node IDs", () => {
      expect(createEdgeKey("E75N8-47-36", "E75N8-40-20")).to.equal(
        "E75N8-40-20|E75N8-47-36"
      );
    });
  });

  describe("parseEdgeKey()", () => {
    it("should parse edge key into node IDs", () => {
      const [id1, id2] = parseEdgeKey("node-a|node-b");
      expect(id1).to.equal("node-a");
      expect(id2).to.equal("node-b");
    });

    it("should handle complex node IDs", () => {
      const [id1, id2] = parseEdgeKey("E75N8-40-20|E75N8-47-36");
      expect(id1).to.equal("E75N8-40-20");
      expect(id2).to.equal("E75N8-47-36");
    });
  });

  describe("estimateWalkingDistance()", () => {
    it("should return Chebyshev distance for same room", () => {
      const from: Position = { x: 10, y: 10, roomName: "E1N1" };
      const to: Position = { x: 20, y: 15, roomName: "E1N1" };

      // Chebyshev distance = max(|20-10|, |15-10|) = max(10, 5) = 10
      expect(estimateWalkingDistance(from, to)).to.equal(10);
    });

    it("should return 0 for same position", () => {
      const pos: Position = { x: 25, y: 25, roomName: "E1N1" };
      expect(estimateWalkingDistance(pos, pos)).to.equal(0);
    });

    it("should estimate cross-room distance", () => {
      const from: Position = { x: 25, y: 25, roomName: "E1N1" };
      const to: Position = { x: 25, y: 25, roomName: "E2N1" };

      // 1 room away = 50 tiles + in-room offset (0)
      const distance = estimateWalkingDistance(from, to);
      expect(distance).to.be.greaterThan(40);
      expect(distance).to.be.lessThan(100);
    });

    it("should handle W/E room boundaries", () => {
      const from: Position = { x: 25, y: 25, roomName: "W0N1" };
      const to: Position = { x: 25, y: 25, roomName: "E0N1" };

      // W0 and E0 are adjacent rooms
      const distance = estimateWalkingDistance(from, to);
      expect(distance).to.be.greaterThan(40);
      expect(distance).to.be.lessThan(100);
    });
  });

  describe("NodeNavigator constructor", () => {
    it("should create empty navigator with no nodes", () => {
      const nav = new NodeNavigator([], []);
      expect(nav.nodeCount).to.equal(0);
      expect(nav.edgeCount).to.equal(0);
    });

    it("should index nodes by ID", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 25, 25),
        makeNode("node-2", "E1N1", 40, 40)
      ];

      const nav = new NodeNavigator(nodes, []);

      expect(nav.nodeCount).to.equal(2);
      expect(nav.getNode("node-1")).to.exist;
      expect(nav.getNode("node-2")).to.exist;
      expect(nav.getNode("node-3")).to.be.undefined;
    });

    it("should build adjacency from edges", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20),
        makeNode("node-3", "E1N1", 30, 30)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];

      const nav = new NodeNavigator(nodes, edges);

      expect(nav.getNeighbors("node-1")).to.deep.equal(["node-2"]);
      expect(nav.getNeighbors("node-2")).to.include.members(["node-1", "node-3"]);
      expect(nav.getNeighbors("node-3")).to.deep.equal(["node-2"]);
    });

    it("should use provided edge weights", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];
      const edges = ["node-1|node-2"];
      const weights = new Map([["node-1|node-2", 42]]);

      const nav = new NodeNavigator(nodes, edges, weights);

      expect(nav.getEdgeWeight("node-1", "node-2")).to.equal(42);
    });

    it("should default edge weight to 1 when not provided", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];
      const edges = ["node-1|node-2"];

      const nav = new NodeNavigator(nodes, edges);

      // Default weight is 1 when not provided
      expect(nav.getEdgeWeight("node-1", "node-2")).to.equal(1);
    });
  });

  describe("getNeighbors()", () => {
    it("should return empty array for isolated node", () => {
      const nodes = [makeNode("node-1", "E1N1", 25, 25)];
      const nav = new NodeNavigator(nodes, []);

      expect(nav.getNeighbors("node-1")).to.deep.equal([]);
    });

    it("should return empty array for unknown node", () => {
      const nav = new NodeNavigator([], []);
      expect(nav.getNeighbors("unknown")).to.deep.equal([]);
    });
  });

  describe("areAdjacent()", () => {
    it("should return true for connected nodes", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];
      const nav = new NodeNavigator(nodes, ["node-1|node-2"]);

      expect(nav.areAdjacent("node-1", "node-2")).to.be.true;
      expect(nav.areAdjacent("node-2", "node-1")).to.be.true;
    });

    it("should return false for non-connected nodes", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20),
        makeNode("node-3", "E1N1", 30, 30)
      ];
      const nav = new NodeNavigator(nodes, ["node-1|node-2"]);

      expect(nav.areAdjacent("node-1", "node-3")).to.be.false;
    });
  });

  describe("findPath()", () => {
    it("should return single-node path for same start and end", () => {
      const nodes = [makeNode("node-1", "E1N1", 25, 25)];
      const nav = new NodeNavigator(nodes, []);

      const result = nav.findPath("node-1", "node-1");

      expect(result.found).to.be.true;
      expect(result.path).to.deep.equal(["node-1"]);
      expect(result.distance).to.equal(0);
    });

    it("should find direct path between adjacent nodes", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10)
      ];
      const edges = ["node-1|node-2"];
      const weights = new Map([["node-1|node-2", 15]]);

      const nav = new NodeNavigator(nodes, edges, weights);
      const result = nav.findPath("node-1", "node-2");

      expect(result.found).to.be.true;
      expect(result.path).to.deep.equal(["node-1", "node-2"]);
      expect(result.distance).to.equal(15);
    });

    it("should find shortest path through multiple nodes", () => {
      // Create a network:
      //   node-1 --10-- node-2 --10-- node-3
      //      \                         /
      //       \-------- 100 ---------/
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3", "node-1|node-3"];
      const weights = new Map([
        ["node-1|node-2", 10],
        ["node-2|node-3", 10],
        ["node-1|node-3", 100]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights);
      const result = nav.findPath("node-1", "node-3");

      expect(result.found).to.be.true;
      expect(result.path).to.deep.equal(["node-1", "node-2", "node-3"]);
      expect(result.distance).to.equal(20);
    });

    it("should return not found for disconnected nodes", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];
      const nav = new NodeNavigator(nodes, []);

      const result = nav.findPath("node-1", "node-2");

      expect(result.found).to.be.false;
      expect(result.path).to.deep.equal([]);
      expect(result.distance).to.equal(Infinity);
    });

    it("should return not found for unknown nodes", () => {
      const nodes = [makeNode("node-1", "E1N1", 10, 10)];
      const nav = new NodeNavigator(nodes, []);

      const result = nav.findPath("node-1", "unknown");

      expect(result.found).to.be.false;
    });
  });

  describe("getDistance()", () => {
    it("should return 0 for same node", () => {
      const nodes = [makeNode("node-1", "E1N1", 25, 25)];
      const nav = new NodeNavigator(nodes, []);

      expect(nav.getDistance("node-1", "node-1")).to.equal(0);
    });

    it("should return shortest path distance", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];
      const weights = new Map([
        ["node-1|node-2", 15],
        ["node-2|node-3", 20]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights);

      expect(nav.getDistance("node-1", "node-3")).to.equal(35);
    });

    it("should return Infinity for unreachable nodes", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];
      const nav = new NodeNavigator(nodes, []);

      expect(nav.getDistance("node-1", "node-2")).to.equal(Infinity);
    });
  });

  describe("getNodesWithinDistance()", () => {
    it("should include starting node with distance 0", () => {
      const nodes = [makeNode("node-1", "E1N1", 25, 25)];
      const nav = new NodeNavigator(nodes, []);

      const result = nav.getNodesWithinDistance("node-1", 100);

      expect(result.size).to.equal(1);
      expect(result.get("node-1")).to.equal(0);
    });

    it("should find all nodes within distance", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10),
        makeNode("node-4", "E1N1", 40, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3", "node-3|node-4"];
      const weights = new Map([
        ["node-1|node-2", 10],
        ["node-2|node-3", 10],
        ["node-3|node-4", 10]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights);
      const result = nav.getNodesWithinDistance("node-1", 25);

      expect(result.size).to.equal(3);
      expect(result.has("node-1")).to.be.true;
      expect(result.has("node-2")).to.be.true;
      expect(result.has("node-3")).to.be.true;
      expect(result.has("node-4")).to.be.false;
    });

    it("should return empty for unknown start node", () => {
      const nav = new NodeNavigator([], []);
      const result = nav.getNodesWithinDistance("unknown", 100);

      expect(result.size).to.equal(0);
    });
  });

  describe("findClosest()", () => {
    it("should return start node if it's a candidate", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];
      const nav = new NodeNavigator(nodes, ["node-1|node-2"]);

      const result = nav.findClosest("node-1", new Set(["node-1", "node-2"]));

      expect(result).to.not.be.null;
      expect(result!.nodeId).to.equal("node-1");
      expect(result!.distance).to.equal(0);
    });

    it("should find closest candidate", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10),
        makeNode("node-4", "E1N1", 40, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3", "node-3|node-4"];
      const weights = new Map([
        ["node-1|node-2", 10],
        ["node-2|node-3", 10],
        ["node-3|node-4", 10]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights);
      const result = nav.findClosest("node-1", new Set(["node-3", "node-4"]));

      expect(result).to.not.be.null;
      expect(result!.nodeId).to.equal("node-3");
      expect(result!.distance).to.equal(20);
    });

    it("should return null for empty candidates", () => {
      const nodes = [makeNode("node-1", "E1N1", 10, 10)];
      const nav = new NodeNavigator(nodes, []);

      const result = nav.findClosest("node-1", new Set());

      expect(result).to.be.null;
    });

    it("should return null for unreachable candidates", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];
      const nav = new NodeNavigator(nodes, []);

      const result = nav.findClosest("node-1", new Set(["node-2"]));

      expect(result).to.be.null;
    });
  });

  describe("getNodesByDistance()", () => {
    it("should return nodes sorted by distance", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];
      const weights = new Map([
        ["node-1|node-2", 15],
        ["node-2|node-3", 25]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights);
      const result = nav.getNodesByDistance("node-1");

      expect(result).to.have.length(3);
      expect(result[0]).to.deep.equal({ nodeId: "node-1", distance: 0 });
      expect(result[1]).to.deep.equal({ nodeId: "node-2", distance: 15 });
      expect(result[2]).to.deep.equal({ nodeId: "node-3", distance: 40 });
    });

    it("should respect limit", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];

      const nav = new NodeNavigator(nodes, edges);
      const result = nav.getNodesByDistance("node-1", 2);

      expect(result).to.have.length(2);
    });
  });

  describe("subgraph()", () => {
    it("should create subgraph with specified nodes", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];
      const weights = new Map([
        ["node-1|node-2", 10],
        ["node-2|node-3", 20]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights);
      const sub = nav.subgraph(new Set(["node-1", "node-2"]));

      expect(sub.nodeCount).to.equal(2);
      expect(sub.edgeCount).to.equal(1);
      expect(sub.getEdgeWeight("node-1", "node-2")).to.equal(10);
    });

    it("should exclude edges with missing endpoints", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];

      const nav = new NodeNavigator(nodes, edges);
      const sub = nav.subgraph(new Set(["node-1", "node-3"]));

      expect(sub.edgeCount).to.equal(0);
      expect(sub.areAdjacent("node-1", "node-3")).to.be.false;
    });
  });

  describe("isConnected()", () => {
    it("should return true for empty graph", () => {
      const nav = new NodeNavigator([], []);
      expect(nav.isConnected()).to.be.true;
    });

    it("should return true for connected graph", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];

      const nav = new NodeNavigator(nodes, edges);
      expect(nav.isConnected()).to.be.true;
    });

    it("should return false for disconnected graph", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2"];

      const nav = new NodeNavigator(nodes, edges);
      expect(nav.isConnected()).to.be.false;
    });
  });

  describe("getConnectedComponents()", () => {
    it("should return empty for empty graph", () => {
      const nav = new NodeNavigator([], []);
      expect(nav.getConnectedComponents()).to.deep.equal([]);
    });

    it("should return single component for connected graph", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];

      const nav = new NodeNavigator(nodes, edges);
      const components = nav.getConnectedComponents();

      expect(components).to.have.length(1);
      expect(components[0].size).to.equal(3);
    });

    it("should return multiple components for disconnected graph", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10),
        makeNode("node-4", "E1N1", 40, 10)
      ];
      const edges = ["node-1|node-2", "node-3|node-4"];

      const nav = new NodeNavigator(nodes, edges);
      const components = nav.getConnectedComponents();

      expect(components).to.have.length(2);
      expect(components.some((c) => c.has("node-1") && c.has("node-2"))).to.be
        .true;
      expect(components.some((c) => c.has("node-3") && c.has("node-4"))).to.be
        .true;
    });
  });

  describe("getEdges()", () => {
    it("should return all edges with weights and types", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10)
      ];
      const edges = ["node-1|node-2"];
      const weights = new Map([["node-1|node-2", 42]]);

      const nav = new NodeNavigator(nodes, edges, weights);
      const allEdges = nav.getEdges();

      expect(allEdges).to.have.length(1);
      expect(allEdges[0]).to.deep.equal({ edge: "node-1|node-2", weight: 42, type: "spatial" });
    });

    it("should filter by edge type", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 10),
        makeNode("node-3", "E1N1", 30, 10)
      ];
      const edges = ["node-1|node-2", "node-2|node-3"];
      const weights = new Map([
        ["node-1|node-2", 10],
        ["node-2|node-3", 20]
      ]);
      const types = new Map<string, "spatial" | "economic">([
        ["node-1|node-2", "spatial"],
        ["node-2|node-3", "economic"]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights, types);

      const spatialEdges = nav.getEdges("spatial");
      expect(spatialEdges).to.have.length(1);
      expect(spatialEdges[0].edge).to.equal("node-1|node-2");

      const economicEdges = nav.getEdges("economic");
      expect(economicEdges).to.have.length(1);
      expect(economicEdges[0].edge).to.equal("node-2|node-3");
    });
  });

  describe("createNodeNavigator()", () => {
    it("should create navigator from array of edges", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];

      const nav = createNodeNavigator(nodes, ["node-1|node-2"]);

      expect(nav.nodeCount).to.equal(2);
      expect(nav.edgeCount).to.equal(1);
    });

    it("should create navigator from set of edges", () => {
      const nodes = [
        makeNode("node-1", "E1N1", 10, 10),
        makeNode("node-2", "E1N1", 20, 20)
      ];

      const nav = createNodeNavigator(nodes, new Set(["node-1|node-2"]));

      expect(nav.nodeCount).to.equal(2);
      expect(nav.edgeCount).to.equal(1);
    });
  });

  describe("complex network scenarios", () => {
    it("should handle diamond-shaped network", () => {
      //       node-2
      //      /      \
      // node-1      node-4
      //      \      /
      //       node-3
      const nodes = [
        makeNode("node-1", "E1N1", 10, 25),
        makeNode("node-2", "E1N1", 25, 10),
        makeNode("node-3", "E1N1", 25, 40),
        makeNode("node-4", "E1N1", 40, 25)
      ];
      const edges = [
        "node-1|node-2",
        "node-1|node-3",
        "node-2|node-4",
        "node-3|node-4"
      ];
      const weights = new Map([
        ["node-1|node-2", 10],
        ["node-1|node-3", 15],
        ["node-2|node-4", 10],
        ["node-3|node-4", 5]
      ]);

      const nav = new NodeNavigator(nodes, edges, weights);

      // Shortest path: node-1 -> node-3 -> node-4 = 20
      // vs node-1 -> node-2 -> node-4 = 20
      const result = nav.findPath("node-1", "node-4");
      expect(result.found).to.be.true;
      expect(result.distance).to.equal(20);
      expect(result.path).to.have.length(3);
    });

    it("should handle multi-room network", () => {
      const nodes = [
        makeNode("E1N1-25-25", "E1N1", 25, 25),
        makeNode("E1N1-40-25", "E1N1", 40, 25),
        makeNode("E2N1-10-25", "E2N1", 10, 25),
        makeNode("E2N1-40-25", "E2N1", 40, 25)
      ];
      const edges = [
        "E1N1-25-25|E1N1-40-25",
        "E1N1-40-25|E2N1-10-25",
        "E2N1-10-25|E2N1-40-25"
      ];

      const nav = new NodeNavigator(nodes, edges);

      const result = nav.findPath("E1N1-25-25", "E2N1-40-25");
      expect(result.found).to.be.true;
      expect(result.path).to.have.length(4);
    });
  });

  describe("economic edges", () => {
    // Helper to create a node with corps
    function makeNodeWithCorps(
      id: string,
      roomName: string,
      x: number,
      y: number,
      hasCorps: boolean
    ): Node {
      const position: Position = { x, y, roomName };
      const node = createNode(id, roomName, position, 100, [roomName], 0);
      if (hasCorps) {
        // Add a mock corp
        node.corps = [{
          id: `corp-${id}`,
          type: "mining",
          balance: 100,
          nodeId: id,
          createdAt: 0,
          isActive: true,
          getPosition: () => position,
          getMargin: () => 0.1,
          sells: () => [],
          buys: () => [],
          work: () => {}
        } as any];
      }
      return node;
    }

    describe("buildEconomicEdges()", () => {
      it("should return empty map when less than 2 corp-hosting nodes", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 20, false)
        ];
        const edges = ["node-1|node-2"];
        const nav = new NodeNavigator(nodes, edges);

        const economicEdges = buildEconomicEdges(nav);
        expect(economicEdges.size).to.equal(0);
      });

      it("should create economic edges between corp-hosting nodes", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 10, false),
          makeNodeWithCorps("node-3", "E1N1", 30, 10, true)
        ];
        const edges = ["node-1|node-2", "node-2|node-3"];
        const weights = new Map([
          ["node-1|node-2", 10],
          ["node-2|node-3", 15]
        ]);
        const nav = new NodeNavigator(nodes, edges, weights);

        const economicEdges = buildEconomicEdges(nav);

        expect(economicEdges.size).to.equal(1);
        const edgeKey = createEdgeKey("node-1", "node-3");
        expect(economicEdges.has(edgeKey)).to.be.true;
        // Distance through node-2: 10 + 15 = 25
        expect(economicEdges.get(edgeKey)).to.equal(25);
      });

      it("should create edges for all pairs of corp-hosting nodes", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 10, true),
          makeNodeWithCorps("node-3", "E1N1", 30, 10, true)
        ];
        const edges = ["node-1|node-2", "node-2|node-3"];
        const weights = new Map([
          ["node-1|node-2", 10],
          ["node-2|node-3", 15]
        ]);
        const nav = new NodeNavigator(nodes, edges, weights);

        const economicEdges = buildEconomicEdges(nav);

        // 3 nodes = 3 pairs: (1,2), (1,3), (2,3)
        expect(economicEdges.size).to.equal(3);
        expect(economicEdges.get(createEdgeKey("node-1", "node-2"))).to.equal(10);
        expect(economicEdges.get(createEdgeKey("node-1", "node-3"))).to.equal(25);
        expect(economicEdges.get(createEdgeKey("node-2", "node-3"))).to.equal(15);
      });
    });

    describe("addEconomicEdgesToNavigator()", () => {
      it("should add economic edges to navigator", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 10, false),
          makeNodeWithCorps("node-3", "E1N1", 30, 10, true)
        ];
        const edges = ["node-1|node-2", "node-2|node-3"];
        const weights = new Map([
          ["node-1|node-2", 10],
          ["node-2|node-3", 15]
        ]);
        const nav = new NodeNavigator(nodes, edges, weights);

        addEconomicEdgesToNavigator(nav);

        // Check economic edge was added
        expect(nav.getEdgeCount("economic")).to.equal(1);
        expect(nav.areAdjacent("node-1", "node-3", "economic")).to.be.true;
        expect(nav.getEdgeWeight("node-1", "node-3", "economic")).to.equal(25);
      });
    });

    describe("edge type traversal", () => {
      it("should traverse only spatial edges when specified", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 10, false),
          makeNodeWithCorps("node-3", "E1N1", 30, 10, true)
        ];
        const edges = ["node-1|node-2", "node-2|node-3"];
        const weights = new Map([
          ["node-1|node-2", 10],
          ["node-2|node-3", 15]
        ]);
        const nav = new NodeNavigator(nodes, edges, weights);
        addEconomicEdgesToNavigator(nav);

        // Spatial path goes through node-2
        const spatialPath = nav.findPath("node-1", "node-3", "spatial");
        expect(spatialPath.found).to.be.true;
        expect(spatialPath.path).to.deep.equal(["node-1", "node-2", "node-3"]);
        expect(spatialPath.distance).to.equal(25);
      });

      it("should traverse only economic edges when specified", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 10, false),
          makeNodeWithCorps("node-3", "E1N1", 30, 10, true)
        ];
        const edges = ["node-1|node-2", "node-2|node-3"];
        const weights = new Map([
          ["node-1|node-2", 10],
          ["node-2|node-3", 15]
        ]);
        const nav = new NodeNavigator(nodes, edges, weights);
        addEconomicEdgesToNavigator(nav);

        // Economic path is direct
        const economicPath = nav.findPath("node-1", "node-3", "economic");
        expect(economicPath.found).to.be.true;
        expect(economicPath.path).to.deep.equal(["node-1", "node-3"]);
        expect(economicPath.distance).to.equal(25);
      });

      it("should not find path via economic edges for non-corp nodes", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 10, false),
          makeNodeWithCorps("node-3", "E1N1", 30, 10, true)
        ];
        const edges = ["node-1|node-2", "node-2|node-3"];
        const nav = new NodeNavigator(nodes, edges);
        addEconomicEdgesToNavigator(nav);

        // node-2 is not economically connected
        const result = nav.findPath("node-1", "node-2", "economic");
        expect(result.found).to.be.false;
      });

      it("should get neighbors by edge type", () => {
        const nodes = [
          makeNodeWithCorps("node-1", "E1N1", 10, 10, true),
          makeNodeWithCorps("node-2", "E1N1", 20, 10, false),
          makeNodeWithCorps("node-3", "E1N1", 30, 10, true)
        ];
        const edges = ["node-1|node-2", "node-2|node-3"];
        const nav = new NodeNavigator(nodes, edges);
        addEconomicEdgesToNavigator(nav);

        // node-1's spatial neighbor is node-2
        expect(nav.getNeighbors("node-1", "spatial")).to.deep.equal(["node-2"]);

        // node-1's economic neighbor is node-3
        expect(nav.getNeighbors("node-1", "economic")).to.deep.equal(["node-3"]);
      });
    });
  });
});
