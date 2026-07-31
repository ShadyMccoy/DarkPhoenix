/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { ConstructionCorp, nextBuildTarget } from "../../../src/corps/ConstructionCorp";

/**
 * BUILDER ASSIGNMENT (owner 2026-07-22: "they can't ping-pong around. they
 * just go to a site, stay there, get tankers coming, and build ... they
 * should build/repair things that are sequential logistically"):
 *
 * - nextBuildTarget is the build-side twin of the repair latch: a builder
 *   LATCHES to one site until it completes/vanishes, then picks the NEAREST
 *   site from where it stands - a sequential chain over the project, never a
 *   per-tick re-pick that flips targets as the creep drifts (the old
 *   findClosestByPath-every-tick did exactly that, and paid a path search
 *   per builder per tick for the privilege).
 * - Every walking tick with energy aboard repairs the road underfoot
 *   (repairRoadEnRoute): repair rides the work action group, move rides its
 *   own, so they stack in one tick - and spending carry LIGHTENS the body
 *   (stored energy is weight), so the walk itself gets faster. The wiring
 *   must cover the maintenance walk and the pickup walk, not just the
 *   cross-room marches.
 */
describe("builder assignment (latch to a site, sequential targets, repair while walking)", () => {
  beforeEach(() => {
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).WORK = "work";
    (global as any).FIND_STRUCTURES = 107;
    (global as any).FIND_DROPPED_RESOURCES = 108;
    (global as any).FIND_TOMBSTONES = 118;
    (global as any).FIND_RUINS = 123;
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    (global as any).STRUCTURE_ROAD = "road";
    (global as any).STRUCTURE_CONTAINER = "container";
    (global as any).STRUCTURE_STORAGE = "storage";
    (global as any).OK = 0;
    (global as any).ERR_NOT_IN_RANGE = -9;
    (global as any).Game = { creeps: {}, rooms: {}, time: 500, getObjectById: () => null };
    (global as any).Memory = { creeps: {}, rooms: {} };
  });

  describe("nextBuildTarget (finish one site, then the nearest next)", () => {
    interface TSite {
      id: string;
      pos: { x: number; y: number };
    }
    const site = (id: string, x: number): TSite => ({ id, pos: { x, y: 10 } });
    const rangeFrom = (x: number) => (s: TSite) => Math.abs(s.pos.x - x);

    it("latches: keeps the current site even when another is now nearer", () => {
      const latched = site("far", 20);
      const nearer = site("near", 2);
      expect(nextBuildTarget([nearer, latched], "far", rangeFrom(0))).to.equal(latched);
    });

    it("latch gone (site completed): picks the NEAREST site from where the builder stands", () => {
      const next = site("b", 12);
      const distant = site("c", 40);
      // The builder finished its site at x=10 - the chain continues at x=12,
      // not at whatever find() happened to list first.
      expect(nextBuildTarget([distant, next], "done-and-gone", rangeFrom(10))).to.equal(next);
    });

    it("no latch yet: nearest site wins (the chain starts where the builder is)", () => {
      const near = site("a", 5);
      expect(nextBuildTarget([site("b", 30), near], undefined, rangeFrom(4))).to.equal(near);
    });

    it("no sites: null", () => {
      expect(nextBuildTarget([], "anything", rangeFrom(0))).to.equal(null);
    });
  });

  describe("repair-while-walking wiring (the walks that carried energy without spending it)", () => {
    function makeCorp(): ConstructionCorp {
      return new ConstructionCorp("W1N1-construction", "spawn1");
    }

    /** A creep whose pos serves both the repairables scan and the en-route scan. */
    function walkerCreep(opts: { energy: number; underfoot: any[] }): {
      creep: any;
      repairs: any[];
      moves: any[];
      pickups: any[];
    } {
      const repairs: any[] = [];
      const moves: any[] = [];
      const pickups: any[] = [];
      const creep = {
        name: "b1",
        memory: {} as any,
        store: { energy: opts.energy, getFreeCapacity: () => 50 },
        getActiveBodyparts: (p: string) => (p === "work" ? 2 : 0),
        room: { name: "W1N1" },
        pos: {
          x: 10,
          y: 10,
          roomName: "W1N1",
          getRangeTo: (t: any) => {
            const p = t.pos ?? t;
            return Math.max(Math.abs((p.x ?? 0) - 10), Math.abs((p.y ?? 0) - 10));
          },
          findInRange: (type: number, _range: number, o?: any) => {
            if (type !== (global as any).FIND_STRUCTURES) return [];
            return o?.filter ? opts.underfoot.filter(o.filter) : opts.underfoot;
          },
          findClosestByPath: () => null
        },
        repair: (t: any) => {
          repairs.push(t);
          // Far targets (outside range 3) are out of range; near ones succeed.
          const p = t.pos ?? { x: 10, y: 10 };
          return Math.max(Math.abs(p.x - 10), Math.abs(p.y - 10)) > 3 ? -9 : 0;
        },
        pickup: (t: any) => {
          pickups.push(t);
          return -9; // out of range - forces the walk
        },
        moveTo: (...args: any[]) => {
          moves.push(args);
          return 0;
        }
      };
      return { creep, repairs, moves, pickups };
    }

    it("doMaintenance: walking toward a far latched target still repairs the road underfoot", () => {
      const corp = makeCorp();
      const farRoad = { id: "far", structureType: "road", hits: 2000, hitsMax: 5000, pos: { x: 40, y: 40 } };
      const underfoot = { id: "under", structureType: "road", hits: 4000, hitsMax: 5000 };
      const room: any = {
        name: "W1N1",
        controller: undefined,
        storage: undefined,
        find: (type: number, o?: any) => {
          const all = type === (global as any).FIND_STRUCTURES ? [farRoad] : [];
          return o?.filter ? all.filter(o.filter) : all;
        }
      };
      const w = walkerCreep({ energy: 100, underfoot: [underfoot] });
      (corp as any).doMaintenance(w.creep, room);
      expect(w.moves.length, "walked toward the latched target").to.equal(1);
      expect(w.repairs, "far repair bounced (range), underfoot road repaired in the same tick").to.deep.equal([
        farRoad,
        underfoot
      ]);
    });

    it("doPickup: walking to energy with a partial load repairs the road underfoot", () => {
      const corp = makeCorp();
      const underfoot = { id: "under", structureType: "road", hits: 3000, hitsMax: 5000 };
      const pile = { id: "pile", resourceType: "energy", amount: 100, pos: { x: 14, y: 10 } };
      const room: any = { name: "W1N1", find: () => [] };
      const w = walkerCreep({ energy: 50, underfoot: [underfoot] });
      w.creep.pos.findInRange = (type: number, _r: number, o?: any) => {
        if (type === (global as any).FIND_DROPPED_RESOURCES) return o?.filter ? [pile].filter(o.filter) : [pile];
        if (type === (global as any).FIND_STRUCTURES) return o?.filter ? [underfoot].filter(o.filter) : [underfoot];
        return [];
      };
      (corp as any).doPickup(w.creep, room);
      expect(w.pickups, "went for the pile").to.deep.equal([pile]);
      expect(w.moves.length, "walked toward it").to.equal(1);
      expect(w.repairs, "and still repaired the road underfoot").to.deep.equal([underfoot]);
    });

    it("doPickup: nothing in reach parks at the LATCHED site, not at find()[0]", () => {
      const corp = makeCorp();
      const latchedSite = { id: "mine", pos: { x: 20, y: 10, roomName: "W1N1" } };
      const otherSite = { id: "other", pos: { x: 45, y: 45, roomName: "W1N1" } };
      (global as any).Game.getObjectById = (id: string) => (id === "mine" ? latchedSite : null);
      const room: any = {
        name: "W1N1",
        find: (type: number) => (type === (global as any).FIND_MY_CONSTRUCTION_SITES ? [otherSite, latchedSite] : [])
      };
      const w = walkerCreep({ energy: 0, underfoot: [] });
      w.creep.memory.buildTargetId = "mine";
      (corp as any).doPickup(w.creep, room);
      expect(w.moves.length, "parked toward a site").to.equal(1);
      expect(w.moves[0][0], "the latched site's pos, not the arbitrary first find() entry").to.equal(latchedSite.pos);
    });
  });
});

/**
 * REPAIR DETAIL MUST NOT CONSUME THE LAST BUILDER (owner-reported 2026-07-29:
 * "there's a big builder, but he's going around repairing roads instead";
 * root-caused at t72674879 - W43N23 stamped crew 1, onRepairDetail 1,
 * latchedToSite 0, buildTargets "R" with an 88-part builder, while 15 remote
 * sites stood and the plan allocated 20 e/t to construction: P8 FAIL "CREW
 * IDLE").
 *
 * TWO measured incidents pull opposite ways and the rule must honour both:
 *  - clearing an ACTIVE detail when a site appears stranded a below-gate
 *    container forever (cons-repair-stops-at-99, the reason the old
 *    "never take the last builder while sites exist" guard was REMOVED);
 *  - recruiting the ONLY builder into the detail zeroes construction (this
 *    incident).
 * The distinction is CLEAR vs RECRUIT: an existing detail is sticky and keeps
 * its beat; a lone builder is never conscripted while build work stands - the
 * +1 detail demand (builderPlanWithDetail) fields a dedicated creep instead.
 */
describe("repairDetailRecruit (never conscript the last builder)", () => {
  const { repairDetailRecruit } = require("../../../src/corps/repair");

  it("does NOT recruit when the crew is ONE and build work stands", () => {
    expect(repairDetailRecruit({ crew: 1, hasDetail: false, buildWork: true })).to.equal(false);
  });

  it("DOES recruit a lone builder when there is nothing to build", () => {
    // The idle-maintenance case: with no sites the whole point of the crew is
    // upkeep, so the single builder maintains.
    expect(repairDetailRecruit({ crew: 1, hasDetail: false, buildWork: false })).to.equal(true);
  });

  it("recruits from a crew of two even while building (repair stays decoupled)", () => {
    // The owner's 2026-07-18 directive: sites never block repair. With a
    // second body available, one repairs and one builds.
    expect(repairDetailRecruit({ crew: 2, hasDetail: false, buildWork: true })).to.equal(true);
  });

  it("never double-assigns when a detail already exists", () => {
    expect(repairDetailRecruit({ crew: 3, hasDetail: true, buildWork: true })).to.equal(false);
  });

  it("does not recruit from an empty crew", () => {
    expect(repairDetailRecruit({ crew: 0, hasDetail: false, buildWork: false })).to.equal(false);
  });

  /**
   * The CRITICAL band pierces the rule. REPAIR_CRITICAL exists precisely so a
   * genuinely endangered structure outranks construction ("a container is
   * worth 5000 energy to rebuild plus the mining it strands, far more than the
   * marginal delay to a build" - repair.ts). A last-builder guard that also
   * blocked the critical diversion would let the container die with sites
   * standing, which is the failure the critical band was added to prevent.
   */
  it("PIERCES the last-builder rule when a structure is critically decayed", () => {
    expect(repairDetailRecruit({ crew: 1, hasDetail: false, buildWork: true, critical: true })).to.equal(true);
  });

  it("critical is irrelevant once a detail exists (still no double-assign)", () => {
    expect(repairDetailRecruit({ crew: 2, hasDetail: true, buildWork: true, critical: true })).to.equal(false);
  });
});

/**
 * WHICH member is conscripted (owner-reported 2026-07-29: "there's a BIG
 * builder, but he's going around repairing roads instead"). `members()`
 * iterates Game.creeps in insertion order, so the old `members[0]` picked
 * arbitrarily - a 88-part builder was as likely as a runt. That inverts the
 * economics: the detail's OWN plan (repairerPlan) is a 550-cost 2-WORK body,
 * while the build crew's whole purpose is to absorb the construction budget.
 * Put the SMALLEST body on the beat and leave the build capacity building.
 */
describe("pickRepairDetail (the smallest body takes the maintenance beat)", () => {
  const { pickRepairDetail } = require("../../../src/corps/repair");
  const sizeOf = (c: { parts: number }) => c.parts;

  it("picks the smallest crew member, not the first listed", () => {
    const big = { parts: 44 };
    const small = { parts: 4 };
    expect(pickRepairDetail([big, small], sizeOf)).to.equal(small);
  });

  it("is stable on ties (first of equals - no per-tick reshuffling)", () => {
    const a = { parts: 8 };
    const b = { parts: 8 };
    expect(pickRepairDetail([a, b], sizeOf)).to.equal(a);
  });

  it("returns null for an empty crew", () => {
    expect(pickRepairDetail([], sizeOf)).to.equal(null);
  });

  it("tolerates an unmeasurable body (a partial mock sizes 0, never throws)", () => {
    const unknown = { parts: 0 };
    const known = { parts: 10 };
    expect(pickRepairDetail([known, unknown], sizeOf)).to.equal(unknown);
  });
});

/**
 * EXIT-TILE ESCAPE (owner-reported 2026-07-31: "the builders in W43N22 are
 * having a hard time. I think they might be getting stuck on the border
 * tiles" — confirmed live: builder-72685930 teleport-bounced between
 * W43N23(36,49) and W43N22(36,0) across three API samples, parked over a
 * road site at (36,2); poolWork moved 580e in 2,054 ticks = 0.28 e/t).
 *
 * The engine moves any creep standing on a border tile (x/y = 0|49) into the
 * adjacent room at tick end. A latched target within working range (3) of the
 * border makes the range-3 arrival tile the EXIT ITSELF: the creep builds or
 * repairs once, is teleported, and the cross-room branch walks it back —
 * re-entering ON the exit tile (and shedLoad drops its cargo each bounce).
 * Build/repair and move are DIFFERENT action groups, so stepping inward is
 * free: the same tick still works the target. The escape is therefore
 * unconditional-when-on-edge — never park on an exit tile.
 */
describe("exit-tile escape (never park on a border tile)", () => {
  function edgeCreep(x: number, y: number, energy: number): { creep: any; builds: any[]; repairs: any[]; moves: any[] } {
    const builds: any[] = [];
    const repairs: any[] = [];
    const moves: any[] = [];
    const creep = {
      name: "b-edge",
      memory: {} as any,
      store: { energy, getFreeCapacity: () => 0, getCapacity: () => 50 },
      getActiveBodyparts: () => 2,
      room: { name: "W43N22" },
      pos: {
        x, y, roomName: "W43N22",
        getRangeTo: (t: any) => { const p = t.pos ?? t; return Math.max(Math.abs((p.x ?? 0) - x), Math.abs((p.y ?? 0) - y)); },
        findInRange: () => [],
        findClosestByPath: () => null
      },
      build: (t: any) => { builds.push(t); return 0; },
      repair: (t: any) => { repairs.push(t); return 0; },
      withdraw: () => -9,
      pickup: () => -9,
      moveTo: (...a: any[]) => { moves.push(a); return 0; }
    };
    return { creep, builds, repairs, moves };
  }

  it("doBuild from an exit tile STILL BUILDS but also steps inward (the live bounce)", () => {
    const corp = new ConstructionCorp("W43N23-construction", "spawn1");
    const site = { id: "road36-2", structureType: "road", pos: { x: 36, y: 2, roomName: "W43N22" } };
    const room: any = { name: "W43N22", find: () => [site] };
    const w = edgeCreep(36, 0, 50); // ON the north exit tile, site in range 2
    (corp as any).doBuild(w.creep, room);
    expect(w.builds, "build fires from range 2 — the action is not the problem").to.deep.equal([site]);
    expect(w.moves.length, "and the creep steps INWARD so tick-end does not teleport it").to.be.greaterThan(0);
  });

  it("doBuild off the edge parks as before (no phantom walking)", () => {
    const corp = new ConstructionCorp("W43N23-construction", "spawn1");
    const site = { id: "road36-2", structureType: "road", pos: { x: 36, y: 2, roomName: "W43N22" } };
    const room: any = { name: "W43N22", find: () => [site] };
    const w = edgeCreep(36, 3, 50); // range 1, inside the room
    (corp as any).doBuild(w.creep, room);
    expect(w.builds).to.deep.equal([site]);
    expect(w.moves.length, "in range and OFF the edge: stand and build").to.equal(0);
  });

  it("doMaintenance from an exit tile STILL REPAIRS but also steps inward", () => {
    const corp = new ConstructionCorp("W43N23-construction", "spawn1");
    const road = { id: "r-border", structureType: "road", hits: 2000, hitsMax: 5000, pos: { x: 36, y: 2, roomName: "W43N22" } };
    const room: any = {
      name: "W43N22",
      controller: undefined,
      storage: undefined,
      find: (t: number, o?: any) => {
        const all = t === (global as any).FIND_STRUCTURES ? [road] : [];
        return o?.filter ? all.filter(o.filter) : all;
      }
    };
    const w = edgeCreep(36, 0, 50);
    (corp as any).doMaintenance(w.creep, room);
    expect(w.repairs, "repair fires from range 2").to.deep.equal([road]);
    expect(w.moves.length, "and the detail steps off the exit tile").to.be.greaterThan(0);
  });
});
