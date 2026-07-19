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

/**
 * The reserver purchase loop (live incident, shard1 t72401489-72401575: four
 * 1300-energy reservers in ~90 ticks, ~53% of spawn build-time). The demand
 * lens was newborn-blind twice over: getActiveCreeps excludes `spawning` (a
 * 24-tick build) and `covered` required memory.targetRoom, assigned only after
 * birth - so the banked mustFund demand re-fired during every build. The
 * staffsPost-symmetry trap, verbatim. The demand lens must count every LIVING
 * corp reserver - spawning and unassigned included - mirroring work()'s
 * invariant that every living reserver ends up covering one target.
 */
describe("ReservationCorp demand counts newborns (purchase-loop regression)", () => {
  it("a SPAWNING newborn already counts toward coverage - no re-demand during its build", () => {
    const c = corp(["W1N0"]);
    setWorld({
      newborn: { memory: { corpId: c.id, workType: "reserve" }, spawning: true }
    });
    intel("W1N0");
    expect(c.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("an active-but-unassigned newborn counts too (work() has not run yet)", () => {
    const c = corp(["W1N0"]);
    setWorld({
      newborn: { memory: { corpId: c.id, workType: "reserve" }, spawning: false }
    });
    intel("W1N0");
    expect(c.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("coverage is by COUNT: one newborn against two planned rooms still demands the second", () => {
    const c = corp(["W1N0", "W2N1"]);
    setWorld({
      newborn: { memory: { corpId: c.id, workType: "reserve" }, spawning: true }
    });
    intel("W1N0");
    intel("W2N1");
    expect(c.getSpawnDemand(ctx)).to.have.length(1);
  });

  it("stamps its sizing record so the loop's absence is verifiable from telemetry", () => {
    const c = corp(["W1N0"]);
    setWorld({
      newborn: { memory: { corpId: c.id, workType: "reserve" }, spawning: true }
    });
    intel("W1N0");
    c.getSpawnDemand(ctx);
    expect(c.lastSizing).to.deep.include({ gate: "staffed", targets: 1, staffed: 1 });
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

  it("holds its post when the room leaves the plan (one-way mission, owner 2026-07-19)", () => {
    // Retargeting a fielded reserver burns walk-ticks off a <=600t CLAIM life
    // and the abandoned post buys a relief - the measured churn. A plan-drop
    // is often a flap (P1 watches funded flips); the bank it keeps pumping
    // holds 5000t. One-way: assignment survives EVERYTHING for the creep's
    // remaining life.
    const c = corp([]);
    setWorld();
    const creep = reserverCreep(c, "W1N0");
    Game.creeps.r1 = creep;
    c.work(tick);
    expect(creep.memory.targetRoom, "one-way: plan moves never revoke").to.equal("W1N0");
    expect(creep.moves, "still marching at its post").to.have.length.greaterThan(0);
  });

  it("holds its post even when intel says a rival took it (loss bounded by CLAIM life)", () => {
    const c = corp(["W1N0", "W2N0"]);
    setWorld();
    intel("W1N0", { controllerOwner: "rival" });
    intel("W2N0");
    const creep = reserverCreep(c, "W1N0");
    Game.creeps.r1 = creep;
    c.work(tick);
    expect(creep.memory.targetRoom, "one-way: never walks off to another post").to.equal("W1N0");
  });

  it("never steals a duplicate to another room (the relief-churn incident, owner 2026-07-19)", () => {
    // Two reservers latched to the same room (restart artifact): the old code
    // re-spread the second to the next target mid-life - it walked off, the
    // room read uncovered, a relief spawned. Double-pumping banks toward the
    // 5000 cap; walking wastes the clock. Both STAY.
    const c = corp(["W1N0", "W2N0"]);
    setWorld();
    intel("W1N0");
    intel("W2N0");
    const a = reserverCreep(c, "W1N0");
    const b = { ...reserverCreep(c, "W1N0"), name: "r2" };
    Game.creeps.r1 = a;
    Game.creeps.r2 = b;
    c.work(tick);
    expect(a.memory.targetRoom).to.equal("W1N0");
    expect(b.memory.targetRoom, "duplicates are never re-spread").to.equal("W1N0");
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

/**
 * The reserver duty cycle (spec 15 P5). A reservation BANKS: reserveController
 * adds CLAIM parts of ticks per tick (cap 5000) while decay costs 1/tick, so a
 * room holding a fat reservation needs no reserver until it runs down near the
 * refresh floor. The corp priced this (reserverTollPerRoom x RESERVER_DUTY 0.5)
 * but the demand gate re-staffed continuously - 2x the priced spawn+energy
 * cost, and twice the 1300 holdToFund walls at the spawn (measured live: a
 * 1000+ tick queue hold banking one). The gate now reads the intel-stamped
 * reservation bound (durable: the bound counts down exactly as the reservation
 * does, so it stays correct with zero vision).
 */
describe("reservation duty cycle (coast on the banked reservation)", () => {
  const bank = (room: string, ticksLeft: number, by = "me"): void => {
    (Memory as any).roomIntel[room].reservedUntil = tick + ticksLeft;
    (Memory as any).roomIntel[room].reservedBy = by;
  };

  it("a target banked above the refresh floor asks for NO real reserver (topup offer is opportunistic-only)", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0");
    bank("W1N0", 2000);
    const demands = c.getSpawnDemand({ energyCapacity: 1300, tick });
    // The duty cycle coasts: nothing that walls, holds, or ages upward. The
    // one thing on offer is the idle-window topup (task #11) - bottom value,
    // opportunistic, ignorable by a busy spawn forever.
    expect(demands.filter(d => !d.opportunistic)).to.have.length(0);
    expect(demands.every(d => d.opportunistic && !d.blocking && d.holdToFund !== true)).to.equal(true);
  });

  it("a target below the floor demands, and the sizing stamp carries the bank verbatim", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0");
    bank("W1N0", 300);
    expect(c.getSpawnDemand({ energyCapacity: 1300, tick })).to.have.length(1);
    const s = (c as any).lastSizing;
    expect(s.gate).to.equal("demand");
    expect(s.needy).to.equal(1);
    expect(s.banks["W1N0"]).to.equal(300);
  });

  it("a reserver latched to a HEALTHY room does not cover a needy one (per-room coverage, one-way era)", () => {
    // One-way missions mean a fielded reserver can never be re-spread, so the
    // blunt living-count lens goes blind: 1 living >= 1 needy said "staffed"
    // while the living one was latched elsewhere for life. Coverage is now
    // per-room (assigned) plus wildcards (unassigned newborns).
    const c = corp(["W1N0", "W2N0"]);
    const latched = { memory: { corpId: c.id, workType: "reserve", targetRoom: "W1N0" }, spawning: false };
    setWorld({ r1: latched });
    intel("W1N0");
    intel("W2N0");
    bank("W1N0", 4000); // healthy - its reserver holds this post regardless
    bank("W2N0", 200); // needy - no assignment, no wildcard
    const demands = c.getSpawnDemand({ energyCapacity: 1300, tick });
    expect(demands, "the latched reserver cannot serve W2N0 - buy one").to.have.length(1);
    expect((c as any).lastSizing.gate).to.equal("demand");
  });

  it("emits an OPPORTUNISTIC topup when banked-but-below-cap (owner idea: bank reserve in idle windows)", () => {
    // All targets above the refresh floor (no needy demand) but the lowest
    // bank has >=1000 ticks of headroom to the 5000 cap: offer a bottom-value
    // opportunistic reserver the scheduler may buy in an idle window. It
    // never walls, never starves upward, and work() latches it one-way to
    // the lowest bank.
    const c = corp(["W1N0", "W2N0"]);
    setWorld();
    intel("W1N0");
    intel("W2N0");
    bank("W1N0", 3000);
    bank("W2N0", 2000); // headroom 3000 to cap - worth banking
    const demands = c.getSpawnDemand({ energyCapacity: 1300, tick });
    expect(demands).to.have.length(1);
    expect(demands[0].opportunistic).to.equal(true);
    expect(demands[0].blocking).to.not.equal(true);
    expect((c as any).lastSizing.gate).to.equal("opportunistic-topup");
  });

  it("no topup when every bank is near the cap (nothing worth banking)", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0");
    bank("W1N0", 4500); // headroom 500 < the 1000 threshold
    expect(c.getSpawnDemand({ energyCapacity: 1300, tick })).to.have.length(0);
    expect((c as any).lastSizing.gate).to.equal("reservation-banked");
  });

  it("no topup while an unassigned corp reserver exists (one wildcard at a time)", () => {
    const c = corp(["W1N0"]);
    const wildcard = { memory: { corpId: c.id, workType: "reserve" }, spawning: true };
    setWorld({ w1: wildcard });
    intel("W1N0");
    bank("W1N0", 2000);
    expect(c.getSpawnDemand({ energyCapacity: 1300, tick })).to.have.length(0);
  });

  it("mixed targets: only the needy room is priced (banked one costs nothing)", () => {
    const c = corp(["W1N0", "W2N1"]);
    setWorld();
    intel("W1N0");
    intel("W2N1");
    bank("W1N0", 4000);
    bank("W2N1", 100);
    const demands = c.getSpawnDemand({ energyCapacity: 1300, tick });
    expect(demands).to.have.length(1);
    const s = (c as any).lastSizing;
    expect(s.targets).to.equal(2);
    expect(s.needy).to.equal(1);
  });

  it("another player's reservation banks NOTHING for us (still needy)", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0");
    bank("W1N0", 4000, "rival");
    expect(c.getSpawnDemand({ energyCapacity: 1300, tick })).to.have.length(1);
  });

  it("no stamp at all means needy (conservative: over-reserve, never lose the 3000 rate)", () => {
    const c = corp(["W1N0"]);
    setWorld();
    intel("W1N0");
    expect(c.getSpawnDemand({ energyCapacity: 1300, tick })).to.have.length(1);
  });
});
