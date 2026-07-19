import { expect } from "chai";
import { assignTowerFire } from "../../../src/execution/TowerRunner";

/**
 * Spec 07 v2 — multi-tower focus-fire against pre-emptive healing.
 *
 * The mechanic (ported from bonzAI secret sauce): a lone healer can cancel one
 * tower's damage on one creep, so spreading fire thin nets zero kills. Instead
 * the towers play a pursuit game keyed on tick-over-tick HP:
 *   - hostiles that took NET damage last tick (hits dropped) are UNCOVERED by
 *     the healer → collapse fire on them (lowest HP first);
 *   - when nobody is dropping but some are wounded, keep pressure on the wounded;
 *   - when everyone is at full (first contact / heals topping all), PROBE by
 *     spreading across the lowest-HP creeps to force a wound.
 * As the healer covers one target per tick, the uncovered set narrows 3→2→1 and
 * fire collapses onto the survivor. Deterministic: ties break to the lower id.
 */
describe("assignTowerFire (spec 07 focus-fire game)", () => {
  const H = (id: string, hits: number, hitsMax = 100) => ({ id, hits, hitsMax });

  it("holds fire (all null) when there are no hostiles", () => {
    expect(assignTowerFire([], 3, {})).to.deep.equal([null, null, null]);
  });

  it("returns an empty plan when no towers are ready", () => {
    expect(assignTowerFire([H("a", 100)], 0, {})).to.deep.equal([]);
  });

  it("PROBES first contact: spreads towers across distinct full hostiles", () => {
    // Three full hostiles, no prior HP → each tower takes a distinct target,
    // lowest-HP first (all equal here → id order a,b,c).
    const plan = assignTowerFire([H("a", 100), H("b", 100), H("c", 100)], 3, {});
    expect(plan).to.deep.equal([0, 1, 2]);
  });

  it("COLLAPSES on the one creep the healer isn't covering", () => {
    // Last tick a,b,c were full (100). This tick the healer topped b back up
    // (still 100) but a and c dropped → they are uncovered. Two dropping, three
    // towers → the weakest (lower HP) soaks the surplus.
    const prev = { a: 100, b: 100, c: 100 };
    const plan = assignTowerFire([H("a", 40), H("b", 100), H("c", 70)], 3, prev);
    // pool = {a:40, c:70} sorted asc → a,c ; round-robin over 3 towers → a,c,a
    expect(plan).to.deep.equal([0, 2, 0]);
    // b (covered/full) is never targeted.
    expect(plan).to.not.include(1);
  });

  it("narrows to a single survivor and fires everything at it", () => {
    // Only c is still dropping (a recovered since last tick, b full) → all towers
    // collapse on c.
    const prev = { a: 30, b: 100, c: 60 };
    const plan = assignTowerFire([H("a", 55), H("b", 100), H("c", 40)], 3, prev);
    expect(plan).to.deep.equal([2, 2, 2]);
  });

  it("keeps pressure on the wounded when nobody dropped this tick", () => {
    // Nobody's HP fell vs last tick (heals held the line everywhere), but a is
    // still below max → fire the wounded one, not the full b/c.
    const prev = { a: 50, b: 100, c: 100 };
    const plan = assignTowerFire([H("a", 50), H("b", 100), H("c", 100)], 2, prev);
    expect(plan).to.deep.equal([0, 0]);
  });

  it("treats a newly-arrived hostile (no history) as fair game to probe", () => {
    // a is covered (full, was full); d just walked in with no prior HP → probe d.
    const prev = { a: 100 };
    const plan = assignTowerFire([H("a", 100), H("d", 100)], 1, prev);
    expect(plan).to.deep.equal([1]);
  });

  it("is deterministic: equal HP breaks ties to the lower id", () => {
    const plan = assignTowerFire([H("z", 50), H("a", 50)], 1, { z: 60, a: 60 });
    // both dropping, equal hits → lower id "a" (index 1) wins.
    expect(plan).to.deep.equal([1]);
  });
});
