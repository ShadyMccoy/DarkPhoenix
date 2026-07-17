/**
 * ReservationCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). The reservation-specific proof is rung 2's
 * DRAFT-READING trigger: propose() derives target rooms from the draft plan's
 * remote harvest commissions - the durable "we mine this room" signal - exactly
 * as the propose() contract prescribes for auxiliaries. The trigger must NOT
 * read live creep positions or require room vision: the stranded-reserver
 * incident (shard1 t72378345) came from keying targets to "a miner is standing
 * there right now", which flaps on every miner death and goes blind with the
 * vision the dead miner was providing.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
import { Commission } from "../../../src/economy/Commission";
import {
  CorpStore,
  deserializeStore,
  materializeCommissions,
  registerCorpKind,
  resetCorpKinds,
  runCommissionedCorps,
  serializeStore
} from "../../../src/economy/CorpKind";
import { planCommissions } from "../../../src/economy/commissionPlan";
import { ReservationCorp } from "../../../src/corps/ReservationCorp";
import { reservationKind, ReservationAssignment } from "../../../src/corps/kinds/reservationKind";
import { describeCorpKindConformance } from "./conformance";

const HOME = "W1N1";
const REMOTE = "W1N2";
const TOO_FAR = "W1N9"; // linear distance 8 from HOME > MAX_SCOUT_DISTANCE (5)

function installGlobals(): void {
  setupGlobals();
  (Game as { map: unknown }).map = {
    getRoomTerrain: () => ({ get: () => 0 }),
    getRoomLinearDistance: () => 1
  };
  const g = global as unknown as Record<string, unknown>;
  g.CLAIM = "claim";
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

// hostileRooms() memoizes per Game.time - unique ticks per test, never replayed.
let tick = 60_000;

function resetWorld(): void {
  installGlobals();
  tick += 100;
  Game.creeps = {};
  Game.rooms = {};
  Game.time = tick;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
  (Memory as Record<string, unknown>).roomIntel = {};
}

/** Home spawn resolvable by id - no vision of anything else. */
function installHomeSpawn(): void {
  const spawn = {
    id: "spawn1",
    pos: { x: 25, y: 25, roomName: HOME },
    owner: { username: "me" },
    room: { name: HOME, controller: { my: true, level: 3 } }
  };
  Game.getObjectById = (id: string) => (id === "spawn1" ? spawn : null);
}

/** Scout intel: an unowned, controllered room unless overridden. */
function intel(roomName: string, over: Record<string, unknown> = {}): void {
  (Memory as Record<string, Record<string, unknown>>).roomIntel[roomName] = {
    lastVisit: tick - 10,
    sourceCount: 1,
    sourcePositions: [{ x: 10, y: 10 }],
    mineralType: null,
    mineralPos: null,
    controllerLevel: 0,
    controllerPos: { x: 5, y: 5 },
    controllerOwner: null,
    controllerReservation: null,
    hostileCreepCount: 0,
    hostileStructureCount: 0,
    isSafe: true,
    ...over
  };
}

/** A solver harvest commission for a source in `roomName` - the draft signal. */
function harvestDraft(sourceId: string, roomName: string): Commission {
  return {
    corpId: `harvest-${sourceId}`,
    kind: "harvest",
    shape: "produce",
    consumes: { spawnPartsPerTick: 0.1 },
    produces: { energyRate: 10, at: { x: 30, y: 30, roomName } },
    assignment: { sourceId }
  };
}

describe("reservation kind on the corp framework (rungs 2-4)", () => {
  beforeEach(() => {
    resetCorpKinds();
    resetWorld();
    registerCorpKind(reservationKind as never);
  });
  after(() => {
    resetCorpKinds();
    resetWorld();
  });

  it("rung 2 - PLAN: one reservation commission per spawn room", () => {
    const { commissions } = planCommissions(world);
    const res = commissions.filter(c => c.kind === "reservation");
    expect(res).to.have.length(1);
    expect(res[0].corpId).to.equal("reservation-W1N1");
    expect(res[0].shape).to.equal("auxiliary");
    // The solver mines only the HOME source here, so no remote targets yet.
    expect(res[0].assignment).to.deep.equal({ roomName: HOME, spawnId: "spawn1", targetRooms: [] });
  });

  it("rung 2 - TRIGGER: targets come from the draft plan's REMOTE harvest commissions", () => {
    const draft = [
      harvestDraft("srcHome", HOME), // mined, but it's a spawn room: excluded
      harvestDraft("srcRemote", REMOTE), // mined remote: targeted
      harvestDraft("srcFar", TOO_FAR) // mined but out of reserver range: excluded
    ];
    const res = reservationKind.propose(world, draft);
    expect(res).to.have.length(1);
    const a = res[0].assignment as ReservationAssignment;
    expect(a.targetRooms).to.deep.equal([REMOTE]);
  });

  it("rung 3 - BIND: materialize keeps the LEGACY runtime corp id and adopts the targets", () => {
    const draft = [harvestDraft("srcRemote", REMOTE)];
    const store: CorpStore = new Map();
    materializeCommissions([...draft, ...reservationKind.propose(world, draft)], store);
    const corp = store.get("reservation-W1N1")!.corp as ReservationCorp;
    expect(corp.id).to.equal("reservation-W1N1-reservation");
    expect(corp.getSpawnId()).to.equal("spawn1");
    expect(corp.getTargetRooms()).to.deep.equal([REMOTE]);
  });

  it("rung 3 - BIND: materialize refreshes targetRooms on an existing corp (stale-assignment regression)", () => {
    // A persisted corp outlives plan changes; targets are commission-owned
    // state like spawnId - every round's materialize must adopt the CURRENT
    // plan's rooms, or live corps keep chasing a mine the planner closed.
    const first = reservationKind.propose(world, [harvestDraft("srcRemote", REMOTE)])[0];
    const corp = reservationKind.materialize(first, undefined) as ReservationCorp;
    expect(corp.getTargetRooms()).to.deep.equal([REMOTE]);
    const second = reservationKind.propose(world, [])[0];
    const rebound = reservationKind.materialize(second, corp as never) as ReservationCorp;
    expect(rebound.getTargetRooms()).to.deep.equal([]);
  });

  it("rung 3 - TRIGGER: demands a reserver while the plan mines an unowned remote - no miner, no vision", () => {
    const draft = [harvestDraft("srcRemote", REMOTE)];
    const store: CorpStore = new Map();
    materializeCommissions([...draft, ...reservationKind.propose(world, draft)], store);
    const corp = store.get("reservation-W1N1")!.corp as ReservationCorp;
    const ctx = { energyCapacity: 1300 } as never;

    installHomeSpawn();
    intel(REMOTE); // scouted: unowned, controllered
    // Game.creeps is EMPTY (the remote's miner is dead) and Game.rooms has no
    // vision of REMOTE - the demand must hold anyway. This is the stranded-
    // reserver regression: the old creep-position trigger reported no targets
    // here, revoking in-flight reservers and flapping demand with every death.
    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("reserver");
    expect(demands[0].producesIncome).to.equal(true);
    expect(demands[0].desiredCost).to.equal(1300); // 2x (CLAIM+MOVE) @ 650

    // A rival takes the controller (seen by the next scout pass): demand stops.
    intel(REMOTE, { controllerOwner: "enemy" });
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("rung 3 - EXECUTE/PERSIST: run() never throws; store round-trips with state", () => {
    installHomeSpawn();
    intel(REMOTE);
    const draft = [harvestDraft("srcRemote", REMOTE)];
    const store: CorpStore = new Map();
    materializeCommissions([...draft, ...reservationKind.propose(world, draft)], store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const corp = store.get("reservation-W1N1")!.corp as ReservationCorp;
    corp.recordProduction(7);
    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("reservation-W1N1")!.corp as ReservationCorp;
    expect(back.id).to.equal(corp.id);
    expect(back.getSpawnId()).to.equal("spawn1");
    expect(back.getTargetRooms()).to.deep.equal([REMOTE]);
    expect(back.unitsProduced).to.equal(7);
  });

  it("rung 4 - COMPOSE: coexists with the scout kind over the same world", async () => {
    const { scoutKind } = await import("../../../src/corps/kinds/scoutKind");
    registerCorpKind(scoutKind as never);
    const { commissions } = planCommissions(world);
    const aux = commissions.filter(c => c.shape === "auxiliary").map(c => c.corpId);
    expect(aux.sort()).to.deep.equal(["reservation-W1N1", "scout-W1N1"]);
  });
});

describe("reservation kind rung 1", () => {
  beforeEach(resetWorld);
  describeCorpKindConformance(reservationKind as never, {
    problem: world,
    commission: {
      corpId: "reservation-W1N1",
      kind: "reservation",
      shape: "auxiliary",
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName: HOME, spawnId: "spawn1", targetRooms: [REMOTE] }
    },
    expectedSpawnPartsPerTick: 0
  });
});
