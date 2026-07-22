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
