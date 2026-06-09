import { expect } from "chai";
import {
  Node,
  NodeResource,
  ReachableSource,
  createNode,
  calculateNodeROI,
} from "../../../src/nodes/Node";
import { Position } from "../../../src/types/Position";

const ROOM = "W0N0";
function at(x: number, y: number): Position {
  return { x, y, roomName: ROOM };
}

/** A node at a peak with the given resources. */
function nodeWith(resources: NodeResource[]): Node {
  const node = createNode("W0N0-25-25", ROOM, at(25, 25), 100, [ROOM], 0);
  node.resources = resources;
  return node;
}

const source = (id: string, pos: Position): NodeResource => ({
  type: "source",
  id,
  position: pos,
  capacity: 3000,
});
const controller = (pos: Position): NodeResource => ({
  type: "controller",
  id: "controller-0",
  position: pos,
});

describe("calculateNodeROI (planner-backed)", () => {
  const owned = new Set([ROOM]);

  it("gives a node with a source and controller a positive economic value and score", () => {
    const node = nodeWith([source("source-A", at(25, 30)), controller(at(25, 22))]);
    const roi = calculateNodeROI(node, 10, owned);

    expect(roi.economicValue).to.be.greaterThan(0);
    expect(roi.score).to.be.greaterThan(0);
    expect(roi.expansionScore).to.be.greaterThan(0);
  });

  it("gives a node with no controller zero economic value (nothing to mint)", () => {
    const node = nodeWith([source("source-A", at(25, 30))]);
    const roi = calculateNodeROI(node, 10, owned);

    expect(roi.economicValue).to.equal(0);
  });

  it("still scores an owned node above zero via the ownership bonus", () => {
    // No controller -> zero economic value, but an owned node keeps a positive
    // score (it has infrastructure) so it is never mistaken for worthless.
    const node = nodeWith([source("source-A", at(25, 30))]);
    const roi = calculateNodeROI(node, 10, owned);

    expect(roi.economicValue).to.equal(0);
    expect(roi.isOwned).to.equal(true);
    expect(roi.score).to.be.greaterThan(0);
  });

  it("raises the expansion score when adjacent nodes offer reachable sources", () => {
    const node = nodeWith([source("source-A", at(25, 30)), controller(at(25, 22))]);
    const without = calculateNodeROI(node, 10, owned, [], []);
    const withReachable = calculateNodeROI(node, 10, owned, [], [
      { capacity: 3000, distance: 20 },
    ]);

    expect(withReachable.expansionScore).to.be.greaterThan(without.expansionScore);
  });

  it("values nearer reachable sources above farther ones", () => {
    const node = nodeWith([source("source-A", at(25, 30)), controller(at(25, 22))]);
    const near: ReachableSource[] = [{ capacity: 3000, distance: 12 }];
    const far: ReachableSource[] = [{ capacity: 3000, distance: 48 }];

    const nearRoi = calculateNodeROI(node, 10, owned, [], near);
    const farRoi = calculateNodeROI(node, 10, owned, [], far);

    expect(nearRoi.economicValue).to.be.greaterThan(farRoi.economicValue);
  });
});
