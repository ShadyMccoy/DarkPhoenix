/**
 * claimKind conformance (spec 17 P4): claim was the ONE registered kind with
 * zero conformance coverage - found by the ontology audit, together with the
 * matching OrphanRescue gap (workType "claim" missing from the rescue map, so
 * orphaned claimers were always recycled). The rescue side is pinned in
 * test/unit/execution/orphanAction.test.ts; this file enrolls the kind in the
 * standard rung-1 suite and pins its campaign-gated propose().
 */

import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals } from "../mock";
import { Commission } from "../../../src/economy/Commission";
import { CorpKind } from "../../../src/economy/CorpKind";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";
import { claimKind } from "../../../src/corps/kinds/claimKind";
import { describeCorpKindConformance } from "./conformance";

setupGlobals();

const ROOM = "W2N2";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: at(5) }],
  sources: [],
  sinks: [],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

const commission: Commission = {
  corpId: "claim-W3N3",
  kind: "claim",
  shape: "auxiliary",
  consumes: { spawnPartsPerTick: 0 },
  produces: { valuePerTick: 0 },
  assignment: { roomName: "W3N3", spawnId: "spawn1" }
};

describe("claimKind propose (campaign-gated)", () => {
  afterEach(() => {
    delete (Memory as { expansion?: unknown }).expansion;
  });

  it("proposes nothing while no expansion campaign is live", () => {
    delete (Memory as { expansion?: unknown }).expansion;
    expect(claimKind.propose(world, [])).to.deep.equal([]);
  });

  it("commissions ONE claim corp for the campaign target, bound to a colony spawn", () => {
    (Memory as { expansion?: { roomName: string } }).expansion = { roomName: "W3N3" };
    const proposals = claimKind.propose(world, []);
    expect(proposals).to.have.length(1);
    expect(proposals[0].corpId).to.equal("claim-W3N3");
    expect((proposals[0].assignment as { spawnId: string }).spawnId).to.equal("spawn1");
  });
});

// Rung 1: the standard conformance suite, with the campaign live so propose()
// has something to do (the harness requires a working fixture world).
describe("claimKind conformance harness setup", () => {
  before(() => {
    (Memory as { expansion?: { roomName: string } }).expansion = { roomName: "W3N3" };
  });
  after(() => {
    delete (Memory as { expansion?: unknown }).expansion;
  });

  describeCorpKindConformance(claimKind as CorpKind, {
    problem: world,
    commission,
    expectedSpawnPartsPerTick: 0
  });
});
