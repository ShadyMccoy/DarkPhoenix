/**
 * RaidGuardCorp on the corp framework (spec 13 phase 3) - conformance plus
 * the rungs that matter for a self-proposing auxiliary: one commission per
 * spawn room, legacy-shaped runtime id, spawnId refresh, store round-trip.
 */

import "../../../src/types/Memory";
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
import {
  CorpStore,
  materializeCommissions,
  registerCorpKind,
  resetCorpKinds,
  runCommissionedCorps
} from "../../../src/economy/CorpKind";
import { planCommissions } from "../../../src/economy/commissionPlan";
import { RaidGuardCorp } from "../../../src/corps/RaidGuardCorp";
import { raidGuardKind } from "../../../src/corps/kinds/raidGuardKind";
import { describeCorpKindConformance } from "./conformance";

const HOME = "W1N1";

function installGlobals(): void {
  setupGlobals();
  (Game as { map: unknown }).map = {
    getRoomTerrain: () => ({ get: () => 0 }),
    getRoomLinearDistance: () => 1
  };
  const g = global as unknown as Record<string, unknown>;
  g.ATTACK = "attack";
  g.MOVE = "move";
}
installGlobals();

const at = (x: number, y = 0): Position => ({ x, y, roomName: HOME });
const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: { x: 25, y: 25, roomName: HOME } }],
  sources: [{ id: "src1", nodeId: "n1", pos: at(10), rate: 10, maxMiners: 1 }],
  sinks: [{ id: "ctrl", kind: "controller", pos: at(5), value: 50, capacity: 1000 }],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

function resetWorld(): void {
  installGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.time = 12345;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
  (Memory as Record<string, unknown>).roomIntel = {};
}

describeCorpKindConformance(raidGuardKind as never, {
  problem: world,
  commission: raidGuardKind.propose(world, [])[0],
  expectedSpawnPartsPerTick: 0 // auxiliary: off the planner's build-time budget
});

describe("raidGuard kind on the corp framework", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(raidGuardKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("PLAN: one raidGuard commission per spawn room, auxiliary and off-budget", () => {
    const { commissions } = planCommissions(world);
    const guards = commissions.filter(c => c.kind === "raidGuard");
    expect(guards).to.have.length(1);
    expect(guards[0].corpId).to.equal("raidGuard-W1N1");
    expect(guards[0].shape).to.equal("auxiliary");
    expect(guards[0].consumes.spawnPartsPerTick).to.equal(0);
    expect(guards[0].assignment).to.deep.equal({ roomName: HOME, spawnId: "spawn1" });
  });

  it("BIND: materialize binds the corp and a re-materialize refreshes the spawn id", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("raidGuard-W1N1")!.corp as RaidGuardCorp;
    expect(corp.getSpawnId()).to.equal("spawn1");

    // The stale-spawnId trap: a persisted corp must follow the commission's
    // CURRENT spawn (the conformance suite also enforces this mechanically).
    const moved = planCommissions(world).commissions.map(c =>
      c.kind === "raidGuard" ? { ...c, assignment: { roomName: HOME, spawnId: "spawn2" } } : c
    );
    materializeCommissions(moved, store);
    expect((store.get("raidGuard-W1N1")!.corp as RaidGuardCorp).getSpawnId()).to.equal("spawn2");
  });

  it("EXECUTE: run() never throws on an empty world or with intel present", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    (Memory as Record<string, unknown>).roomIntel = { W1N2: { lastVisit: 1, raidDebt: 70_000 } };
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();
  });
});
