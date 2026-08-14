/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * CoreBusterCorp (spec 13 phase 4): kill the invader core, then strip the
 * leftover reservation. Mission targets come from the intel marks alone; the
 * payback gate skips occupations about to lapse; the core-present sighting
 * splits the two phases; rooms without known sources are never a mission
 * (that guard keeps the spec-12 phase-1 world - reservation staged blind,
 * partial intel - military-free, as its cell asserts).
 */
import "../../../src/types/Memory";
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { CoreBusterCorp } from "../../../src/corps/CoreBusterCorp";
import { CORE_BUSTER_MIN_REMAINING } from "../../../src/economy/primitives";

const HOME = "W1N1";
const REMOTE = "W1N2";

function install(): void {
  setupGlobals();
  (Game as any).map = {
    getRoomTerrain: () => ({ get: () => 0 }),
    getRoomLinearDistance: (a: string, b: string) => (a === b ? 0 : 1)
  };
  const g = global as any;
  g.ATTACK = "attack";
  g.MOVE = "move";
  g.CLAIM = "claim";
  Game.time = 80_000;
  Game.creeps = {};
  Game.rooms = {};
  (Memory as any).roomIntel = {};
  Game.getObjectById = (id: string) =>
    id === "spawn1"
      ? ({
          id: "spawn1",
          pos: { x: 25, y: 25, roomName: HOME },
          owner: { username: "me" },
          room: { name: HOME, controller: { my: true, level: 3 } }
        } as any)
      : null;
}

function occupiedIntel(opts: { remaining?: number; corePresent?: boolean; sourceCount?: number } = {}): any {
  return {
    lastVisit: 1,
    sourceCount: opts.sourceCount ?? 1,
    invaderReservedUntil: Game.time + (opts.remaining ?? 4000),
    ...(opts.corePresent === undefined ? {} : { invaderCorePresent: opts.corePresent })
  };
}

const ctx = { energyCapacity: 1300, tick: 80_000 } as any;

describe("CoreBusterCorp mission targets and demand (spec 13 phase 4)", () => {
  beforeEach(install);

  it("KILL phase: a sighted core on an occupied, sourced room demands a buster", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [REMOTE], strike: [] });

    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("buster");
    expect(demands[0].desiredCost).to.equal(1300); // 10x(ATTACK+MOVE)
    expect(demands[0].blocking, "an occupation is a siege, not a kill window").to.equal(false);
    expect(demands[0].producesIncome, "restores a zeroed income stream").to.equal(true);
    expect(demands[0].holdToFund).to.equal(true);
    expect(demands[0].value, "ladder: miners 100 < buster 104 < guard 105 < reserver 115").to.equal(104);
  });

  it("STRIP phase: core sighted GONE flips the mission to a CLAIM striker", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: false });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [], strike: [REMOTE] });

    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("striker");
    expect(demands[0].minCost, "CLAIM 600 floor is indivisible").to.equal(650);
    expect(demands[0].desiredCost).to.equal(1300); // 2x(CLAIM+MOVE)
  });

  it("an unsighted core (mark stamped blind) defaults to the striker phase", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel(); // no invaderCorePresent field
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME).strike).to.deep.equal([REMOTE]);
  });

  it("payback gate: an occupation about to lapse is not worth a body", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ remaining: CORE_BUSTER_MIN_REMAINING - 1, corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [], strike: [] });

    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ remaining: CORE_BUSTER_MIN_REMAINING, corePresent: true });
    expect(corp.missionTargets(HOME).attack).to.deep.equal([REMOTE]);
  });

  it("no mission for a room with no known sources (the spec-12 phase-1 partial-intel world)", () => {
    // hostileRooms() creates PARTIAL intel {lastVisit, invaderReservedUntil}
    // for rooms marked blind - no sourceCount means no income to restore and
    // no mission, which keeps the def-t5 flight cell military-free.
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, invaderReservedUntil: Game.time + 5000 };
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [], strike: [] });
  });

  it("covered targets emit no duplicate demand", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    (Game.creeps as any).b1 = {
      name: "b1",
      spawning: false,
      memory: { corpId: corp.id, workType: "buster", targetRoom: REMOTE },
      room: { name: REMOTE }
    };
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("striker demand waits until a CLAIM body is affordable", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: false });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.getSpawnDemand({ energyCapacity: 600, tick: Game.time } as any)).to.have.length(0);
  });
});

/**
 * EVICTION: hostile structures in rooms WE OWN (the EZRO-squatter incident,
 * t72968647). The engine counts ALL owners' spawns against a room's RCL
 * spawn limit (utils.checkControllerAvailability filters by type only), so a
 * derelict foreign spawn in a claimed room consumes the RCL-1 slot and the
 * founding site returns ERR_RCL_NOT_ENOUGH forever - the W43N21 campaign sat
 * wedged 1,400+ ticks on exactly this while the expansion driver swallowed
 * the code as transient. An owned room hosting hostile structures is the
 * buster's charter (evict occupations, restore the income stream); owned
 * rooms always have vision (the controller is an owned structure), so the
 * live read is durable, not a creep-vision read.
 */
describe("CoreBusterCorp eviction (hostile structures in owned rooms)", () => {
  const OWNED = "W1N3"; // claimed, no spawn of ours yet - the founding shape

  beforeEach(() => {
    install();
    (global as any).FIND_HOSTILE_STRUCTURES = 109;
    (global as any).STRUCTURE_INVADER_CORE = "invaderCore";
    // The corp's home spawn is the only spawn in the census - closest by default.
    (Game as any).spawns = { Spawn1: { room: { name: HOME } } };
  });

  /** An owned, visible room with the given hostile structures. */
  function ownedRoomWithHostiles(name: string, hostiles: any[]): any {
    return {
      name,
      controller: { my: true, level: 1 },
      find: (type: number) => (type === (global as any).FIND_HOSTILE_STRUCTURES ? hostiles : [])
    };
  }

  it("targets an owned room with a hostile spawn for the buster fleet", () => {
    (Game.rooms as any)[OWNED] = ownedRoomWithHostiles(OWNED, [
      { structureType: "spawn", pos: { x: 30, y: 33, roomName: OWNED }, hits: 5000 }
    ]);
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME).attack, "eviction rooms join the KILL phase").to.deep.equal([OWNED]);
    expect(corp.missionTargets(HOME).strike, "nothing to strip - no invader reservation").to.deep.equal([]);

    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("buster");
  });

  it("a clean owned room is no mission", () => {
    (Game.rooms as any)[OWNED] = ownedRoomWithHostiles(OWNED, []);
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(corp.missionTargets(HOME)).to.deep.equal({ attack: [], strike: [] });
  });

  it("only the CLOSEST home room's corp claims the eviction (no double busters)", () => {
    // Two home spawn rooms; the eviction belongs to the closer one.
    (Game as any).spawns = {
      Spawn1: { room: { name: HOME } }, // distance 1 (mock map: a===b ? 0 : 1)
      Spawn2: { room: { name: "W9N9" } }
    };
    (Game as any).map.getRoomLinearDistance = (a: string, b: string) => {
      if (a === b) return 0;
      if (a === HOME && b === OWNED) return 1;
      if (a === "W9N9" && b === OWNED) return 4;
      return 5;
    };
    (Game.rooms as any)[OWNED] = ownedRoomWithHostiles(OWNED, [{ structureType: "spawn", pos: { x: 30, y: 33 } }]);

    const near = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    expect(near.missionTargets(HOME).attack).to.deep.equal([OWNED]);
    expect(near.missionTargets("W9N9").attack, "the far home stays out of it").to.deep.equal([]);
  });

  it("the buster grinds the hostile spawn when no invader core stands (runBuster targeting)", () => {
    const attacked: string[] = [];
    const hostileSpawn = {
      structureType: "spawn",
      pos: { x: 30, y: 33, roomName: OWNED },
      hits: 5000
    };
    (Game.rooms as any)[OWNED] = ownedRoomWithHostiles(OWNED, [hostileSpawn]);
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    (Game.creeps as any).b1 = {
      name: "b1",
      spawning: false,
      memory: { corpId: corp.id, workType: "buster", targetRoom: OWNED },
      room: (Game.rooms as any)[OWNED],
      pos: {
        x: 29,
        y: 33,
        roomName: OWNED,
        isNearTo: () => true
      },
      attack: (t: any) => {
        attacked.push(t.structureType);
        return 0;
      }
    };

    corp.work(Game.time);
    expect(attacked, "no core in the room - the buster attacks the squatter spawn").to.deep.equal(["spawn"]);
  });
});

describe("CoreBusterCorp staffing lens (the t72811290 double-buy class)", () => {
  beforeEach(install);

  /** A mission creep staged exactly as executeSpawn stamps it (no targetRoom). */
  function stageCreep(
    corp: CoreBusterCorp,
    name: string,
    workType: "buster" | "strike",
    opts: { spawning?: boolean; targetRoom?: string; recycling?: boolean } = {}
  ): void {
    (Game.creeps as any)[name] = {
      name,
      spawning: opts.spawning ?? false,
      memory: {
        corpId: corp.id,
        workType,
        spawnedBy: "spawning-W1N1",
        ...(opts.targetRoom ? { targetRoom: opts.targetRoom } : {}),
        ...(opts.recycling ? { recycling: true } : {})
      },
      room: { name: HOME }
    };
  }

  it("does NOT re-demand a buster while one is still in the spawn (one body in the pipe IS one body staffed)", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    stageCreep(corp, "b1", "buster", { spawning: true });
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("does NOT re-demand a striker while one is still in the spawn", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: false });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    stageCreep(corp, "s1", "strike", { spawning: true });
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("a recycling buster still COUNTS as staffing (spec 61 row 1)", () => {
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    stageCreep(corp, "b1", "buster", { recycling: true });
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("roles are independent lenses: a buster in the pipe never staffs a striker post", () => {
    const STRIP = "W1N3";
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    (Memory as any).roomIntel[STRIP] = occupiedIntel({ corePresent: false });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    stageCreep(corp, "b1", "buster", { spawning: true });
    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("striker");
  });

  it("wildcards discount per-role asks, never below zero: 2 kill targets, 1 assigned + 1 unassigned = quiet", () => {
    const REMOTE2 = "W1N3";
    (Memory as any).roomIntel[REMOTE] = occupiedIntel({ corePresent: true });
    (Memory as any).roomIntel[REMOTE2] = occupiedIntel({ corePresent: true });
    const corp = new CoreBusterCorp(`${HOME}-coreBuster`, "spawn1");
    stageCreep(corp, "b1", "buster", { targetRoom: REMOTE });
    stageCreep(corp, "b2", "buster");
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);

    const REMOTE3 = "W1N4";
    (Memory as any).roomIntel[REMOTE3] = occupiedIntel({ corePresent: true });
    expect(corp.getSpawnDemand(ctx), "the wildcard covers ONE room, not all of them").to.have.length(1);
  });
});
