/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { buildPoolAbsorbRate } from "../../../src/corps/ConstructionCorp";
import { projectAbsorbRate } from "../../../src/economy/primitives";

/**
 * The pool's absorb rate - the energy/tick the ONE build-pool crew can
 * usefully eat - as a SHARED LENS (prod t72478939): the consumers'
 * construction-first clamp must read the same projectAbsorbRate formula that
 * sizes the crew (ConstructionCorp.builderPlan) and caps the plan's
 * construction sink (flowAdapter), or the clamp frees surplus the build side
 * cannot absorb and the difference banks. Measured: 12 road sites (pool
 * absorb ~5 e/t) engaged the boolean clamp exactly like a 100k build-out -
 * feeder relay 7, upgrader allocated 2, surplus 115, bank +20.18/t at 474k
 * (17x the warchest target).
 *
 * Inputs mirror builderPlan's home branch verbatim: total pool work, horizon
 * travel = the FARTHEST pool room (in-room = spawn range to the first site;
 * remote = roomLinearDistance * 50).
 */
describe("buildPoolAbsorbRate (the consumers' construction-first bound)", () => {
  const mkRoom = (name: string, remaining: number[], sitePos?: any): any => ({
    name,
    find: () => remaining.map(r => ({ progressTotal: 3000, progress: 3000 - r, pos: sitePos }))
  });

  beforeEach(() => {
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
  });

  it("empty pool: absorbs nothing (the clamp never engages)", () => {
    (global as any).Game = { rooms: { W43N23: mkRoom("W43N23", []) } };
    expect(buildPoolAbsorbRate("W43N23", undefined)).to.equal(0);
  });

  it("reads projectAbsorbRate over the pool total at the farthest room's travel (the crew-sizing formula, verbatim)", () => {
    // The t72478939 shape: trunk road sites two rooms over, none at home.
    (global as any).Game = {
      rooms: {
        W43N23: mkRoom("W43N23", []),
        W42N23: mkRoom("W42N23", [1500, 1200]), // 1 room away -> travel 50
        W42N22: mkRoom("W42N22", [525]) // 2 rooms away -> travel 100 (farthest)
      }
    };
    const rate = buildPoolAbsorbRate("W43N23", undefined);
    expect(rate).to.be.closeTo(projectAbsorbRate(1500 + 1200 + 525, 100), 1e-9);
  });

  it("home sites: travel is the spawn's range to the first home site", () => {
    const spawnPos: any = { roomName: "W43N23", getRangeTo: (): number => 10 };
    (global as any).Game = {
      rooms: { W43N23: mkRoom("W43N23", [5000], { x: 30, y: 30 }) }
    };
    expect(buildPoolAbsorbRate("W43N23", spawnPos)).to.be.closeTo(projectAbsorbRate(5000, 10), 1e-9);
  });

  it("a big build-out rates a big absorb (the plan-clamp limit stays reachable)", () => {
    (global as any).Game = { rooms: { W43N23: mkRoom("W43N23", [150_000], { x: 30, y: 30 }) } };
    const spawnPos: any = { roomName: "W43N23", getRangeTo: (): number => 5 };
    expect(buildPoolAbsorbRate("W43N23", spawnPos)).to.be.greaterThan(100);
  });
});
