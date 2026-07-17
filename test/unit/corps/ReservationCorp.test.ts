/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { Game as MockGame, Memory as MockMemory, setupGlobals } from "../mock";
import { buildReserverBody } from "../../../src/spawn/BodyBuilder";
import { ReservationCorp } from "../../../src/corps/ReservationCorp";

setupGlobals();

/**
 * Reservation is the one genuinely room-specific part of remote mining: holding a
 * remote controller lifts its sources from 1500 back to the full 3000. These
 * scenarios pin down (a) the reserver body math and (b) the corp's targeting:
 * targets are the PLAN's remote mining rooms (commission-owned, set via
 * setTargetRooms), gated by the vision-free reservability lens (scout intel) -
 * NEVER by where miner creeps happen to be standing. The stranded-reserver
 * incident (shard1 t72378345): the old creep-position trigger revoked an
 * in-flight reserver's target the tick its remote's miner died, because the dead
 * miner took both the trigger AND the room's vision with it. The creep idled out
 * its remaining ~250 ticks of CLAIM lifetime mid-route while the room's
 * reservation decayed.
 */

describe("buildReserverBody", () => {
  it("builds nothing when a CLAIM (600) is unaffordable", () => {
    expect(buildReserverBody(300).body).to.have.length(0);
    expect(buildReserverBody(300).cost).to.equal(0);
  });

  it("builds one CLAIM+MOVE pair at low-but-sufficient capacity", () => {
    const r = buildReserverBody(650);
    expect(r.claimParts).to.equal(1);
    expect(r.body).to.deep.equal([CLAIM, MOVE]);
    expect(r.cost).to.equal(650);
  });

  it("scales to maxClaim and no further", () => {
    expect(buildReserverBody(2000, 2).claimParts).to.equal(2); // capped at maxClaim
    expect(buildReserverBody(2000, 2).body).to.deep.equal([CLAIM, CLAIM, MOVE, MOVE]);
    expect(buildReserverBody(900, 2).claimParts).to.equal(1); // only one pair affordable
  });
});

// hostileRooms() memoizes per Game.time - every test gets a fresh tick so one
// test's danger set never replays into the next.
let tick = 50_000;

/**
 * Stub Game/Memory: a home spawn and NOTHING else - no vision of any remote
 * (Game.rooms empty) and, unless the test adds them, no creeps. This is the
 * incident's shape: targeting must work from intel alone.
 */
function setWorld(creeps: Record<string, unknown> = {}): void {
  tick += 100;
  const spawn = { id: "spawn1", room: { name: "W0N0" }, owner: { username: "me" } };
  (global as any).Game = {
    ...MockGame,
    creeps,
    rooms: {},
    time: tick,
    getObjectById: (id: string) => (id === "spawn1" ? spawn : null)
  };
  (global as any).Memory = { creeps: {}, roomIntel: {} };
}

/** Scout intel for a room: unowned + controllered unless overridden. */
function intel(roomName: string, over: Record<string, unknown> = {}): void {
  (Memory as any).roomIntel[roomName] = {
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

/** A corp whose commission planned these remote mining rooms. */
function corp(targets: string[]): ReservationCorp {
  const c = new ReservationCorp("W0N0-reservation", "spawn1");
  c.setTargetRooms(targets);
  return c;
}

const ctx = { energyCapacity: 800, tick: 100 } as any;

describe("ReservationCorp demand (reserve rooms the PLAN mines - no vision, no miners needed)", () => {
  afterEach(() => {
    (global as any).Game = { ...MockGame, creeps: {}, time: tick };
    (global as any).Memory = MockMemory;
  });

  it("requests a reserver for a planned remote with NO vision and NO miner alive (stranding regression)", () => {
    setWorld({}); // zero creeps: the remote's miner is dead, its replacement unspawned
    intel("W1N0");
    const demand = corp(["W1N0"]).getSpawnDemand(ctx);
    expect(demand).to.have.length(1);
    expect(demand[0]).to.include({ role: "reserver", producesIncome: true });
  });

  it("does not reserve rooms intel says are owned or reserved by others", () => {
    setWorld();
    intel("W2N0", { controllerOwner: "rival" });
    intel("W3N0", { controllerReservation: "rival" });
    expect(corp(["W2N0", "W3N0"]).getSpawnDemand(ctx)).to.have.length(0);
  });

  it("keeps reserving a room WE already hold - the reservation decays without a reserver", () => {
    setWorld();
    intel("W1N0", { controllerReservation: "me" });
    expect(corp(["W1N0"]).getSpawnDemand(ctx)).to.have.length(1);
  });

  it("does not reserve a controller-less room", () => {
    setWorld();
    intel("W5N5", { controllerPos: null });
    expect(corp(["W5N5"]).getSpawnDemand(ctx)).to.have.length(0);
  });

  it("stops requesting once a reserver already covers the room", () => {
    const c = corp(["W1N0"]);
    setWorld({
      r1: { memory: { corpId: c.id, workType: "reserve", targetRoom: "W1N0" }, spawning: false }
    });
    intel("W1N0");
    expect(c.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("asks for nothing when the plan mines no remote", () => {
    setWorld();
    expect(corp([]).getSpawnDemand(ctx)).to.have.length(0);
  });

  it("does not fund a reserver for a hostile-marked room (defense defund, vision-free)", () => {
    setWorld();
    intel("W1N0", { hostileUntil: tick + 200 });
    expect(corp(["W1N0"]).getSpawnDemand(ctx)).to.have.length(0);
  });
});

describe("ReservationCorp work (assignments survive miner death and vision loss)", () => {
  afterEach(() => {
    (global as any).Game = { ...MockGame, creeps: {}, time: tick };
    (global as any).Memory = MockMemory;
  });

  /** A reserver creep mid-route in some hallway room, recording its moves. */
  function reserverCreep(c: ReservationCorp, targetRoom?: string): any {
    const moves: any[] = [];
    return {
      name: "r1",
      spawning: false,
      memory: { corpId: c.id, workType: "reserve", targetRoom },
      room: { name: "W0N5" },
      pos: { x: 25, y: 25, roomName: "W0N5", isNearTo: () => false, isEqualTo: () => false },
      moveTo: (...args: any[]) => {
        moves.push(args);
        return 0;
      },
      move: () => 0,
      moves
    };
  }

  it("assigns a planned room to an idle reserver without any vision or miners", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0");
    const creep = reserverCreep(c);
    Game.creeps.r1 = creep;
    c.work(tick);
    expect(creep.memory.targetRoom).to.equal("W1N0");
    expect(creep.moves, "the reserver travels toward its target").to.have.length.greaterThan(0);
    expect(creep.moves[0][0].roomName).to.equal("W1N0");
  });

  it("keeps an in-flight assignment when the remote's miner dies (the stranding bug)", () => {
    const c = corp(["W1N0"]);
    setWorld(); // NO miners anywhere, NO vision of W1N0
    intel("W1N0");
    const creep = reserverCreep(c, "W1N0");
    Game.creeps.r1 = creep;
    c.work(tick);
    expect(creep.memory.targetRoom, "target must not flap with creep deaths").to.equal("W1N0");
    expect(creep.moves).to.have.length.greaterThan(0);
  });

  it("revokes the assignment when the room leaves the plan", () => {
    const c = corp([]);
    setWorld();
    const creep = reserverCreep(c, "W1N0");
    Game.creeps.r1 = creep;
    c.work(tick);
    expect(creep.memory.targetRoom).to.equal(undefined);
    expect(creep.moves).to.have.length(0);
  });

  it("revokes the assignment when intel says another player took the controller", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0", { controllerOwner: "rival" });
    const creep = reserverCreep(c, "W1N0");
    Game.creeps.r1 = creep;
    c.work(tick);
    expect(creep.memory.targetRoom).to.equal(undefined);
  });

  it("reserves the controller once in the target room", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0");
    const controller = { id: "ctrl1" };
    const reserved: any[] = [];
    const creep = reserverCreep(c, "W1N0");
    creep.room = { name: "W1N0", controller };
    creep.pos.isNearTo = () => true;
    creep.reserveController = (t: any) => {
      reserved.push(t);
      return 0;
    };
    Game.creeps.r1 = creep;
    c.work(tick);
    expect(reserved).to.deep.equal([controller]);
  });
});
