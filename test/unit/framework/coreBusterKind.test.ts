/**
 * CoreBusterCorp on the corp framework (spec 13 phase 4) - conformance plus
 * the auxiliary rungs: one commission per spawn room, spawnId refresh,
 * run() safety with and without occupation intel.
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
import { CoreBusterCorp } from "../../../src/corps/CoreBusterCorp";
import { coreBusterKind } from "../../../src/corps/kinds/coreBusterKind";
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
  g.CLAIM = "claim";
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

const conformanceCommission = coreBusterKind.propose(world, [])[0];

describeCorpKindConformance(coreBusterKind as never, {
  problem: world,
  commission: conformanceCommission,
  expectedSpawnPartsPerTick: 0, // auxiliary: off the planner's build-time budget
  // Staffing world (specs 60 D + 61 rows 1-3): home spawn resolvable, ONE
  // occupied + sourced + core-sighted remote (so an unstaffed corp WOULD
  // demand a buster), and one buster incumbent staged exactly as executeSpawn
  // stamps a newborn - corpId + workType only, NO targetRoom (runFleet
  // assigns that, and only to non-spawning creeps). One body in any lifecycle
  // state covers the one kill target, so no further demand is correct in
  // every state - the same t72811290 double-buy class as the raid guard.
  staffing: {
    role: "buster",
    stage(state) {
      resetWorld();
      Game.getObjectById = ((id: string) =>
        id === "spawn1"
          ? {
              id: "spawn1",
              pos: { x: 25, y: 25, roomName: HOME },
              owner: { username: "me" },
              room: { name: HOME, controller: { my: true, level: 3 } }
            }
          : null) as never;
      (Memory as Record<string, unknown>).roomIntel = {
        W1N2: { lastVisit: 1, sourceCount: 1, invaderReservedUntil: Game.time + 5000, invaderCorePresent: true }
      };
      const corp = coreBusterKind.materialize(conformanceCommission, undefined);
      Game.creeps.b1 = {
        name: "b1",
        spawning: state === "spawning",
        ticksToLive: state === "spawning" ? undefined : 1400,
        room: { name: HOME },
        pos: { x: 20, y: 20, roomName: HOME },
        moveTo: () => 0,
        attack: () => 0,
        memory: {
          corpId: corp.id,
          workType: "buster",
          ...(state === "recycling" ? { recycling: true } : {})
        }
      } as never;
      return corp;
    }
  }
});

describe("coreBuster kind on the corp framework", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(coreBusterKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("PLAN: one coreBuster commission per spawn room, auxiliary and off-budget", () => {
    const { commissions } = planCommissions(world);
    const busters = commissions.filter(c => c.kind === "coreBuster");
    expect(busters).to.have.length(1);
    expect(busters[0].corpId).to.equal("coreBuster-W1N1");
    expect(busters[0].shape).to.equal("auxiliary");
    expect(busters[0].consumes.spawnPartsPerTick).to.equal(0);
  });

  it("BIND: a re-materialize refreshes the spawn id (stale-spawnId trap)", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const moved = planCommissions(world).commissions.map(c =>
      c.kind === "coreBuster" ? { ...c, assignment: { roomName: HOME, spawnId: "spawn2" } } : c
    );
    materializeCommissions(moved, store);
    expect((store.get("coreBuster-W1N1")!.corp as CoreBusterCorp).getSpawnId()).to.equal("spawn2");
  });

  it("EXECUTE: run() never throws, with or without occupation intel", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    (Memory as Record<string, unknown>).roomIntel = {
      W1N2: { lastVisit: 1, sourceCount: 1, invaderReservedUntil: Game.time + 5000, invaderCorePresent: true }
    };
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();
  });
});
