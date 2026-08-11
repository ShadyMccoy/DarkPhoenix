/**
 * Goals (spec 18 P1, acceptance tests 1-2): the default compiles to today's
 * measured ladder byte-for-byte, every declared profile satisfies the
 * incident-derived invariants, and NO expressible blend can violate them
 * (convexity, property-swept with a deterministic LCG).
 */

import { expect } from "chai";
import {
  DEFAULT_VALUATION,
  GOAL_PROFILES,
  Goal,
  assertValuationInvariants,
  compileGoal
} from "../../../src/economy/goals";

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("economy/goals - the objective as input (spec 18 P1)", () => {
  it("no goal compiles to the DEFAULT ladder exactly (the pinned behavior)", () => {
    expect(compileGoal()).to.deep.equal(DEFAULT_VALUATION);
    expect(compileGoal({ blend: {} })).to.deep.equal(DEFAULT_VALUATION);
    expect(compileGoal({ blend: { default: 1 } })).to.deep.equal(DEFAULT_VALUATION);
    // and the default anchors ARE the measured ladder
    expect(DEFAULT_VALUATION).to.deep.equal({
      spawn: 100,
      newSpawnSite: 85,
      controllerMax: 80,
      construction: 70,
      controllerStatic: 50,
      controllerMin: 40,
      storage: 1
    });
  });

  it("every declared profile satisfies the ladder invariants", () => {
    for (const name of Object.keys(GOAL_PROFILES)) {
      expect(() => assertValuationInvariants(GOAL_PROFILES[name]), name).to.not.throw();
    }
  });

  it("the DEFAULT ladder's rungs are STRICTLY ordered, rung by rung (spec 61 row 7 - the founding-incident door)", () => {
    // The trap (CLAUDE.md "Economics rules"): sink values are a strict ladder -
    // spawn > new-spawn-site > controller ceiling > construction > controller
    // static > controller floor > storage. Nudging ONE value past a neighbour
    // in isolation zeroed colony-wide construction (the 90-vs-85 founding
    // incident: new-spawn-site briefly priced ABOVE where the ladder put it,
    // and every ordinary site starved). This pin asserts the INEQUALITIES, not
    // the constants - retuning a value is legal, inverting the ladder is not.
    // Named profiles may legally reorder middle rungs (foundRoom lifts
    // construction past the controller ceiling); the DEFAULT ladder may not.
    const v = DEFAULT_VALUATION;
    const incident =
      "the 90-vs-85 founding incident: one nudged sink value inverted a rung and zeroed " +
      "colony-wide construction - never retune one value in isolation (CLAUDE.md, Economics rules)";
    const ladder: [string, number][] = [
      ["spawn", v.spawn],
      ["newSpawnSite", v.newSpawnSite],
      ["controllerMax", v.controllerMax],
      ["construction", v.construction],
      ["controllerStatic", v.controllerStatic],
      ["controllerMin", v.controllerMin],
      ["storage", v.storage]
    ];
    for (let i = 1; i < ladder.length; i++) {
      const [upper, upperVal] = ladder[i - 1];
      const [lower, lowerVal] = ladder[i];
      expect(upperVal, `${upper} (${upperVal}) must STRICTLY outrank ${lower} (${lowerVal}) - ${incident}`).to.be.greaterThan(lowerVal);
    }
  });

  it("unknown profile names are ignored (falls back to default, never throws)", () => {
    expect(compileGoal({ blend: { doesNotExist: 1 } })).to.deep.equal(DEFAULT_VALUATION);
    expect(compileGoal({ blend: { doesNotExist: 3, growController: 0 } })).to.deep.equal(DEFAULT_VALUATION);
  });

  it("PROPERTY: no random blend of declared profiles can violate an invariant", () => {
    const rnd = lcg(0x5eed5eed);
    const names = Object.keys(GOAL_PROFILES);
    for (let i = 0; i < 500; i++) {
      const blend: Goal["blend"] = {};
      for (const name of names) {
        if (rnd() < 0.7) blend[name] = rnd() * 10;
      }
      const v = compileGoal({ blend });
      expect(() => assertValuationInvariants(v), JSON.stringify(blend)).to.not.throw();
    }
  });

  it("growController moves the bands, never the orderings", () => {
    const v = compileGoal({ blend: { growController: 1 } });
    expect(v.controllerMax).to.be.greaterThan(DEFAULT_VALUATION.controllerMax);
    expect(v.construction).to.be.lessThan(DEFAULT_VALUATION.construction);
    // the invariants that survive every goal:
    expect(v.spawn).to.be.greaterThan(v.newSpawnSite);
    expect(v.newSpawnSite).to.be.greaterThan(v.construction);
    expect(v.storage).to.be.lessThan(v.controllerMin);
  });

  it("foundRoom (P2) reverses the ceiling: construction outranks even a nearly-done level", () => {
    const v = compileGoal({ blend: { foundRoom: 1 } });
    // under DEFAULT a controller at its ceiling (80) outranks construction
    // (70); a founding push flips that class ordering wholesale
    expect(DEFAULT_VALUATION.controllerMax).to.be.greaterThan(DEFAULT_VALUATION.construction);
    expect(v.construction).to.be.greaterThan(v.controllerMax);
    // the founding site closes on spawn overhead but never touches I1
    expect(v.newSpawnSite).to.be.greaterThan(DEFAULT_VALUATION.newSpawnSite);
    expect(v.spawn).to.be.greaterThan(v.newSpawnSite);
  });

  it("warchest (P2) lowers every consumer band; the frame (spawn/founding/storage) holds", () => {
    const v = compileGoal({ blend: { warchest: 1 } });
    // I4 pins storage strictly bottom - banking can never be a chased sink -
    // so the profile banks by pricing marginal CONSUMERS out instead
    expect(v.controllerMax).to.be.lessThan(DEFAULT_VALUATION.controllerMax);
    expect(v.construction).to.be.lessThan(DEFAULT_VALUATION.construction);
    expect(v.controllerStatic).to.be.lessThan(DEFAULT_VALUATION.controllerStatic);
    expect(v.spawn).to.equal(DEFAULT_VALUATION.spawn);
    expect(v.newSpawnSite).to.equal(DEFAULT_VALUATION.newSpawnSite);
    expect(v.storage).to.equal(DEFAULT_VALUATION.storage);
  });
});
