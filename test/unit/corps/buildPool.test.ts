/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { buildPool } from "../../../src/corps/ConstructionCorp";

/**
 * The colony's ONE build pool (owner 2026-07-20: "It basically just doesn't
 * matter which room the construction is in"). Every room with our sites is
 * one work list, home first then nearest - the spawn-scoped crew is sized
 * against the pool and marches to its head. Retires the distributed trunk
 * model whose empty-room corps fielded self-ferrying 1-WORK runts (trunk
 * stalled at 32/38 for ~4300t, measured t72463095).
 */
describe("buildPool (room-agnostic construction)", () => {
  const mkRoom = (name: string, remaining: number[]): any => ({
    name,
    find: () => remaining.map(r => ({ progressTotal: 3000, progress: 3000 - r }))
  });

  beforeEach(() => {
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
  });

  it("sums remaining work per room, home first, then nearest", () => {
    (global as any).Game = {
      rooms: {
        W43N24: mkRoom("W43N24", [300, 900]), // adjacent, the stalled trunk tiles
        W43N23: mkRoom("W43N23", [500]), // home
        W42N22: mkRoom("W42N22", [100]) // 2 away
      }
    };
    const pool = buildPool("W43N23");
    expect(pool.map(e => e.room.name)).to.deep.equal(["W43N23", "W43N24", "W42N22"]);
    expect(pool.map(e => e.work)).to.deep.equal([500, 1200, 100]);
  });

  it("empty home room: the pool head is the nearest remote work (the trunk un-stall shape)", () => {
    (global as any).Game = {
      rooms: {
        W43N23: mkRoom("W43N23", []),
        W43N24: mkRoom("W43N24", [1500, 1500]) // 4 stalled road sites' worth
      }
    };
    const pool = buildPool("W43N23");
    expect(pool).to.have.length(1);
    expect(pool[0].room.name, "the crew marches to the trunk").to.equal("W43N24");
    expect(pool[0].work).to.equal(3000);
  });

  it("no sites anywhere: empty pool (crew stands down)", () => {
    (global as any).Game = { rooms: { W43N23: mkRoom("W43N23", []) } };
    expect(buildPool("W43N23")).to.have.length(0);
  });
});
