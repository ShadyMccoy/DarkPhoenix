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
function work(corps: CorpSpec[], kind: "mine" | "build" | "upgrade"): number {
  const c = corp(corps, kind)[0] as { work: number } | undefined;
  return c?.work ?? 0;
}

describe("EconomyPlanner", () => {
  it("routes leftover energy to the controller with no spillover rule", () => {
    // Source makes 10; the spawn claims only its own (computed) overhead; the
    // controller is low value but high capacity, so it mops up the rest. Nothing
    // says "spill to controller" - it is just the only sink left with capacity.
    const p = plan(
      [source("src", 25)],
      [sink("spawn", "spawn", 100, 0, 25), sink("ctrl", "controller", 50, 100, 25)]
    );
    assert.equal(work(p.corps, "mine"), 5, "5 WORK harvests the full 10/tick");
    assert.isAtLeast(work(p.corps, "upgrade"), 9, "controller absorbs nearly all of the 10");
    assert.isAbove(p.overhead, 0, "the economy pays a real, computed overhead");
    assert.isBelow(p.overhead, 1, "co-located, that overhead is small");
  });

  it("fills high-value construction to capacity, then spills the rest to upgrading", () => {
    const noBuild = plan(
      [source("src", 25)],
      [sink("spawn", "spawn", 100, 0, 25), sink("ctrl", "controller", 50, 100, 25)]
    );
    const withBuild = plan(
      [source("src", 25)],
      [
        sink("spawn", "spawn", 100, 0, 25),
        sink("site", "construction", 70, 5, 25), // capacity = one builder's appetite
        sink("ctrl", "controller", 50, 100, 25),
      ]
    );
    assert.equal(work(withBuild.corps, "build"), 1, "5 energy / 5-per-WORK = 1 build WORK");
    assert.isAbove(work(withBuild.corps, "upgrade"), 0, "the controller still gets the leftover");
    assert.isBelow(
      work(withBuild.corps, "upgrade"),
      work(noBuild.corps, "upgrade"),
      "construction took its share first, so the controller spills less"
    );
  });

  it("lets value/capacity alone change the routing - no code change", () => {
    // Construction can now absorb everything: it supersedes upgrading entirely.
    const p = plan(
      [source("src", 25)],
      [
        sink("spawn", "spawn", 100, 0, 25),
        sink("site", "construction", 70, 10, 25),
        sink("ctrl", "controller", 50, 100, 25),
      ]
    );
    assert.equal(work(p.corps, "build"), 2, "~9.4 energy absorbed -> 2 build WORK");
    assert.lengthOf(corp(p.corps, "upgrade"), 0, "no energy left, so no upgrader is commissioned");
  });

  it("sizes haulers to the route: a far sink needs more CARRY", () => {
    const near = plan([source("src", 25)], [sink("ctrl", "controller", 50, 100, 30)]);
    const far = plan([source("src", 25)], [sink("ctrl", "controller", 50, 100, 5)]);
    assert.isAbove(corp(far.corps, "haul")[0].carry, corp(near.corps, "haul")[0].carry);
  });

  it("emits corps as simple strategic initiatives (size, endpoints, spawn)", () => {
    const { corps } = plan([source("srcA", 10)], [sink("ctrl", "controller", 50, 100, 40)]);
    const haul = corp(corps, "haul")[0];
    // Shorthand: Haul(carry, from=srcA, to=ctrl, spawn=S)
    assert.deepInclude(haul, { kind: "haul", fromId: "srcA", toId: "ctrl", spawnId: "S" });
    assert.isAbove(haul.carry, 0);
  });

  it("with builders that keep pace, construction supersedes upgrading during a build", () => {
    // Realistic model: construction capacity is not one builder's appetite -
    // builders scale to absorb almost any supply. So a high-value, high-capacity
    // construction sink takes essentially all the energy while a build is active,
    // and the regular upgrade gets only the leftover (~none). The downgrade floor
    // is held separately (the anti-downgrade reserve, a tiny top-value sink).
    const p = plan(
      [source("src", 25)],
      [
        sink("spawn", "spawn", 100, 0, 25),
        sink("site", "construction", 70, 1000, 25), // builders keep pace
        sink("ctrl", "controller", 50, 100, 25),
      ]
    );
    assert.isAtLeast(work(p.corps, "build"), 2, "build WORK scales to consume the supply");
    assert.lengthOf(corp(p.corps, "upgrade"), 0, "regular upgrading is superseded during the build");
  });

  it("closes the energy loop: a far source self-consistently leaves less for its project", () => {
    // Same supply and same value/capacity, only the haul distance differs. The
    // far economy must staff bigger haulers, so its overhead is higher and its
    // controller - fed by what's left - ends up smaller. Available energy is an
    // OUTPUT of the plan, not an input.
    const near = plan(
      [source("src", 44)],
      [sink("spawn", "spawn", 100, 0, 45), sink("ctrl", "controller", 50, 100, 45)]
    );
    const far = plan(
      [source("src", 5)],
      [sink("spawn", "spawn", 100, 0, 45), sink("ctrl", "controller", 50, 100, 45)]
    );
    assert.isAbove(far.overhead, near.overhead, "the far economy pays more to haul");
    assert.isBelow(
      work(far.corps, "upgrade"),
      work(near.corps, "upgrade"),
      "so it has less energy left to upgrade with"
    );
  });
});
