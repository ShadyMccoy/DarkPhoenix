/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals, Game, RawMemory } from "../mock";
import { Telemetry } from "../../../src/telemetry/Telemetry";

/**
 * `creepCargo` - the last NAMED gap in the balance sheet (core v38).
 *
 * The energy account balances by construction, so its RESIDUAL is the point.
 * At t72874433 it read **+4.97 e/t (4% of gross mining, UNDER-attributed)**.
 * One window later, t72875067: **-21.50 e/t (19% OVER-attributed)** - a 26.5
 * e/t swing, and the wrong sign entirely. More energy left the colony's books
 * than entered them, which no leak can produce; only a mis-measurement can.
 *
 * Every stock the capture DOES measure was checked and none of them explains
 * it: source-mouth buffers moved 1,156e over the window, the owned room's
 * containers 889e, controller stock 205e, spawn/extension fill 738e - about
 * 4.7 e/t between them against a 21.50 e/t gap. Spawn spend, pile decay,
 * repair and tombstones all reconcile to their own cumulative counters to the
 * decimal, and controller progress is `gcl.progress` measured.
 *
 * What is NOT measured is stated in the balance sheet's own text: *"creep cargo
 * not measured"*. The fleet carried **408 CARRY parts** at the base capture and
 * 386 at the close - up to ~20,400e of energy that can be in flight at either
 * end, against an 11,800e discrepancy. A window in which the fleet happens to
 * be loaded at one capture and empty at the other moves exactly this much
 * energy across the books with no line to carry it.
 *
 * That is a HYPOTHESIS, and this field is what tests it rather than argues it:
 * with cargo published at both ends, the residual either closes or it does not,
 * and the next cycle reads which. The balance sheet's floor also stops
 * understating by a term it already names.
 */
describe("core segment: creepCargo - the balance sheet's last named gap (v38)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).RawMemory = RawMemory;
    RawMemory.segments = {};
    Game.time = 100;
    Game.rooms = {} as any;
    (Game as any).gcl = { level: 1, progress: 0, progressTotal: 100 };
    (Game as any).shard = { name: "shard1" };
    (Game as any).constructionSites = {};
    (global as any).RESOURCE_ENERGY = "energy";
  });

  /** A creep holding `energy` (and optionally some non-energy cargo). */
  const mkCreep = (name: string, energy: number, other = 0): any => ({
    name,
    my: true,
    store: { energy, mineral: other },
    body: [],
    memory: {}
  });

  const core = (): any => {
    new Telemetry().update(undefined, [], undefined);
    return JSON.parse(RawMemory.segments[0]);
  };

  it("sums the ENERGY every creep is carrying", () => {
    Game.creeps = {
      hauler1: mkCreep("hauler1", 1200),
      hauler2: mkCreep("hauler2", 800),
      miner1: mkCreep("miner1", 0)
    } as any;
    const c = core();
    expect(c.version, "a new field is a schema change").to.equal(40); // v40: controllerAllocations publish export
    expect(c.creepCargo).to.equal(2000);
  });

  it("counts ENERGY only - a mineral hold is not spendable energy", () => {
    Game.creeps = { h: mkCreep("h", 500, 900) } as any;
    expect(core().creepCargo).to.equal(500);
  });

  it("emits 0 when the fleet is empty-handed - that is a MEASUREMENT, not an absence", () => {
    // The whole point is closing a gap in a balancing identity. An omitted key
    // would put the reader back where they started: unable to tell "the fleet
    // carried nothing" from "nobody looked".
    Game.creeps = { a: mkCreep("a", 0), b: mkCreep("b", 0) } as any;
    const c = core();
    expect(c.creepCargo).to.equal(0);
    expect(Object.prototype.hasOwnProperty.call(c, "creepCargo")).to.equal(true);
  });

  it("emits 0 for an empty roster rather than fabricating a fleet", () => {
    Game.creeps = {} as any;
    expect(core().creepCargo).to.equal(0);
  });

  it("survives a creep with no store wired (partial mocks) without dropping the field", () => {
    Game.creeps = { a: { name: "a", my: true, body: [], memory: {} } as any, b: mkCreep("b", 300) } as any;
    expect(core().creepCargo).to.equal(300);
  });
});
