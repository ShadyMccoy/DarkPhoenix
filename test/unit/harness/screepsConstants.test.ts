import { expect } from "chai";

/**
 * THE HARNESS'S OWN CONTRACT (2026-08-06).
 *
 * `test/setup-mocha.js` stages the Screeps global constants before any test
 * file loads, because modules read them at import time. Two failure modes had
 * both already happened silently, and this file exists to make either one
 * fail loudly instead:
 *
 *  1. COLLISION. FIND_MINERALS and FIND_MY_CREEPS were both 106, the value of
 *     FIND_DROPPED_RESOURCES. Mock rooms dispatch `find(type)` on these
 *     numbers, so one stub answered three different lenses - a scavenge probe
 *     could receive a creep list and never notice.
 *  2. ABSENCE. Six FIND_* constants the source uses were not staged at all,
 *     so a test FILE that reached them threw `... is not defined` when run
 *     alone, and only passed inside the full suite because an earlier file
 *     happened to set the global first. The workflow runs single files
 *     routinely, so that is real friction, not a curiosity.
 *
 * The values are the engine's real ones. A mock that dispatches on them then
 * behaves like the engine by construction.
 */
describe("test harness - staged Screeps constants", () => {
  const FIND_NAMES = [
    "FIND_CREEPS",
    "FIND_MY_CREEPS",
    "FIND_HOSTILE_CREEPS",
    "FIND_SOURCES_ACTIVE",
    "FIND_SOURCES",
    "FIND_DROPPED_RESOURCES",
    "FIND_STRUCTURES",
    "FIND_MY_STRUCTURES",
    "FIND_HOSTILE_STRUCTURES",
    "FIND_FLAGS",
    "FIND_CONSTRUCTION_SITES",
    "FIND_MY_SPAWNS",
    "FIND_HOSTILE_SPAWNS",
    "FIND_MY_CONSTRUCTION_SITES",
    "FIND_HOSTILE_CONSTRUCTION_SITES",
    "FIND_MINERALS",
    "FIND_NUKES",
    "FIND_TOMBSTONES",
    "FIND_DEPOSITS",
    "FIND_RUINS"
  ] as const;

  const g = globalThis as unknown as Record<string, number | undefined>;

  it("stages every FIND_* constant the source actually uses", () => {
    for (const name of FIND_NAMES) {
      expect(g[name], `${name} is not staged - a test file reaching it cannot run standalone`).to.be.a("number");
    }
  });

  it("every FIND_* value is DISTINCT (the 106 collision must never come back)", () => {
    const seen = new Map<number, string>();
    for (const name of FIND_NAMES) {
      const value = g[name]!;
      const clash = seen.get(value);
      expect(clash, `${name} and ${clash} share value ${value} - one find() stub would answer both`).to.equal(
        undefined
      );
      seen.set(value, name);
    }
  });

  it("matches the engine's published values (a mock dispatching on them behaves like the engine)", () => {
    expect(g.FIND_CREEPS).to.equal(101);
    expect(g.FIND_MY_CREEPS).to.equal(102);
    expect(g.FIND_HOSTILE_CREEPS).to.equal(103);
    expect(g.FIND_SOURCES).to.equal(105);
    expect(g.FIND_DROPPED_RESOURCES).to.equal(106);
    expect(g.FIND_STRUCTURES).to.equal(107);
    expect(g.FIND_MY_STRUCTURES).to.equal(108);
    expect(g.FIND_CONSTRUCTION_SITES).to.equal(111);
    expect(g.FIND_MY_SPAWNS).to.equal(112);
    expect(g.FIND_MY_CONSTRUCTION_SITES).to.equal(114);
    expect(g.FIND_MINERALS).to.equal(116);
    expect(g.FIND_TOMBSTONES).to.equal(118);
    expect(g.FIND_RUINS).to.equal(123);
  });

  it("stages the body-part and resource constants modules read at import time", () => {
    for (const name of ["WORK", "CARRY", "MOVE", "ATTACK", "RANGED_ATTACK", "HEAL", "TOUGH", "CLAIM"]) {
      expect(g[name], `${name} unstaged`).to.be.a("string");
    }
    expect(g.RESOURCE_ENERGY).to.equal("energy");
  });
});
