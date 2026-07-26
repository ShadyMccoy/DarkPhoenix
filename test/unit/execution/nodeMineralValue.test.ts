import { expect } from "chai";
import { nodeMineralValue } from "../../../src/execution/IncrementalAnalysis";
import { Node, NodeResource, createNode } from "../../../src/nodes/Node";
import { DEFAULT_MARKET_PRICES, mineralNodeValue } from "../../../src/economy/mineralValue";
import { Position } from "../../../src/types/Position";

const ROOM = "W5N5";
function at(x: number, y: number): Position {
  return { x, y, roomName: ROOM };
}
function nodeWith(resources: NodeResource[]): Node {
  const node = createNode(`${ROOM}-25-25`, ROOM, at(25, 25), 0, [ROOM], 0);
  node.resources = resources;
  return node;
}

/**
 * The IncrementalAnalysis seam that turns a node's staged mineral resource into
 * the gross EV term (spec 22). Covered directly because sim/grid worlds may not
 * stage mineral density - the sim-blind-spot the trap-list warns about.
 */
describe("nodeMineralValue (IncrementalAnalysis integration seam)", () => {
  it("credits a staged mineral, using peak->deposit distance for the haul leg", () => {
    const node = nodeWith([{ type: "mineral", id: "m", position: at(30, 25), mineralType: "X", mineralDensity: 3 }]);
    const expected = mineralNodeValue({ mineralType: "X", density: 3, distance: 5 }, DEFAULT_MARKET_PRICES);
    expect(nodeMineralValue(node, DEFAULT_MARKET_PRICES)).to.be.closeTo(expected, 1e-9);
    expect(expected).to.be.greaterThan(0);
  });

  it("prefers exact ore amount when the resource carries it", () => {
    const node = nodeWith([
      { type: "mineral", id: "m", position: at(25, 25), mineralType: "O", mineralDensity: 3, mineralAmount: 40_000 }
    ]);
    const expected = mineralNodeValue({ mineralType: "O", amount: 40_000, distance: 0 }, DEFAULT_MARKET_PRICES);
    expect(nodeMineralValue(node, DEFAULT_MARKET_PRICES)).to.be.closeTo(expected, 1e-9);
  });

  it("credits nothing for a mineral with no density staged (unscouted)", () => {
    const node = nodeWith([{ type: "mineral", id: "m", position: at(30, 25), mineralType: "X" }]);
    expect(nodeMineralValue(node, DEFAULT_MARKET_PRICES)).to.equal(0);
  });

  it("credits nothing for a node with no mineral", () => {
    const node = nodeWith([{ type: "source", id: "s", position: at(30, 25), capacity: 3000 }]);
    expect(nodeMineralValue(node, DEFAULT_MARKET_PRICES)).to.equal(0);
  });
});
