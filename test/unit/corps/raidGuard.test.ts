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
 * The room was harvested recently (the armed-trigger gate) - the durable
 * signal per the stranded-reserver trap: the meter's own harvest stamp,
 * never creep positions or the (remote-flapping) GOAL plan.
 */
function installPlannedMine(room = REMOTE): void {
  const intel = (Memory as any).roomIntel[room] ?? {};
  intel.lastHarvested = Game.time - 100;
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

describe("RaidGuardCorp home binding (the multi-home overlap, measured t73003513)", () => {
  beforeEach(install);

  /** Stage the colony's home spawns - the binding's input. */
  function installHomes(...rooms: string[]): void {
    (Game as any).spawns = {};
    rooms.forEach((room, i) => {
      (Game as any).spawns[`s${i}`] = { id: `spawn${i}`, room: { name: room }, pos: { x: 25, y: 25, roomName: room } };
    });
  }

  it("only the NEAREST home guards a room two homes can both see", () => {
    // MEASURED t73003513: three raidGuard corps (W43N23/W43N24/W43N21) each
    // stamped the IDENTICAL target set {W43N25, W44N22, W44N23}, each read
    // gate "covered", and each fielded its own guards - 10 guards / 96 parts
    // for THREE armed rooms. The plan prices the rooms bound to their nearest
    // home (raidGuardKind.propose, charged ONCE); the runtime fielded one per
    // home. The account's defense line ran 10.65 e/t against a 4.16 budget.
    const FAR = "W1N5"; // linear distance 3 from the remote; HOME is 1 away
    installHomes(HOME, FAR);
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine();

    const near = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    const far = new RaidGuardCorp(`${FAR}-raidGuard`, "spawn1");
    expect(near.guardTargets(HOME), "the nearest home holds the post").to.deep.equal([REMOTE]);
    expect(far.guardTargets(FAR), "the far home must NOT field a second guard").to.deep.equal([]);
  });

  it("ties break lexicographically - the same rule the commission prices with", () => {
    // Equidistant homes: exactly one must claim the room, and it must be the
    // one raidGuardKind.propose charged for it (sort by d, then room name).
    const EAST = "W1N3"; // both W1N1 and W1N3 are 1 away from W1N2
    installHomes(HOME, EAST);
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine();

    const a = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    const b = new RaidGuardCorp(`${EAST}-raidGuard`, "spawn1");
    const claimed = [...a.guardTargets(HOME), ...b.guardTargets(EAST)];
    expect(claimed, "exactly one home claims a tied room").to.deep.equal([REMOTE]);
    expect(a.guardTargets(HOME), "lexicographically smallest home wins the tie").to.deep.equal([REMOTE]);
  });

  it("the colony-wide UNION is unchanged - no armed room loses its guard", () => {
    // The budget side (CommissionHost.guardedRoomsLens, flowAdapter) folds the
    // lens over every home into a Set. Binding must not drop a room from that
    // union - it only decides WHICH home fields the body.
    const REMOTE2 = "W1N6"; // nearer the far home than to HOME
    const FAR = "W1N5";
    installHomes(HOME, FAR);
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 70_000 };
    (Memory as any).roomIntel[REMOTE2] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine();
    installPlannedMine(REMOTE2);

    const near = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    const far = new RaidGuardCorp(`${FAR}-raidGuard`, "spawn1");
    const union = new Set([...near.guardTargets(HOME), ...far.guardTargets(FAR)]);
    expect([...union].sort(), "every armed room still has exactly one owner").to.deep.equal([REMOTE, REMOTE2].sort());
    expect(near.guardTargets(HOME).length + far.guardTargets(FAR).length, "no double coverage").to.equal(2);
  });

  it("no discoverable homes (harness/no vision): today's behavior, never a silent stand-down", () => {
    (Game as any).spawns = {};
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    expect(corp.guardTargets(HOME), "absent fact must not disarm the guard").to.deep.equal([REMOTE]);
  });
});

describe("RaidGuardCorp staffing lens (the t72811290 double-buy class)", () => {
  beforeEach(install);

  /** One armed, recently-mined target - the world every case below shares. */
  function armRemote(room = REMOTE): void {
    (Memory as any).roomIntel[room] = { lastVisit: 1, raidDebt: 70_000 };
    installPlannedMine(room);
  }

  /** A guard creep staged exactly as executeSpawn stamps it (no targetRoom). */
  function stageGuard(
    corp: RaidGuardCorp,
    name: string,
    opts: { spawning?: boolean; targetRoom?: string; recycling?: boolean } = {}
  ): void {
    (Game.creeps as any)[name] = {
      name,
      spawning: opts.spawning ?? false,
      memory: {
        corpId: corp.id,
        workType: "guard",
        spawnedBy: "spawning-W1N1",
        ...(opts.targetRoom ? { targetRoom: opts.targetRoom } : {}),
        ...(opts.recycling ? { recycling: true } : {})
      },
      room: { name: HOME }
    };
  }

  it("does NOT re-demand while its only guard is still in the spawn (one body in the pipe IS one body staffed)", () => {
    // The screenshot bug (2026-08-14): the work lens read 0 covered for the
    // whole ~30-tick build, the demand re-armed every tick, and the global
    // spawn pool bought a fresh guard from each still-free spawn - three
    // guards for one armed room.
    armRemote();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    stageGuard(corp, "g1", { spawning: true });
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("does NOT re-demand for a just-emerged guard work() has not assigned yet (wildcard rule)", () => {
    armRemote();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    stageGuard(corp, "g1"); // live, unassigned
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("a recycling guard still COUNTS as staffing (spec 61 row 1)", () => {
    // A stand-down recycler discounts the ask until it dies - bounded by its
    // walk home, and uniform with every other kind's staffing count.
    armRemote();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    stageGuard(corp, "g1", { recycling: true });
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
  });

  it("wildcards discount the ask, never below zero: 2 targets, 1 assigned + 1 in the pipe = quiet", () => {
    const REMOTE2 = "W1N3";
    armRemote();
    armRemote(REMOTE2);
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    stageGuard(corp, "g1", { targetRoom: REMOTE });
    stageGuard(corp, "g2", { spawning: true });
    expect(corp.getSpawnDemand(ctx)).to.have.length(0);
    expect((corp as any).lastSizing.gate).to.equal("covered");

    // The pipe body covers ONE room, not all of them: a third armed room
    // still raises a real demand.
    const REMOTE3 = "W1N4";
    armRemote(REMOTE3);
    expect(corp.getSpawnDemand(ctx)).to.have.length(1);
  });
});

describe("RaidGuardCorp sizing stamp (the raid post-mortem lens, spec 14)", () => {
  beforeEach(install);

  it("a demand stamps gate/targets/uncovered and the per-room meter verbatim", () => {
    (Memory as any).roomIntel[REMOTE] = { lastVisit: 1, raidDebt: RAID_ARM_FLOOR };
    installPlannedMine();
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    corp.getSpawnDemand(ctx);
    const s = (corp as any).lastSizing;
    expect(s.gate).to.equal("demand");
    expect(s.targets).to.equal(1);
    expect(s.uncovered).to.equal(1);
    expect(s.debts[REMOTE]).to.equal(RAID_ARM_FLOOR);
  });

  it("a quiet map stamps no-targets (the wave post-mortem can prove the meter was NOT armed)", () => {
    const corp = new RaidGuardCorp(`${HOME}-raidGuard`, "spawn1");
    corp.getSpawnDemand(ctx);
    expect((corp as any).lastSizing.gate).to.equal("no-targets");
  });
});
