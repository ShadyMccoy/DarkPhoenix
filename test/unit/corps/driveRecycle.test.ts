/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals } from "../mock";
import { driveRecycle } from "../../../src/corps/recycle";

/**
 * Recycle mechanics fixes (owner 2026-08-03: "if we have enough recycling to
 * justify it we can build a container by the spawn to recycle into"), on the
 * t72755898 finding that recycle tombstones masqueraded as combat kills:
 *
 * 1. CARGO DELIVERS, NEVER ENTOMBS. The old path dumped into the SPAWN -
 *    which a healthy room pins FULL, so a loaded recycler livelocked at the
 *    door (ERR_FULL forever) and its cargo eventually died into a tombstone.
 *    The bank is now storage-first (never full in practice); bootstrap rooms
 *    without storage keep the spawn dump unchanged.
 * 2. THE REFUND LANDS IN A STORE. recycleCreep's body refund drops onto the
 *    creep's tile - a container under the recycler catches it (the engine's
 *    own mechanic). When a container stands beside the spawn, the recycler
 *    seats it before recycling; occupied or absent falls back to the plain
 *    adjacent recycle, never a livelock. Whether to BUILD such a container
 *    is priced by v28's tombstoneRecycled line - this only USES one that
 *    exists.
 */
describe("driveRecycle (cargo delivers; refund lands in a store)", () => {
  beforeEach(() => setupGlobals());

  const pos = (x: number, y: number, extra: any = {}): any => ({
    x,
    y,
    roomName: "W1N1",
    isNearTo: (t: any) => Math.max(Math.abs(x - (t.pos ?? t).x), Math.abs(y - (t.pos ?? t).y)) <= 1,
    isEqualTo: (t: any) => (t.pos ?? t).x === x && (t.pos ?? t).y === y,
    findInRange: () => [],
    lookFor: () => [],
    ...extra
  });

  const rig = (over: {
    store?: number;
    storage?: boolean;
    pad?: { x: number; y: number; occupied?: boolean };
    creepAt?: { x: number; y: number };
    spawnFree?: number;
  }): { creep: any; spawn: any; calls: string[] } => {
    const calls: string[] = [];
    const spawnPos = pos(25, 25);
    const padStruct = over.pad
      ? {
          structureType: "container",
          pos: pos(over.pad.x, over.pad.y, {
            lookFor: () => (over.pad!.occupied ? [{ name: "squatter" }] : [])
          })
        }
      : undefined;
    spawnPos.findInRange = () => (padStruct ? [padStruct] : []);
    const spawn: any = {
      pos: spawnPos,
      recycleCreep: (c: any) => {
        calls.push(`recycle:${c.name}`);
        return 0;
      }
    };
    const at = over.creepAt ?? { x: 24, y: 25 };
    const creep: any = {
      name: "r1",
      pos: pos(at.x, at.y),
      store: { energy: over.store ?? 0, [`${"energy"}`]: over.store ?? 0 },
      room: {
        name: "W1N1",
        storage: over.storage ? { structureType: "storage", pos: pos(20, 20) } : undefined
      },
      transfer: (target: any) => {
        calls.push(`transfer:${target.structureType ?? "spawn"}`);
        return 0;
      },
      moveTo: (target: any) => {
        const p = target.pos ?? target;
        calls.push(`move:${p.x},${p.y}`);
        return 0;
      }
    };
    creep.store[RESOURCE_ENERGY] = over.store ?? 0;
    return { creep, spawn, calls };
  };

  it("a LOADED recycler banks into STORAGE - never the often-full spawn buffer", () => {
    const { creep, spawn, calls } = rig({ store: 300, storage: true });
    driveRecycle(creep, spawn);
    expect(calls[0]).to.equal("transfer:storage");
    expect(calls.some(c => c.startsWith("recycle")), "never recycles loaded").to.equal(false);
  });

  it("a loaded recycler WITHOUT storage still dumps to the spawn (bootstrap rooms unchanged)", () => {
    const { creep, spawn, calls } = rig({ store: 300 });
    driveRecycle(creep, spawn);
    expect(calls[0]).to.equal("transfer:spawn");
  });

  it("an EMPTY recycler seats the spawn-side container first - the refund lands in a store", () => {
    const { creep, spawn, calls } = rig({ pad: { x: 26, y: 25 }, creepAt: { x: 24, y: 25 } });
    driveRecycle(creep, spawn);
    expect(calls[0], "walks onto the pad, does not recycle beside it").to.equal("move:26,25");
    expect(calls.some(c => c.startsWith("recycle"))).to.equal(false);

    const seated = rig({ pad: { x: 26, y: 25 }, creepAt: { x: 26, y: 25 } });
    driveRecycle(seated.creep, seated.spawn);
    expect(seated.calls[0], "on the pad: recycle - the refund drops into the container").to.equal("recycle:r1");
  });

  it("a pad OCCUPIED by another creep falls back to the plain adjacent recycle - never a livelock", () => {
    const { creep, spawn, calls } = rig({ pad: { x: 26, y: 25, occupied: true }, creepAt: { x: 24, y: 25 } });
    driveRecycle(creep, spawn);
    expect(calls[0]).to.equal("recycle:r1");
  });

  it("no container: recycles adjacent exactly as before", () => {
    const { creep, spawn, calls } = rig({ creepAt: { x: 24, y: 25 } });
    driveRecycle(creep, spawn);
    expect(calls[0]).to.equal("recycle:r1");
  });
});
