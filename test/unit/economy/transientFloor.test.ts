import { expect } from "chai";
import {
  planColony,
  ColonyProblem,
  PlannerSink,
  PlannerSource,
  PlannerSpawn
} from "../../../src/economy/CorpPlanner";
import { effectiveLife, scavengeFloorParts } from "../../../src/economy/primitives";
import { Position } from "../../../src/types/Position";

/**
 * TRANSIENT ROUTES ARE PRICED AT THE BODY THEY ELICIT (phase 1; the
 * "transient-route haulers (unbudgeted)" line).
 *
 * A scavenge stock's route often computes a fraction of a CARRY (a 0.1 e/t
 * pile at distance 8 wants 0.8 carry) - but the fleet NEVER fields a fraction
 * of a hauler: CarryCorp floors every body at HAULER_MIN_CARRY (3 CARRY, the
 * runt rule), so the real spawn cost of serving ANY transient route is at
 * least the floor body amortized over its life. The plan priced the fraction
 * (~0.0002 p/t colony-wide) while the fleet spent ~0.040 p/t - 2.0 e/t of
 * measured spend on routes the account called unbudgeted. Price the floor:
 * max(computed, floor-body/life) per transient route, in primitives, read by
 * the planner - so funding a scavenge route ADMITS the body it will actually
 * buy.
 */
const ROOM = "W0N0";
const at = (x: number, y = 0): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

const world = (rate: number): ColonyProblem => {
  const spawn: PlannerSpawn = { id: "S", pos: at(0) };
  const stock: PlannerSource = {
    id: "pile",
    nodeId: "node-pile",
    pos: at(8),
    rate,
    maxMiners: 0,
    transient: true
  };
  const store: PlannerSink = { id: "store", kind: "storage", pos: at(0), value: 1, capacity: 1000 };
  return { dist: manhattan, spawns: [spawn], sources: [stock], sinks: [store] };
};

describe("transient routes price the floor body (the unbudgeted 2 e/t)", () => {
  it("a tiny stock's route carries at least the floor body's amortized parts", () => {
    const plan = planColony(world(0.5));
    const route = plan.haulers.find(h => h.sourceId === "pile");
    expect(route, "the stock is routed").to.not.equal(undefined);
    expect(route!.spawnParts).to.be.at.least(
      scavengeFloorParts(8) - 1e-9,
      "a fractional-carry route still buys a whole floor hauler"
    );
  });

  it("scavengeFloorParts is the floor BODY over the route's effective life", () => {
    // 3 CARRY + 3 MOVE (the 1:1 runt floor) amortized.
    expect(scavengeFloorParts(8)).to.be.closeTo(6 / effectiveLife(8), 1e-9);
  });

  it("a big stock's route prices ABOVE the floor - the floor never caps real work", () => {
    const plan = planColony(world(50));
    const route = plan.haulers.find(h => h.sourceId === "pile")!;
    expect(route.spawnParts).to.be.greaterThan(scavengeFloorParts(8));
  });
});
