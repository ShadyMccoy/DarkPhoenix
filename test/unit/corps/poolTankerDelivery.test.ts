/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals } from "../mock";
import { ConstructionCorp } from "../../../src/corps/ConstructionCorp";

/**
 * POOL TANKER DELIVERY, cross-room + detail exclusion (incident t72504146):
 * the ONE-BUILD-POOL crew "marches wherever the work is" and the tanker
 * demand gate was made pool-aware (t72473701) - but runTanker's DELIVERY
 * pick used `creep.pos.findClosestByRange(builders)`, a SAME-ROOM-ONLY
 * operation. With the pool head in W43N24 and the tankers home in W43N23,
 * the cross-room pool builder was invisible to the pick, so three full
 * tankers (~800 energy each) orbited the only same-room member - the
 * self-fueling REPAIR DETAIL - while the pool builder burned its own 50
 * carry at the trunk site (134/300 progress measured) and stood dry to TTL
 * death. The cd8d trunk froze at 51/53 for 3,300+ ticks with the plan
 * funding construction ~20 e/t (ledger P8 FAIL); creep memory showed all
 * three tankers targeting the detail's wander position (15,26 W43N23).
 *
 * The contract pinned here:
 *  - the repair detail NEVER receives tanker deliveries (repairerPlan: "It
 *    self-fuels at containers/storage, so it never needs tankers");
 *  - a pool builder with free capacity gets the delivery wherever it is -
 *    same room by nearest-range, CROSS-ROOM when no local crew exists;
 *  - staging (everyone topped off) follows the POOL crew, not the detail.
 */
describe("pool tanker delivery (cross-room crew, detail excluded - incident t72504146)", () => {
  const HOME = "W43N23";
  const REMOTE = "W43N24";

  beforeEach(() => {
    setupGlobals();
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).ERR_NOT_IN_RANGE = -9;
    (global as any).OK = 0;
    (global as any).Game = { creeps: {}, time: 1000, map: { getRoomLinearDistance: () => 1 } };
  });

  /** A position with Screeps' SAME-ROOM findClosestByRange semantics. */
  function posIn(roomName: string, x: number, y: number): any {
    const self: any = { x, y, roomName };
    const cheb = (t: any): number => Math.max(Math.abs(self.x - t.pos.x), Math.abs(self.y - t.pos.y));
    self.getRangeTo = (t: any): number => {
      const p = t.pos ?? t;
      if (p.roomName && p.roomName !== roomName) return Infinity;
      return Math.max(Math.abs(x - p.x), Math.abs(y - p.y));
    };
    self.findClosestByRange = (targets: any[]): any => {
      const local = (targets ?? []).filter(t => (t.pos?.roomName ?? t.roomName) === roomName);
      if (local.length === 0) return null;
      return local.reduce((a, b) => (cheb(a) <= cheb(b) ? a : b));
    };
    self.isEqualTo = (t: any): boolean => t.x === x && t.y === y;
    return self;
  }

  function builderAt(roomName: string, x: number, y: number, opts: { detail?: boolean; free?: number } = {}): any {
    return {
      spawning: false,
      ticksToLive: 1000,
      memory: { workType: "build", ...(opts.detail ? { repairDetail: true } : {}) },
      pos: posIn(roomName, x, y),
      store: {
        energy: 0,
        getFreeCapacity: () => opts.free ?? 50,
        getCapacity: () => 50
      }
    };
  }

  function tankerAt(roomName: string, x: number, y: number): any {
    const moves: any[] = [];
    const transfers: any[] = [];
    const c: any = {
      spawning: false,
      ticksToLive: 1000,
      memory: { workType: "tank", working: true },
      pos: posIn(roomName, x, y),
      store: { energy: 800, getFreeCapacity: () => 0, getCapacity: () => 800 },
      transfer: (t: any) => {
        transfers.push(t);
        return c.pos.getRangeTo(t.pos ?? t) <= 1 ? 0 : -9;
      },
      moveTo: (t: any) => {
        moves.push(t.pos ?? t);
        return 0;
      },
      room: { name: roomName } // no lookForAt/getTerrain: stepOffRoad no-ops
    };
    c.movesTo = moves;
    c.transfersTo = transfers;
    return c;
  }

  function corpWith(members: Record<string, any>): ConstructionCorp {
    const corp = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    for (const name in members) {
      members[name].name = name;
      members[name].memory.corpId = corp.id;
      (global as any).Game.creeps[name] = members[name];
    }
    return corp;
  }

  it("the incident shape: full tanker ignores the same-room DETAIL and moves toward the cross-room pool builder", () => {
    const detail = builderAt(HOME, 15, 26, { detail: true, free: 50 });
    const pool = builderAt(REMOTE, 36, 28, { free: 50 });
    const tanker = tankerAt(HOME, 34, 26);
    corpWith({ detail, pool, tanker });
    const corp = (global as any).Game.creeps.tanker.memory.corpId;
    const c = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    expect(c.id).to.equal(corp);
    (c as any).runTanker(tanker, { name: HOME });
    expect(tanker.transfersTo, "the detail must never soak the pool's fuel").to.not.include(detail);
    const moved = tanker.movesTo[0];
    expect(moved, "the tanker marches at the pool builder").to.equal(pool.pos);
  });

  it("no pool builder fielded: the tanker does not chase the detail with deliveries", () => {
    const detail = builderAt(HOME, 15, 26, { detail: true, free: 50 });
    const tanker = tankerAt(HOME, 34, 26);
    corpWith({ detail, tanker });
    const c = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    (c as any).runTanker(tanker, { name: HOME });
    expect(tanker.transfersTo).to.not.include(detail);
    expect(tanker.movesTo, "no crew: hold, do not orbit the detail").to.not.include(detail.pos);
  });

  it("same-room pool builder still gets the ordinary nearest delivery", () => {
    const pool = builderAt(HOME, 33, 26, { free: 50 });
    const tanker = tankerAt(HOME, 34, 26);
    corpWith({ pool, tanker });
    const c = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    (c as any).runTanker(tanker, { name: HOME });
    expect(tanker.transfersTo[0], "adjacent same-room crew: transfer fires").to.equal(pool);
  });

  it("local crew outranks the cross-room crew when both stand with capacity", () => {
    const local = builderAt(HOME, 30, 26, { free: 50 });
    const far = builderAt(REMOTE, 36, 28, { free: 50 });
    const tanker = tankerAt(HOME, 34, 26);
    corpWith({ local, far, tanker });
    const c = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    (c as any).runTanker(tanker, { name: HOME });
    const went = tanker.transfersTo[0] ?? tanker.movesTo[0];
    expect(went === local || went === local.pos, "nearest eligible is the same-room builder").to.equal(true);
  });

  it("everyone topped off: staging follows the pool crew, never the detail", () => {
    const detail = builderAt(HOME, 15, 26, { detail: true, free: 50 });
    const pool = builderAt(REMOTE, 36, 28, { free: 0 }); // topped off
    const tanker = tankerAt(HOME, 34, 26);
    corpWith({ detail, pool, tanker });
    const c = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    (c as any).runTanker(tanker, { name: HOME });
    expect(tanker.movesTo[0], "stage beside the pool builder for the instant hand-off").to.equal(pool.pos);
  });
});
