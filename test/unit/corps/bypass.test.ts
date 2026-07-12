/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { setupGlobals } from "../mock";
import { canForceThrough, isYielding, mayDisplace } from "../../../src/corps/movement";

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
 * canForceThrough is the PHYSICAL gate only: our creep, not spawning, not
 * fatigued - one we can command and that can actually step. Whether displacing it
 * is also allowed is mayDisplace (traveling or yielding).
 */
describe("canForceThrough (physical command gate)", () => {
  beforeEach(() => setupGlobals());

  const make = (over: any) => ({ my: true, spawning: false, fatigue: 0, ...over });

  it("passes any of our own movable creeps", () => {
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

/**
 * mayDisplace is the FULL swap rule: only a yielding parked upgrader may be
 * ordered into a mutual swap, because it issues no move intent of its own - the
 * command sticks, and it walks straight back next tick. Commanding a MOVING creep
 * overwrites the step it chose (the park-settle counter-command livelock: two
 * upgraders dragging each other between the same two tiles forever); a creep
 * SEATED on its post loses real work when shoved (the #97 regression: park-settle,
 * both ring cells, and all three plan-fidelity floors went red). Both are routed
 * around instead.
 */
describe("mayDisplace (full swap rule)", () => {
  beforeEach(() => setupGlobals());

  const make = (over: any) => ({
    my: true,
    spawning: false,
    fatigue: 0,
    pos: { x: 10, y: 10 },
    memory: { workType: "haul" },
    ...over
  });

  it("commands a yielding parked upgrader (the ring thread)", () => {
    const upg = make({ memory: { workType: "upgrade", upgradeSpot: { x: 10, y: 10 } } });
    expect(mayDisplace(upg)).to.equal(true);
  });

  it("never commands a non-yielding sibling hauler (route around it instead)", () => {
    expect(mayDisplace(make({}))).to.equal(false);
  });

  it("never commands a sibling seated on a non-upgrade post (e.g. a miner)", () => {
    expect(mayDisplace(make({ memory: { workType: "harvest" } }))).to.equal(false);
  });

  it("never commands an upgrader still walking to its tile (it has its own intent)", () => {
    const walking = make({ memory: { workType: "upgrade", upgradeSpot: { x: 11, y: 10 } } });
    expect(mayDisplace(walking)).to.equal(false);
  });

  it("never commands what cannot physically move, yielding or not", () => {
    const upg = (over: any) => make({ memory: { workType: "upgrade", upgradeSpot: { x: 10, y: 10 } }, ...over });
    expect(mayDisplace(upg({ my: false }))).to.equal(false);
    expect(mayDisplace(upg({ fatigue: 3 }))).to.equal(false);
    expect(mayDisplace(upg({ spawning: true }))).to.equal(false);
  });
});
