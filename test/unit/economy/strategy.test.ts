/**
 * The strategic searcher v0 (spec 18 P1, acceptance test 4 thin + the
 * day-one positive proof): on a world where the nearest-spawn greedy drops a
 * profitable source for budget while another spawn has slack, the searcher
 * ADOPTS the reassignment and the plan's value strictly rises; on a
 * status-quo-optimal world it adopts nothing and the plan is bit-identical
 * to the plain solve (the pin that reconciles "live from day one" with the
 * golden master).
 */

import { expect } from "chai";
import { ColonyProblem, planColony } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";
import { searchStructure } from "../../../src/economy/strategy";

const ROOM = "W1N1";
const at = (x: number, y = 25): Position => ({ x, y, roomName: ROOM });

/** Manhattan distance keeps the fixtures readable. */
const dist = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * The organism fixture, minimal form: spawn A sits beside THREE sources -
 * more than its mining build-time budget funds - while spawn B (farther from
 * all of them) has an empty budget. The greedy nearest-spawn assignment
 * binds all three to A and drops one over-budget; the searcher's pin lets B
 * work the dropped source. A high-capacity controller absorbs the extra
 * energy so the reassignment's value gain is real.
 */
function overloadedWorld(): ColonyProblem {
  // Distances are the budget currency: spawnPartsFor(10, ~150) ≈ 0.09-0.10
  // parts/tick against a 0.2 budget, so A funds two of its three sources and
  // drops the third over-budget. B sits beyond every source (never nearest)
  // but close enough (d≈170) that working the dropped source from B is
  // profitable - the exact blind spot of nearest-spawn assignment.
  return {
    spawns: [
      { id: "spawnA", pos: at(0) },
      { id: "spawnB", pos: at(330) }
    ],
    sources: [
      { id: "src1", nodeId: "n1", pos: at(140), rate: 10, maxMiners: 1 },
      { id: "src2", nodeId: "n2", pos: at(150), rate: 10, maxMiners: 1 },
      { id: "src3", nodeId: "n3", pos: at(160), rate: 10, maxMiners: 1 }
    ],
    sinks: [
      { id: "spawn-sink", kind: "spawn", pos: at(0), value: 100, capacity: 6 },
      { id: "ctrl", kind: "controller", pos: at(100), value: 50, capacity: 100, reserve: 2 }
    ],
    dist
  };
}

/** One spawn, one source: nothing to restructure. */
function statusQuoWorld(): ColonyProblem {
  return {
    spawns: [{ id: "spawn1", pos: at(10) }],
    sources: [{ id: "src1", nodeId: "n1", pos: at(20), rate: 10, maxMiners: 1 }],
    sinks: [
      { id: "spawn-sink", kind: "spawn", pos: at(10), value: 100, capacity: 4 },
      { id: "ctrl", kind: "controller", pos: at(5), value: 50, capacity: 100, reserve: 2 }
    ],
    dist
  };
}

describe("economy/strategy - the supply-chain search v0 (spec 18 P1)", () => {
  it("the day-one blind spot is DISSOLVED by global admission - the searcher rightly stays quiet (t72780703)", () => {
    // HISTORY: this test was the searcher's POSITIVE PROOF - per-spawn
    // admission budgets dropped spawn A's third source over-budget, and only
    // the searcher's pin (work it from B, d170 > d160 but FUNDED) recovered
    // it. GLOBAL admission (t72780703) retires that blind spot at the base
    // solve: the shared tranche funds all three from A - the FIRST-best
    // answer, strictly better than the searcher's second-best pin (d160 from
    // A beats d170 from B). Under a shared budget, nearest-spawn assignment
    // minimizes every source's parts, so the budget-partition move class is
    // gone; the searcher's harness stays for the spec-32 structure moves
    // (room-level, links) that remain genuinely invisible to the base solve.
    const problem = overloadedWorld();
    const baseline = planColony(problem);
    expect(
      baseline.sourceVerdicts.filter(v => v.verdict === "over-budget").length,
      "global admission funds all three sources - the old overload is gone"
    ).to.equal(0);
    expect(baseline.miners.length).to.equal(3);
    expect(baseline.miners.every(m => m.spawnId === "spawnA"), "all worked from the NEAREST spawn").to.equal(true);

    const result = searchStructure(problem);
    expect(result.adopted, "nothing left to restructure - the base solve got there first").to.deep.equal([]);
    expect(result.plan.valueDelivered).to.be.at.least(baseline.valueDelivered - 1e-9);
  });

  it("STATUS QUO: adopts nothing and returns the plain solve bit-identical (the pin)", () => {
    const problem = statusQuoWorld();
    const result = searchStructure(problem);
    expect(result.adopted).to.deep.equal([]);
    expect(result.evaluations).to.equal(1);
    expect(result.plan).to.deep.equal(planColony(problem));
    expect(result.problem).to.equal(problem); // untouched, not even copied
  });

  it("DETERMINISM: identical input yields identical adoption and plan", () => {
    const a = searchStructure(overloadedWorld());
    const b = searchStructure(overloadedWorld());
    expect(a.adopted).to.deep.equal(b.adopted);
    expect(a.plan).to.deep.equal(b.plan);
    expect(a.evaluations).to.equal(b.evaluations);
  });

  it("BUDGETED: never exceeds the evaluation cap", () => {
    const result = searchStructure(overloadedWorld());
    expect(result.evaluations).to.be.at.most(8);
  });
});
