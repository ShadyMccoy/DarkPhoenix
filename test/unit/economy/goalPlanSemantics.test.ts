/**
 * Spec 18 acceptance test 3 (P2) - profile semantics ASSERTED ON THE PLAN:
 * a goal is only real if it moves `ColonyPlan.sinks`. Sinks here are priced
 * exactly the way the live adapter prices them - anchors from compileGoal,
 * controllers through controllerValue's remaining-progress band - so these
 * fixtures exercise the same value path as a live solve, minus the Game.
 *
 * The fixture is SUPPLY-BOUND (sink demand exceeds the one source's rate),
 * so allocation order IS the value order: a profile that reorders two sink
 * classes must visibly move energy between them, while spawn overhead (I1,
 * strictly top under every profile) holds byte-for-byte.
 */

import { expect } from "chai";
import { ColonyProblem, planColony } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";
import { SinkValuation, compileGoal } from "../../../src/economy/goals";
import { controllerValue } from "../../../src/economy/flowAdapter";

const ROOM = "W1N1";
const at = (x: number, y = 25): Position => ({ x, y, roomName: ROOM });
const dist = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/**
 * One spawn, one 10 e/t source, and three sinks wanting 14 e/t total: spawn
 * overhead (capacity 2), an ordinary construction site, and a controller
 * priced by `ctrlRemaining` through the SAME band function the adapter uses.
 * Whoever the valuation ranks higher between site and controller gets filled
 * first; the loser takes the residual.
 */
function competitionWorld(v: SinkValuation, ctrlRemaining: number): ColonyProblem {
  return {
    spawns: [{ id: "spawn1", pos: at(0) }],
    sources: [{ id: "src1", nodeId: "n1", pos: at(10), rate: 10, maxMiners: 1 }],
    sinks: [
      { id: "spawn-sink", kind: "spawn", pos: at(0), value: v.spawn, capacity: 2 },
      { id: "site", kind: "construction", pos: at(30), value: v.construction, capacity: 6 },
      { id: "ctrl", kind: "controller", pos: at(30, 26), value: controllerValue(ctrlRemaining, v), capacity: 6 }
    ],
    dist
  };
}

function alloc(problem: ColonyProblem, sinkId: string): number {
  const s = planColony(problem).sinks.find(k => k.sinkId === sinkId);
  return s?.allocated ?? 0;
}

describe("economy/goals - profile semantics on ColonyPlan.sinks (spec 18 test 3)", () => {
  it("foundRoom shifts allocation to the build set even against a nearly-done level", () => {
    const NEARLY_DONE = 1_000; // remaining progress: prices at ~74 under default - above construction's 70
    const def = compileGoal();
    const found = compileGoal({ blend: { foundRoom: 1 } });

    // Under DEFAULT the almost-done controller outranks ordinary construction...
    expect(controllerValue(NEARLY_DONE, def)).to.be.greaterThan(def.construction);
    expect(alloc(competitionWorld(def, NEARLY_DONE), "ctrl")).to.be.greaterThan(
      alloc(competitionWorld(def, NEARLY_DONE), "site")
    );

    // ...under foundRoom the build set wins that same contest on the PLAN
    expect(alloc(competitionWorld(found, NEARLY_DONE), "site")).to.be.greaterThan(
      alloc(competitionWorld(def, NEARLY_DONE), "site")
    );
    expect(alloc(competitionWorld(found, NEARLY_DONE), "ctrl")).to.be.lessThan(
      alloc(competitionWorld(def, NEARLY_DONE), "ctrl")
    );

    // ...while spawn overhead holds byte-for-byte (I1 under every profile)
    expect(alloc(competitionWorld(found, NEARLY_DONE), "spawn-sink")).to.equal(
      alloc(competitionWorld(def, NEARLY_DONE), "spawn-sink")
    );
  });

  it("growController holds the band at its ceiling: the mid-level grind outranks construction", () => {
    const MID_GRIND = 45_000; // RCL2-scale remaining: ~60 under default - construction (70) wins there
    const def = compileGoal();
    const grow = compileGoal({ blend: { growController: 1 } });

    // Default at the mid-grind: build supersedes upgrade (the pinned doctrine)
    expect(controllerValue(MID_GRIND, def)).to.be.lessThan(def.construction);
    expect(alloc(competitionWorld(def, MID_GRIND), "site")).to.be.greaterThan(
      alloc(competitionWorld(def, MID_GRIND), "ctrl")
    );

    // growController lifts the same controller above ordinary construction
    expect(controllerValue(MID_GRIND, grow)).to.be.greaterThan(grow.construction);
    expect(alloc(competitionWorld(grow, MID_GRIND), "ctrl")).to.be.greaterThan(
      alloc(competitionWorld(grow, MID_GRIND), "site")
    );
  });
});
