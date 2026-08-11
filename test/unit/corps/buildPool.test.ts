/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { buildPool } from "../../../src/corps/constructionLedger";

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

  /** Stage a construction corp's project ledger (the pool's priority source). */
  const ledger = (projects: Array<{ roomName: string; structureType: string; remaining: number }>): void => {
    (global as any).Memory = {
      commissionedCorps: {
        "construction-home": {
          kind: "construction",
          corp: {
            projects: projects.map((p, i) => ({ id: `site-${i}`, x: 10, y: 10, seen: 0, ...p }))
          }
        }
      }
    };
  };

  beforeEach(() => {
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    // The ledger lens is inert unless a test stages it - and a leaked Memory
    // from another test file must not reorder the distance pins below.
    (global as any).Memory = undefined;
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
    expect(pool.map(e => e.roomName)).to.deep.equal(["W43N23", "W43N24", "W42N22"]);
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
    expect(pool[0].roomName, "the crew marches to the trunk").to.equal("W43N24");
    expect(pool[0].work).to.equal(3000);
  });

  it("no sites anywhere: empty pool (crew stands down)", () => {
    (global as any).Game = { rooms: { W43N23: mkRoom("W43N23", []) } };
    expect(buildPool("W43N23")).to.have.length(0);
  });

  // ---------------------------------------------------------------------------
  // PLAN-LADDER ORDERING (the exp-t5-founding red, diagnosed 2026-08-11): the
  // solver prices a founding SPAWN site at newSpawnSite (85) above ordinary
  // construction (70), then the crew worked the pool's HEAD room under a
  // home-first-distance sort that never read those values - so the funded
  // founding site got zero energy for 1800t while home's self-refilling site
  // queue held the head. The pool now ranks rooms by the SAME goal valuation
  // the adapter prices sinks with, applied to the ledger's own structureType;
  // ties keep home-first-then-distance, so every world without a
  // founding-class site orders byte-identically to before.
  // ---------------------------------------------------------------------------

  it("a founding SPAWN site in another room outranks home's ordinary sites", () => {
    (global as any).Game = {
      rooms: {
        W43N23: mkRoom("W43N23", [500]), // home, ordinary site (70)
        W44N23: mkRoom("W44N23", [1000]) // founding spawn site (85)
      }
    };
    ledger([
      { roomName: "W43N23", structureType: "extension", remaining: 500 },
      { roomName: "W44N23", structureType: "spawn", remaining: 1000 }
    ]);
    const pool = buildPool("W43N23");
    expect(pool.map(e => e.roomName), "the funded founding site takes the pool head").to.deep.equal([
      "W44N23",
      "W43N23"
    ]);
  });

  it("ordinary-only ledgers change nothing: home first, then nearest (behavior pin)", () => {
    (global as any).Game = {
      rooms: {
        W43N24: mkRoom("W43N24", [300]),
        W43N23: mkRoom("W43N23", [500]),
        W42N22: mkRoom("W42N22", [100])
      }
    };
    ledger([
      { roomName: "W43N24", structureType: "road", remaining: 300 },
      { roomName: "W43N23", structureType: "extension", remaining: 500 },
      { roomName: "W42N22", structureType: "container", remaining: 100 }
    ]);
    expect(buildPool("W43N23").map(e => e.roomName)).to.deep.equal(["W43N23", "W43N24", "W42N22"]);
  });

  it("a home-room spawn site does not demote other rooms below their pin order", () => {
    // Home holds the founding-class record itself: home stays head (85 beats
    // 70), and the rest keep distance order - the sort is (value, home,
    // distance), never value alone.
    (global as any).Game = {
      rooms: {
        W43N23: mkRoom("W43N23", [800]),
        W43N24: mkRoom("W43N24", [300])
      }
    };
    ledger([
      { roomName: "W43N23", structureType: "spawn", remaining: 800 },
      { roomName: "W43N24", structureType: "extension", remaining: 300 }
    ]);
    expect(buildPool("W43N23").map(e => e.roomName)).to.deep.equal(["W43N23", "W43N24"]);
  });
});
