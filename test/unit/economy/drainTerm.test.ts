import { expect } from "chai";
import {
  planColony,
  ColonyProblem,
  PlannerSource,
  PlannerSink,
  PlannerSpawn
} from "../../../src/economy/CorpPlanner";
import { bufferDrainCarry, carryPartsFor, CREEP_LIFETIME } from "../../../src/economy/primitives";
import { Position } from "../../../src/types/Position";

/**
 * THE PLAN CARRIES THE DRAIN TERM (phase 1 of the income-statement program;
 * the E6/X6 seam).
 *
 * The corp's haulCarryNeeded sizes the fleet to sustained inflow PLUS the ONE
 * drain law (staged/CREEP_LIFETIME - the same stock law the bank surplus and
 * consumer sizing use), so a standing pile self-clears over one generation.
 * The PLAN's route carry priced sustained inflow only: X6 had to be judged
 * against "the corp's OWN carryNeeded stamp (rest against the plan route,
 * drain-blind)", and ~1.0 e/t of real fleet stood permanently outside the
 * budget. The planner now receives `staged` per source through the adapter -
 * the same actuals->plan seam as swampFraction/paved - and prices the drain
 * into the route, so plan and corp size from the SAME two terms.
 *
 * The drain formula itself lives in primitives (bufferDrainCarry) and BOTH
 * sides call it - the corp's arithmetic and the plan's must be the one home,
 * or X6 returns wearing a new costume.
 */
const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const spawn = (id: string, x: number): PlannerSpawn => ({ id, pos: at(x) });
const sink = (id: string, kind: PlannerSink["kind"], x: number, value: number, capacity: number): PlannerSink => ({
  id,
  kind,
  pos: at(x),
  value,
  capacity
});

function world(sourceOver: Partial<PlannerSource> = {}): ColonyProblem {
  const src: PlannerSource = {
    id: "srcA",
    nodeId: "node-srcA",
    pos: at(20),
    rate: 10,
    maxMiners: 1,
    ...sourceOver
  };
  return {
    dist: manhattan,
    spawns: [spawn("S", 0)],
    sources: [src],
    sinks: [sink("store", "storage", 0, 1, 1000)]
  };
}

describe("the plan prices the buffer-drain term (one drain law, both sides)", () => {
  it("bufferDrainCarry IS the corp's arithmetic: staged/2/CREEP_LIFETIME over the route (the owner's midpoint law, 2026-08-09)", () => {
    // The /2 is the temporal-midpoint argument scavengeRate already uses
    // (amount/2): half the standing pile over one generation is the honest
    // average of a stock that decays while it drains. Owner formula, spec 55
    // SS4, adopted with the demand-seam go-ahead.
    expect(bufferDrainCarry(3000, 36)).to.be.closeTo(carryPartsFor(3000 / 2 / CREEP_LIFETIME, 36), 1e-9);
    expect(bufferDrainCarry(0, 36)).to.equal(0);
    expect(bufferDrainCarry(-50, 36)).to.equal(0);
  });

  it("adds drain carry to a staged mouth's route", () => {
    const dry = planColony(world());
    const staged = planColony(world({ staged: 3000 }));
    const dryCarry = dry.haulers.reduce((s, h) => s + h.carryParts, 0);
    const stagedCarry = staged.haulers.reduce((s, h) => s + h.carryParts, 0);
    expect(dryCarry, "the unstaged world routes the source").to.be.greaterThan(0);
    expect(stagedCarry - dryCarry, "the staged world carries the drain on top").to.be.closeTo(
      bufferDrainCarry(3000, 20),
      1.0 // routing may quantize per-route; the drain must be present, not exact to the part
    );
  });

  it("prices the drain's spawn parts too - the fleet the account will meet at the spawn", () => {
    const dry = planColony(world());
    const staged = planColony(world({ staged: 3000 }));
    const load = (p: ReturnType<typeof planColony>): number => p.haulers.reduce((s, h) => s + h.spawnParts, 0);
    expect(load(staged), "drain carry costs spawn parts").to.be.greaterThan(load(dry));
  });

  it("is bit-identical to the old sizing when nothing is staged (nothing moves on clean mouths)", () => {
    const a = planColony(world());
    const b = planColony(world({ staged: 0 }));
    expect(a.haulers.map(h => h.carryParts)).to.deep.equal(b.haulers.map(h => h.carryParts));
  });
});
