import { assert } from "chai";
import {
  planEconomy,
  PlannerInput,
  PlannerSink,
  PlannerSource,
  CorpSpec,
} from "../../../src/flow/EconomyPlanner";
import { Position } from "../../../src/types/Position";

/** Place things on a line so distance is just |dx| - keeps the math obvious. */
function at(x: number): Position {
  return { x, y: 25, roomName: "W0N0" };
}
const lineDist = (a: Position, b: Position): number => Math.abs(a.x - b.x);

function source(id: string, x: number, supply = 10): PlannerSource {
  return { id, supply, pos: at(x) };
}
function sink(id: string, kind: PlannerSink["kind"], value: number, capacity: number, x: number): PlannerSink {
  return { id, kind, value, capacity, pos: at(x) };
}
function plan(sources: PlannerSource[], sinks: PlannerSink[]): ReturnType<typeof planEconomy> {
  const input: PlannerInput = { sources, sinks, spawnId: "S", dist: lineDist };
  return planEconomy(input);
}
function corp<T extends CorpSpec["kind"]>(corps: CorpSpec[], kind: T): Extract<CorpSpec, { kind: T }>[] {
  return corps.filter((c) => c.kind === kind) as Extract<CorpSpec, { kind: T }>[];
}

describe("EconomyPlanner", () => {
  it("routes leftover energy to the controller with no spillover rule", () => {
    // Source makes 10; spawn overhead claims 3 (highest value); controller is
    // low value but high capacity. Nothing says "spill to controller" - it just
    // mops up the remaining 7 because it is the only sink left with capacity.
    const { corps } = plan(
      [source("src", 25)],
      [
        sink("spawn", "spawn", 100, 3, 25),
        sink("ctrl", "controller", 50, 100, 25),
      ]
    );
    const upgrade = corp(corps, "upgrade");
    assert.lengthOf(upgrade, 1);
    assert.equal(upgrade[0].work, 7, "controller absorbs the 7 left after spawn's 3");
    assert.equal(corp(corps, "mine")[0].work, 5, "5 WORK harvests the full 10/tick");
  });

  it("fills high-value construction to capacity, then spills the rest to upgrading", () => {
    const { corps } = plan(
      [source("src", 25)],
      [
        sink("spawn", "spawn", 100, 3, 25),
        sink("site", "construction", 70, 5, 25), // capacity = one builder's appetite
        sink("ctrl", "controller", 50, 100, 25),
      ]
    );
    // spawn 3, construction 5 (capped), controller 2 (emergent leftover).
    assert.equal(corp(corps, "build")[0].work, 1, "5 energy / 5-per-WORK = 1 build WORK");
    assert.equal(corp(corps, "upgrade")[0].work, 2, "the remaining 2 lands on the controller");
  });

  it("lets value/capacity alone change the routing - no code change", () => {
    // Same world, but construction can now absorb everything (more builders):
    // it supersedes upgrading entirely and the controller gets nothing.
    const { corps } = plan(
      [source("src", 25)],
      [
        sink("spawn", "spawn", 100, 3, 25),
        sink("site", "construction", 70, 10, 25),
        sink("ctrl", "controller", 50, 100, 25),
      ]
    );
    assert.equal(corp(corps, "build")[0].work, 2, "7 energy absorbed -> 2 build WORK");
    assert.lengthOf(corp(corps, "upgrade"), 0, "no energy left, so no upgrader is commissioned");
  });

  it("sizes haulers to the route: a far sink needs more CARRY", () => {
    const near = plan([source("src", 25)], [sink("ctrl", "controller", 50, 100, 30)]);
    const far = plan([source("src", 25)], [sink("ctrl", "controller", 50, 100, 5)]);
    const nearCarry = corp(near.corps, "haul")[0].carry;
    const farCarry = corp(far.corps, "haul")[0].carry;
    assert.isAbove(farCarry, nearCarry, "longer round trip => more CARRY parts in flight");
  });

  it("emits corps as simple strategic initiatives (size, endpoints, spawn)", () => {
    const { corps } = plan(
      [source("srcA", 10)],
      [sink("ctrl", "controller", 50, 100, 40)]
    );
    const haul = corp(corps, "haul")[0];
    // Shorthand: Haul(carry, from=srcA, to=ctrl, spawn=S)
    assert.deepInclude(haul, { kind: "haul", fromId: "srcA", toId: "ctrl", spawnId: "S" });
    assert.isAbove(haul.carry, 0);
  });

  it("reports energy it could not route when every sink is full", () => {
    const { unrouted } = plan(
      [source("src", 25, 10)],
      [sink("spawn", "spawn", 100, 3, 25)] // only 3 capacity for 10 supply
    );
    assert.equal(unrouted, 7);
  });
});
