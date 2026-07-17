/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * RaidGuardCorp (spec 13 phase 3): pre-spawned remote defense off the raid
 * clock. Targets = armed rooms we currently mine + sighted raids in progress;
 * one guard per target at value 105 (ladder: hauler floor 90 < guard 105 <
 * reserver 115, never income-tier); guards liquidate after a quiet grace.
 */
import "../../../src/types/Memory";
import { expect } from "chai";
import { setupGlobals, Game, Memory } from "../mock";
import { RaidGuardCorp, GUARD_RECYCLE_GRACE } from "../../../src/corps/RaidGuardCorp";
import { RAID_ARM_FLOOR, RAID_GOAL_CEIL, INVADER_TTL } from "../../../src/economy/primitives";

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
  Game.time = 50_000;
  Game.creeps = {};
  Game.rooms = {};
  (Memory as any).roomIntel = {};
  (Memory as any).economyPlan = undefined;
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

/**
 * The GOAL plan mines the remote (the armed-trigger gate) - the durable
 * signal per the stranded-reserver trap: plan + intel, never creep
 * positions. Seeds Memory.economyPlan and the room's intel sourceIds.
 */
function installPlannedMine(room = REMOTE): void {
  (Memory as any).economyPlan = {
    corps: [{ kind: "mine", sourceId: `source-src-${room}`, spawnId: "spawn1" }]
  };
  const intel = (Memory as any).roomIntel[room] ?? {};
  intel.sourceIds = [`src-${room}`];
  (Memory as any).roomIntel[room] = intel;
}

const ctx = { energyCapacity: 800, tick: 50_000 } as any;

describe("RaidGuardCorp targets and demand (spec 13 phase 3)", () => {
  beforeEach(install);

  it("targets an ARMED room we currently mine (predictive pre-spawn)", () => {
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: RAID_ARM_FLOOR };
    installPlannedMine();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.guardTargets(HOME)).to.deep.equal([REMOTE]);
    const demands = corp.getSpawnDemand(ctx);
    expect(demands).to.have.length(1);
    expect(demands[0].role).to.equal("guard");
    expect(demands[0].desiredCost).to.equal(650); // 5x(ATTACK+MOVE)
    // Blocking while armed: the guard is the precondition for every further
    // body sent into the kill window (measured 50-vs-186 funding race
    // without it).
    expect(demands[0].blocking).to.equal(true);
  });

  it("does NOT target an armed room nobody mines (stale debt is not a mission)", () => {
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 80_000 };
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.guardTargets(HOME)).to.deep.equal([]);
  });

  it("disarms OVERDUE rooms (debt past 130k with no raid: raids don't fire here)", () => {
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: RAID_GOAL_CEIL + 1 };
    installPlannedMine();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.guardTargets(HOME)).to.deep.equal([]);
  });

  it("targets a SIGHTED raid in progress even with no miner left (reactive fallback)", () => {
    (Memory as any).roomIntel[REMOTE] = {
      lastVisit: 1,
      raidDebt: 0,
      lastRaidSeen: Game.time - 10,
      hostileUntil: Game.time + 1400
    };
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.guardTargets(HOME)).to.deep.equal([REMOTE]);
    // MILITARY EXEMPTION: the room is hostile-marked and the demand exists
    // anyway - the guard enters exactly the rooms the economy flees.
    expect(corp.getSpawnDemand(ctx)).to.have.length(1);
  });

  it("stands down once the sighted raid ages out (invader TTL)", () => {
    (Memory as any).roomIntel[REMOTE] = {
      lastVisit: 1,
      lastRaidSeen: Game.time - INVADER_TTL,
      hostileUntil: Game.time + 10
    };
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.guardTargets(HOME)).to.deep.equal([]);
  });

  it("never targets the home room or an owned room", () => {
    (Memory as any).roomIntel[HOME] = { lastVisit: 1, raidDebt: 90_000 };
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 90_000, controllerOwner: "somebody" };
    installPlannedMine(HOME);
    installPlannedMine(REMOTE);
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.guardTargets(HOME)).to.deep.equal([]);
  });

  it("emits no demand for a target already covered by an assigned guard", () => {
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    (Game.creeps as any).g1 = {
      name: "g1",
      spawning: false,
      memory: { corpId: corp.id, workType: "guard", targetRoom: REMOTE },
      room: { name: REMOTE }
    };
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("emits no demand below the viable-body floor (3 pairs = 390)", () => {
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.getSpawnDemand({ energyCapacity: 300, tick: Game.time } as any)).to.have.length(0);
  });

  it("holds the value-ladder slot: hauler floor 90 < guard 105 < reserver 115", () => {
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    const demand = corp.getSpawnDemand(ctx)[0];
    expect(demand.value).to.equal(105);
    expect(demand.value).to.be.greaterThan(90); // hauler band floor
    expect(demand.value).to.be.lessThan(115); // reserver
    // Reserver treatment (measured def-t4 starvation at base tier): the
    // guard PRESERVES committed income, so it rides the income tier as a
    // started unit and banks toward its full body when it tops the queue.
    expect(demand.producesIncome).to.equal(true);
    expect(demand.holdToFund).to.equal(true);
    expect(demand.minCost, "3-pair floor under pressure").to.equal(390);
    expect(demand.desiredCost, "full 5-pair body").to.equal(650);
  });

  it("an unassigned guard recycles only after the quiet grace window", () => {
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    const guard: any = {
      name: "g1",
      spawning: false,
      memory: { corpId: corp.id, workType: "guard", targetRoom: REMOTE },
      room: { name: HOME },
      pos: { x: 20, y: 20, roomName: HOME, findClosestByRange: () => null, inRangeTo: () => true }
    };
    (Game.creeps as any).g1 = guard;

    corp.work(Game.time); // no targets: assignment drops, grace starts
    expect(guard.memory.recycling).to.equal(undefined);
    expect(guard.memory.idleSince).to.equal(Game.time);

    corp.work(Game.time + GUARD_RECYCLE_GRACE - 1);
    expect(guard.memory.recycling, "still inside the grace window").to.equal(undefined);

    corp.work(Game.time + GUARD_RECYCLE_GRACE);
    expect(guard.memory.recycling, "liquidates after the quiet window").to.equal(true);
  });
});
