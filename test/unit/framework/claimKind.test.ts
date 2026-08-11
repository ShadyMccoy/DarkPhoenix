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
import { Game, Memory, setupGlobals } from "../mock";
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

describe("claimKind propose (campaign-gated, pure)", () => {
  it("proposes nothing while no expansion campaign is live", () => {
    expect(claimKind.propose(world, [])).to.deep.equal([]);
  });

  it("commissions ONE claim corp for the campaign target, bound to the nearest colony spawn", () => {
    // The campaign fact arrives ON THE PROBLEM (host-assembled, spec 17 P3).
    const proposals = claimKind.propose({ ...world, expansion: { roomName: "W3N3" } }, []);
    expect(proposals).to.have.length(1);
    expect(proposals[0].corpId).to.equal("claim-W3N3");
    expect((proposals[0].assignment as { spawnId: string }).spawnId).to.equal("spawn1");
  });
});

const TARGET = "W3N3";

/** Campaign live, target unclaimed, home spawn resolvable - the demand world. */
function stageClaimWorld(): void {
  setupGlobals();
  Game.creeps = {};
  Game.rooms = {}; // target invisible: `Game.rooms[target]?.controller?.my` stays falsy
  Game.time = 34567;
  (Memory as Record<string, unknown>).creeps = {};
  (Memory as Record<string, unknown>).expansion = { roomName: TARGET };
  const spawn: Record<string, unknown> = {
    id: "spawn1",
    pos: { x: 5, y: 0, roomName: ROOM },
    owner: { username: "me" }
  };
  spawn.room = { name: ROOM, find: () => [] };
  Game.getObjectById = ((id: string) => (id === "spawn1" ? spawn : null)) as never;
}

// Rung 1: the standard conformance suite, with the campaign live on the
// problem so propose() has something to do.
describeCorpKindConformance(claimKind as CorpKind, {
  problem: { ...world, expansion: { roomName: "W3N3" } },
  commission,
  expectedSpawnPartsPerTick: 0,
  // Staffing world (specs 60 D + 61 rows 1-3): campaign live and unclaimed
  // (so a claimer-less corp WOULD demand), one claimer already bought. The
  // corp fields exactly ONE claimer per campaign, so no further demand is
  // correct in every lifecycle state - the count must include spawning
  // newborns and recycling incumbents alike.
  staffing: {
    role: "claimer",
    stage(state) {
      stageClaimWorld();
      const corp = claimKind.materialize(commission, undefined);
      Game.creeps.claimer1 = {
        name: "claimer1",
        spawning: state === "spawning",
        ticksToLive: state === "spawning" ? undefined : 580,
        room: { name: TARGET, controller: { my: false, pos: { x: 25, y: 25, roomName: TARGET } } },
        pos: { x: 20, y: 20, roomName: TARGET, isNearTo: () => false },
        moveTo: () => 0,
        claimController: () => 0,
        reserveController: () => 0,
        memory: {
          corpId: corp.id,
          workType: "claim",
          ...(state === "recycling" ? { recycling: true } : {})
        }
      } as never;
      return corp;
    }
  }
});

// The campaign key is file-global state on the shared Memory mock: clear it so
// a later suite in the same mocha process never inherits a live campaign.
after(() => {
  delete (Memory as Record<string, unknown>).expansion;
});
