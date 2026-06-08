import { expect } from "chai";
import {
  groupByNode,
  getNodeBalance,
  isNodeSelfSustaining,
} from "../../../src/flow/NodeFlow";
import { FlowSolution, HaulerAssignment, MinerAssignment, SinkAllocation } from "../../../src/flow/FlowTypes";

/**
 * The inter-node trade boundary: a hauler whose destination sink is in another
 * node is an export from its source node and an import into the destination node.
 * Collapsing all such crossings into one import rate + one export rate per node is
 * what lets a node be balanced as a self-contained cell against a single trade
 * term ("other nodes trading with us"), instead of enumerating its neighbours.
 */

// Only the fields groupByNode actually reads are populated; the rest of the
// FlowSolution shape is irrelevant to this grouping.
function hauler(fromId: string, toId: string, flowRate: number): HaulerAssignment {
  return { fromId, toId, flowRate, spawnId: "spawn1", carryParts: 1, distance: 10, edgeId: `${fromId}|${toId}`, spawnCostPerTick: 0 } as HaulerAssignment;
}
function miner(nodeId: string, harvestRate: number): MinerAssignment {
  return { nodeId, harvestRate, sourceId: `src-${nodeId}`, spawnId: "spawn1" } as MinerAssignment;
}
function sink(sinkId: string, allocated: number): SinkAllocation {
  return { sinkId, allocated, sinkType: "controller", demand: allocated, unmet: 0, priority: 60, sourceFlows: [] } as SinkAllocation;
}

function solution(parts: Partial<FlowSolution>): FlowSolution {
  return { miners: [], haulers: [], sinkAllocations: [], ...parts } as FlowSolution;
}

describe("NodeFlow inter-node trade boundary", () => {
  // Node A mines and ships some of it to node B; the rest feeds A's own sink.
  const sourceNodes = new Map([["srcA", "A"]]);
  const sinkNodes = new Map([["sinkA", "A"], ["sinkB", "B"]]);

  it("classifies a cross-node hauler as the source's export and the dest's import", () => {
    const flows = groupByNode(
      solution({
        miners: [miner("A", 10)],
        haulers: [hauler("srcA", "sinkA", 4), hauler("srcA", "sinkB", 6)],
        sinkAllocations: [sink("sinkA", 4), sink("sinkB", 6)],
      }),
      sourceNodes,
      sinkNodes
    );

    expect(flows.get("A")!.exportRate).to.equal(6);
    expect(flows.get("A")!.importRate).to.equal(0);
    expect(flows.get("B")!.importRate).to.equal(6);
    expect(flows.get("B")!.exportRate).to.equal(0);
  });

  it("does not count an intra-node hauler as trade", () => {
    const flows = groupByNode(
      solution({
        miners: [miner("A", 10)],
        haulers: [hauler("srcA", "sinkA", 4)], // stays inside A
        sinkAllocations: [sink("sinkA", 4)],
      }),
      sourceNodes,
      sinkNodes
    );
    expect(flows.get("A")!.exportRate).to.equal(0);
    expect(flows.get("A")!.importRate).to.equal(0);
  });

  it("balances each node as a cell: harvest + imports = consumption + exports", () => {
    const flows = groupByNode(
      solution({
        miners: [miner("A", 10)],
        haulers: [hauler("srcA", "sinkA", 4), hauler("srcA", "sinkB", 6)],
        sinkAllocations: [sink("sinkA", 4), sink("sinkB", 6)],
      }),
      sourceNodes,
      sinkNodes
    );

    // A: harvest 10, consumption 4, exports 6 -> net 0, net exporter.
    const a = getNodeBalance(flows.get("A")!);
    expect(a.net).to.equal(0);
    expect(a.netTrade).to.equal(-6); // net exporter
    expect(isNodeSelfSustaining(flows.get("A")!)).to.equal(true);

    // B: no harvest, consumption 6, imports 6 -> net 0, net importer, not sustaining.
    const b = getNodeBalance(flows.get("B")!);
    expect(b.net).to.equal(0);
    expect(b.netTrade).to.equal(6); // net importer
    expect(isNodeSelfSustaining(flows.get("B")!)).to.equal(false);
  });
});
