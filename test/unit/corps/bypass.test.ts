/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals } from "../mock";
import { canForceThrough, isYielding } from "../../../src/corps/movement";

/**
 * isYielding is the GENTLE subset of the swap rule: a parked upgrader sitting on
 * its own assigned tile has no move intent and walks straight back next tick, so
 * displacing it costs nothing. (The broader force-swap gate is canForceThrough.)
 */
describe("isYielding (gentle swap subset)", () => {
  beforeEach(() => setupGlobals());

  const make = (over: any) => ({
    my: true,
    pos: { x: 10, y: 10 },
    memory: { workType: "upgrade", upgradeSpot: { x: 10, y: 10 } },
    ...over
  });

  it("yields for a parked upgrader on its own upgrade tile", () => {
    expect(isYielding(make({}))).to.equal(true);
  });

  it("does not yield for an upgrader not yet on its assigned tile", () => {
    expect(isYielding(make({ pos: { x: 11, y: 10 } }))).to.equal(false);
  });

  it("does not yield for an upgrader with no assigned tile", () => {
    expect(isYielding(make({ memory: { workType: "upgrade" } }))).to.equal(false);
  });

  it("does not yield for a hauler (different workType)", () => {
    expect(isYielding(make({ memory: { workType: "haul", upgradeSpot: { x: 10, y: 10 } } }))).to.equal(false);
  });

  it("does not yield for an enemy creep on its tile", () => {
    expect(isYielding(make({ my: false }))).to.equal(false);
  });
});

/**
 * canForceThrough is the force-swap gate: a boxed-in creep may push ANY of our own
 * movable creeps aside to escape (this is the fix for a hauler deadlocked on its
 * drop-off tile, ringed by non-yielding siblings, that just picks up and drops in
 * place). Only foreign creeps (uncontrollable) and physically-stuck ones (spawning
 * or fatigued - their tile would never clear) are off-limits.
 */
describe("canForceThrough (force-swap gate)", () => {
  beforeEach(() => setupGlobals());

  const make = (over: any) => ({ my: true, spawning: false, fatigue: 0, ...over });

  it("forces through a parked upgrader (the gentle case is still allowed)", () => {
    expect(canForceThrough(make({}))).to.equal(true);
  });

  it("forces through a NON-yielding sibling hauler (the deadlock fix)", () => {
    // A hauler schooling on the same drop spot is not 'yielding', but it is ours
    // and can move - so a boxed-in creep can swap through it and get free.
    expect(canForceThrough(make({}))).to.equal(true);
  });

  it("does not force through a foreign creep (cannot command it to move)", () => {
    expect(canForceThrough(make({ my: false }))).to.equal(false);
  });

  it("does not force through a spawning creep (welded into its spawn)", () => {
    expect(canForceThrough(make({ spawning: true }))).to.equal(false);
  });

  it("does not force through a fatigued creep (its tile would never clear)", () => {
    expect(canForceThrough(make({ fatigue: 2 }))).to.equal(false);
  });

  it("treats an undefined fatigue as movable", () => {
    expect(canForceThrough({ my: true } as any)).to.equal(true);
  });
});
