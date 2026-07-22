import { expect } from "chai";
import {
  EXPANSION_CAPEX,
  EXPANSION_SAFETY_RESERVE,
  EXPAND_MIN_SCORE,
  ExpansionCandidate,
  ExpansionFacts,
  expansionCandidates,
  shouldExpand
} from "../../../src/economy/expansion";
import { createNode, Node } from "../../../src/nodes/Node";

const CAND: ExpansionCandidate = {
  nodeId: "n1",
  roomName: "W1N0",
  score: 100,
  spawnPos: { x: 25, y: 25, roomName: "W1N0" }
};
const ENOUGH = EXPANSION_CAPEX + EXPANSION_SAFETY_RESERVE;

function nodeIn(id: string, roomName: string, expansionScore: number, isOwned = false): Node {
  const n = createNode(id, roomName, { x: 25, y: 25, roomName }, 50, [roomName], 0);
  n.roi = { score: expansionScore, expansionScore, isOwned } as Node["roi"];
  return n;
}

describe("economy/expansion - the capital-gated trigger (spec 06, pure since spec 17 P3)", () => {
  // The facts arrive as DATA (ExpansionCampaign gathers them live) - the
  // module under test never reads Game/Memory (purity ratchet enforces).
  let facts: ExpansionFacts;
  beforeEach(() => {
    facts = {
      placements: { n1: { x: 25, y: 25, roomName: "W1N0" } },
      intel: { W1N0: { controllerPos: { x: 30, y: 30 }, controllerOwner: null } },
      hostileRooms: new Set()
    };
  });

  it("shouldExpand: needs GCL headroom, a candidate, and the full CAPEX banked", () => {
    expect(shouldExpand(2, 1, [CAND], ENOUGH)).to.equal(true);
    expect(shouldExpand(1, 1, [CAND], ENOUGH), "no GCL headroom").to.equal(false);
    expect(shouldExpand(2, 1, [], ENOUGH), "no candidate").to.equal(false);
    expect(shouldExpand(2, 1, [CAND], ENOUGH - 1), "bank below CAPEX + reserve").to.equal(false);
  });

  it("expansionCandidates: unowned, intel'd, placed, scored - best first", () => {
    facts.placements.n2 = { x: 20, y: 20, roomName: "W2N0" };
    facts.intel.W2N0 = { controllerPos: { x: 10, y: 10 }, controllerOwner: null };
    const nodes = [nodeIn("n1", "W1N0", 100), nodeIn("n2", "W2N0", 150)];
    const out = expansionCandidates(nodes, new Set(["W0N0"]), facts);
    expect(out.map(c => c.nodeId)).to.deep.equal(["n2", "n1"]); // score-descending
    expect(out[0].spawnPos).to.deep.include({ x: 20, y: 20 });
  });

  it("filters owned rooms, low scores, missing intel/placement, and taken controllers", () => {
    const owned = new Set(["W0N0"]);
    // owned via roi
    expect(expansionCandidates([nodeIn("n1", "W1N0", 100, true)], owned, facts)).to.have.length(0);
    // below min score
    expect(expansionCandidates([nodeIn("n1", "W1N0", EXPAND_MIN_SCORE - 1)], owned, facts)).to.have.length(0);
    // no controller in intel (highway room)
    facts.intel.W1N0 = { controllerPos: null };
    expect(expansionCandidates([nodeIn("n1", "W1N0", 100)], owned, facts)).to.have.length(0);
    // another player owns it
    facts.intel.W1N0 = { controllerPos: { x: 30, y: 30 }, controllerOwner: "Invader" };
    expect(expansionCandidates([nodeIn("n1", "W1N0", 100)], owned, facts)).to.have.length(0);
    // hostile-marked room
    facts.intel.W1N0 = { controllerPos: { x: 30, y: 30 }, controllerOwner: null };
    facts.hostileRooms = new Set(["W1N0"]);
    expect(expansionCandidates([nodeIn("n1", "W1N0", 100)], owned, facts)).to.have.length(0);
    // no spawn placement priced yet
    facts.hostileRooms = new Set();
    delete facts.placements.n1;
    expect(expansionCandidates([nodeIn("n1", "W1N0", 100)], owned, facts)).to.have.length(0);
  });

  it("never proposes a source-keeper room", () => {
    // W4N4: both coords %10 in 4..6 but not 5,5 - SK by geometry
    facts.placements.nsk = { x: 25, y: 25, roomName: "W4N4" };
    facts.intel.W4N4 = { controllerPos: { x: 30, y: 30 }, controllerOwner: null };
    expect(expansionCandidates([nodeIn("nsk", "W4N4", 200)], new Set(), facts)).to.have.length(0);
  });
});
