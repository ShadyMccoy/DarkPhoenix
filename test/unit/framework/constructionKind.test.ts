/**
 * ConstructionCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). The HYBRID kind: it proposes one commission
 * per owned room (always, for container maintenance) but reads the solver's
 * "build" commissions from the DRAFT to carry that room's construction-energy
 * allocations (which size its builders). These tests pin both the per-room
 * existence and the draft-reading allocation aggregation.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem, DEFAULT_SINK_VALUE } from "../../../src/economy/CorpPlanner";
import { Commission } from "../../../src/economy/Commission";
import { ConsumeAssignment } from "../../../src/economy/commissionPlan";
import {
  CorpStore,
  deserializeStore,
  materializeCommissions,
  registerCorpKind,
  resetCorpKinds,
  runCommissionedCorps,
  serializeStore
} from "../../../src/economy/CorpKind";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";
import { constructionKind, ConstructionAssignment } from "../../../src/corps/kinds/constructionKind";
import { describeCorpKindConformance } from "./conformance";
import { resetGovernor } from "../../../src/execution/CpuGovernor";

const ROOM = "W1N1";

function installGlobals(): void {
  setupGlobals();
  (Game as { map: unknown }).map = { getRoomTerrain: () => ({ get: () => 0 }) };
  const g = global as unknown as Record<string, unknown>;
  g.WORK = "work";
  g.CARRY = "carry";
  g.MOVE = "move";
  g.FIND_MY_CONSTRUCTION_SITES = 114;
  g.FIND_STRUCTURES = 107;
  g.STRUCTURE_CONTAINER = "container";
}
installGlobals();

const at = (x: number, y = 25): Position => ({ x, y, roomName: ROOM });

const world: ColonyProblem = {
  spawns: [{ id: "spawn1", pos: { x: 25, y: 25, roomName: ROOM } }],
  sources: [{ id: "srcA", nodeId: "node-A", pos: at(20), rate: 10, maxMiners: 1 }],
  sinks: [
    { id: "sink-spawn", kind: "spawn", pos: at(0), value: DEFAULT_SINK_VALUE.spawn, capacity: 4 },
    { id: "sink-build", kind: "construction", pos: at(30), value: DEFAULT_SINK_VALUE.construction, capacity: 5 }
  ],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

/** A solver "build" commission, as commissionsFromPlan emits for a construction sink. */
const buildCommission = (sinkId: string, allocated: number): Commission => ({
  corpId: `build-${sinkId}`,
  kind: "build",
  shape: "consume",
  consumes: { energyRate: allocated, at: at(30), spawnPartsPerTick: 0 },
  produces: { valuePerTick: allocated * DEFAULT_SINK_VALUE.construction, at: at(30) },
  assignment: {
    sink: { sinkId, kind: "construction", value: DEFAULT_SINK_VALUE.construction, demand: 5, allocated, sources: [] },
    spawnId: "spawn-game1"
  } as ConsumeAssignment
});

const constructionCommission = {
  corpId: "construction-W1N1",
  kind: "construction",
  shape: "consume" as const,
  consumes: { energyRate: 5, spawnPartsPerTick: 0 },
  produces: { valuePerTick: 0 },
  assignment: {
    roomName: ROOM,
    spawnId: "spawn1",
    allocations: [
      { sinkId: "sink-build", sinkType: "construction", allocated: 5, demand: 5, unmet: 0, priority: 50, sourceFlows: [] }
    ]
  } as ConstructionAssignment
};

function resetWorld(): void {
  installGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.time = 12345;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
}

describe("construction kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(constructionKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: one commission per spawn room, even with NO build work (maintenance)", () => {
    const out = constructionKind.propose(world, []);
    expect(out).to.have.length(1);
    expect(out[0].corpId).to.equal("construction-W1N1");
    expect((out[0].assignment as ConstructionAssignment).allocations).to.deep.equal([]);
  });

  it("rung 2 - PLAN: reads the draft's build commissions to carry the room's allocations", () => {
    const draft = [buildCommission("sink-build", 4), buildCommission("sink-build-2", 1)];
    const out = constructionKind.propose(world, draft);
    expect(out).to.have.length(1);
    const a = out[0].assignment as ConstructionAssignment;
    expect(a.allocations).to.have.length(2);
    expect(a.allocations.map(x => x.allocated).sort()).to.deep.equal([1, 4]);
    expect(a.allocations.every(x => x.sinkType === "construction")).to.equal(true);
    expect(out[0].consumes.energyRate).to.equal(5); // summed
  });

  it("rung 2 - PLAN: threads REMOTE trunk candidates from the draft's harvest commissions (owner: routes are site strings, not rooms)", () => {
    // The corp paves what the plan MINES: funded remote sources become trunk
    // candidates (sourceId, pos, flow) on the home corp's assignment. Home
    // sources are excluded - the in-room scan already covers them.
    const draft = [
      {
        corpId: "harvest-src-home",
        kind: "harvest",
        shape: "produce",
        consumes: { spawnPartsPerTick: 0.1 },
        produces: { energyRate: 10, at: { x: 20, y: 20, roomName: "W1N1" } },
        assignment: { sourceId: "src-home", rate: 10, distance: 12 }
      },
      {
        corpId: "harvest-src-remote",
        kind: "harvest",
        shape: "produce",
        consumes: { spawnPartsPerTick: 0.1 },
        produces: { energyRate: 10, at: { x: 30, y: 15, roomName: "W2N1" } },
        assignment: { sourceId: "src-remote", rate: 10, distance: 55 }
      }
    ] as never[];
    const out = constructionKind.propose(world, draft);
    const a = out[0].assignment as ConstructionAssignment & {
      remoteTrunks?: { sourceId: string; pos: { x: number; y: number; roomName: string }; flow: number }[];
    };
    expect(a.remoteTrunks, "remote harvest -> trunk candidate").to.have.length(1);
    expect(a.remoteTrunks![0].sourceId).to.equal("src-remote");
    expect(a.remoteTrunks![0].pos.roomName).to.equal("W2N1");
    expect(a.remoteTrunks![0].flow).to.equal(10);
  });

  it("rung 3 - BIND: materialize sets the allocations and preserves the legacy id", () => {
    const store: CorpStore = new Map();
    materializeCommissions([constructionCommission], store);
    const corp = store.get("construction-W1N1")!.corp as ConstructionCorp;
    expect(corp.id).to.equal("building-W1N1-construction");
    expect(corp.getSpawnId()).to.equal("spawn1");
    expect(corp.getTotalAllocatedEnergy()).to.equal(5); // drives builder sizing
  });

  it("rung 3 - BIND: re-materialize updates the SAME instance's allocations", () => {
    const store: CorpStore = new Map();
    materializeCommissions([constructionCommission], store);
    const first = store.get("construction-W1N1")!.corp;
    const updated = {
      ...constructionCommission,
      assignment: { ...constructionCommission.assignment, allocations: [] }
    };
    materializeCommissions([updated], store);
    const second = store.get("construction-W1N1")!.corp as ConstructionCorp;
    expect(second).to.equal(first);
    expect(second.getTotalAllocatedEnergy()).to.equal(0);
  });

  it("rung 3 - EXECUTE: a cross-room corp with NO vision marches members toward the work room", () => {
    // Live incident 2026-07-19: four remote-room builders idled at the home
    // spawn for ~600t. Demand saw the remote sites (intel/vision at order
    // time); work() gated on vision EVERY tick and an idle member at the home
    // spawn provides none - a deadlock only the member's own travel can break.
    const store: CorpStore = new Map();
    const remote = {
      ...constructionCommission,
      corpId: "construction-W9N9",
      assignment: { ...constructionCommission.assignment, roomName: "W9N9", allocations: [] }
    };
    materializeCommissions([remote], store);
    const spawnStub = { id: "spawn1", room: { name: ROOM }, pos: { x: 25, y: 25, roomName: ROOM } };
    Game.getObjectById = (() => spawnStub) as never;
    Game.rooms = {}; // no vision anywhere - especially not W9N9
    const moves: unknown[][] = [];
    (Game.creeps as Record<string, unknown>).mb1 = {
      name: "mb1",
      spawning: false,
      memory: { corpId: "building-W9N9-construction", workType: "build" },
      pos: { x: 26, y: 25, roomName: ROOM, isEqualTo: () => false, isNearTo: () => false, getRangeTo: () => 99, inRangeTo: () => false },
      store: { getFreeCapacity: () => 50, getUsedCapacity: () => 0, energy: 0 },
      moveTo: (...a: unknown[]) => { moves.push(a); return 0; },
      move: (...a: unknown[]) => { moves.push(a); return 0; },
      say: () => 0
    };
    runCommissionedCorps(store, Game.time);
    expect(moves.length, "vision-less member must be ORDERED to travel, not left idle").to.be.greaterThan(0);
    expect(JSON.stringify(moves[0])).to.contain("W9N9"); // marched at the work room
  });

  it("rung 3 - EXECUTE/PERSIST: run() never throws with no vision; store round-trips allocations", () => {
    const store: CorpStore = new Map();
    materializeCommissions([constructionCommission], store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("construction-W1N1")!.corp as ConstructionCorp;
    expect(back.id).to.equal("building-W1N1-construction");
    expect(back.getTotalAllocatedEnergy()).to.equal(5);
  });
});

describe("construction kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(constructionKind as never, {
    problem: world,
    commission: constructionCommission,
    expectedSpawnPartsPerTick: 0
  });
});

describe("cross-room trunk helpers (owner 2026-07-19: sites wherever they lead)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    resetGovernor(); // module-level governor state leaks across test files
  });

  const mkRoom = (roads: Set<string>): any => ({
    lookForAt: (_l: number, x: number, y: number) =>
      roads.has(`${x},${y}`) ? [{ structureType: "road" }] : [],
    createConstructionSite: () => 0
  });

  it("places trunk sites ONLY in rooms with vision (blind stretches wait for walkers)", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    (global as any).LOOK_STRUCTURES = "structure";
    (global as any).LOOK_CONSTRUCTION_SITES = "constructionSite";
    (global as any).STRUCTURE_ROAD = "road";
    Game.rooms = { W1N1: mkRoom(new Set()) } as any; // W2N1 blind
    const placed = (corp as any).placeTrunkSites(["W1N1", "W2N1"], [5, 5, 0, 6, 5, 0, 10, 10, 1, 11, 10, 1]);
    expect(placed, "two visible-room tiles placed; two blind-room tiles skipped").to.equal(2);
  });

  it("never declares a trunk paved while any room is blind (unverifiable != built)", () => {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    (global as any).LOOK_STRUCTURES = "structure";
    (global as any).STRUCTURE_ROAD = "road";
    Game.rooms = { W1N1: mkRoom(new Set(["5,5"])) } as any; // W2N1 blind
    expect((corp as any).trunkBuilt(["W1N1", "W2N1"], [5, 5, 0, 10, 10, 1])).to.equal(false);
    Game.rooms = { W1N1: mkRoom(new Set(["5,5"])), W2N1: mkRoom(new Set(["10,10"])) } as any;
    expect((corp as any).trunkBuilt(["W1N1", "W2N1"], [5, 5, 0, 10, 10, 1])).to.equal(true);
  });
});
