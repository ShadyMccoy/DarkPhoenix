/**
 * ReservationCorp ported onto the corp framework - proof ladder rungs 1-4
 * (docs/specs/00-corp-framework.md). Mirrors the scout port; the reservation-
 * specific proof is rung 3's runtime trigger: targetRooms gates work() and
 * getSpawnDemand() on "one of OUR miners is harvesting an unowned,
 * controllered room" - the spec's poster auxiliary trigger.
 */

import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { Position } from "../../../src/types/Position";
import { ColonyProblem } from "../../../src/economy/CorpPlanner";
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
import { reservationKind } from "../../../src/corps/kinds/reservationKind";
import { describeCorpKindConformance } from "./conformance";

const HOME = "W1N1";
const REMOTE = "W1N2";

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

function resetWorld(): void {
  installGlobals();
  Game.creeps = {};
  Game.rooms = {};
  Game.time = 12345;
  Game.getObjectById = () => null;
  (Memory as Record<string, unknown>).creeps = {};
}

/** Home spawn plus one of OUR miners harvesting an unowned remote room. */
function installMinedRemote(): void {
  const spawn = {
    id: "spawn1",
    pos: { x: 25, y: 25, roomName: HOME },
    owner: { username: "me" },
    room: { name: HOME, controller: { my: true, level: 3 } }
  };
  Game.getObjectById = (id: string) => (id === "spawn1" ? spawn : null);
  Game.creeps.miner1 = {
    name: "miner1",
    spawning: false,
    memory: { workType: "harvest", corpId: "harvest-x" },
    room: { name: REMOTE, controller: { my: false, owner: undefined, reservation: undefined } }
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
    expect(res[0].assignment).to.deep.equal({ roomName: HOME, spawnId: "spawn1" });
  });

  it("rung 3 - BIND: materialize keeps the LEGACY runtime corp id", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("reservation-W1N1")!.corp as ReservationCorp;
    expect(corp.id).to.equal("reservation-W1N1-reservation");
    expect(corp.getSpawnId()).to.equal("spawn1");
  });

  it("rung 3 - TRIGGER: demands a reserver only while a miner works an unowned room", () => {
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    const corp = store.get("reservation-W1N1")!.corp as ReservationCorp;
    const ctx = { energyCapacity: 1300 } as never;

    expect(corp.getSpawnDemand(ctx)).to.have.length(0); // no miner abroad yet

    installMinedRemote();
    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("reserver");
    expect(demands[0].producesIncome).to.equal(true);
    expect(demands[0].desiredCost).to.equal(1300); // 2x (CLAIM+MOVE) @ 650

    // an owned remote (someone else's room) must NOT be targeted
    (Game.creeps.miner1 as { room: { controller: { owner?: unknown } } }).room.controller.owner = {
      username: "enemy"
    };
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("rung 3 - EXECUTE/PERSIST: run() never throws; store round-trips with state", () => {
    installMinedRemote();
    const store: CorpStore = new Map();
    materializeCommissions(planCommissions(world).commissions, store);
    expect(() => runCommissionedCorps(store, Game.time)).to.not.throw();

    const corp = store.get("reservation-W1N1")!.corp as ReservationCorp;
    corp.recordProduction(7);
    const restored = deserializeStore(JSON.parse(JSON.stringify(serializeStore(store))));
    const back = restored.get("reservation-W1N1")!.corp as ReservationCorp;
    expect(back.id).to.equal(corp.id);
    expect(back.getSpawnId()).to.equal("spawn1");
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
      assignment: { roomName: HOME, spawnId: "spawn1" }
    },
    expectedSpawnPartsPerTick: 0
  });
});
