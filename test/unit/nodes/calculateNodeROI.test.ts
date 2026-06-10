import { expect } from "chai";
import { Node, NodeResource, createNode, calculateNodeROI } from "../../../src/nodes/Node";
import { Position } from "../../../src/types/Position";

const ROOM = "W0N0";
function at(x: number, y: number): Position {
  return { x, y, roomName: ROOM };
}

/** A node at a peak with the given resources. */
function nodeWith(resources: NodeResource[], roomName = ROOM): Node {
  const node = createNode(`${roomName}-25-25`, roomName, at(25, 25), 100, [roomName], 0);
  node.resources = resources;
  return node;
}

const source = (id: string, pos: Position): NodeResource => ({ type: "source", id, position: pos, capacity: 3000 });
const controller = (pos: Position): NodeResource => ({ type: "controller", id: "controller-0", position: pos });

// calculateNodeROI no longer computes the economy itself - the caller passes the
// node's marginal colony value (see ColonyEconomy). These tests cover how that
// value, ownership and openness turn into the score fields.
describe("calculateNodeROI", () => {
  const owned = new Set([ROOM]);

  it("turns a positive economic value into a positive score and expansion score", () => {
    const node = nodeWith([source("source-A", at(25, 30)), controller(at(25, 22))]);
    const roi = calculateNodeROI(node, 10, owned, [], 8);

    expect(roi.economicValue).to.equal(8);
    expect(roi.score).to.be.greaterThan(0);
    expect(roi.expansionScore).to.be.greaterThan(0);
  });

  it("scores higher for a higher economic value", () => {
    const node = nodeWith([source("source-A", at(25, 30)), controller(at(25, 22))]);
    const low = calculateNodeROI(node, 10, owned, [], 2);
    const high = calculateNodeROI(node, 10, owned, [], 20);
    expect(high.score).to.be.greaterThan(low.score);
    expect(high.expansionScore).to.be.greaterThan(low.expansionScore);
  });

  it("still scores an owned node above zero via the ownership bonus when value is 0", () => {
    const node = nodeWith([source("source-A", at(25, 30))]);
    const roi = calculateNodeROI(node, 10, owned, [], 0);

    expect(roi.economicValue).to.equal(0);
    expect(roi.isOwned).to.equal(true);
    expect(roi.score).to.be.greaterThan(0);
  });
});
