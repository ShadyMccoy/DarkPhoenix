import { expect } from "chai";
import { ColonyProblem, planColony } from "../../../src/economy/CorpPlanner";
import { commissionsFromPlan } from "../../../src/economy/commissionPlan";
import { constructionWorkSpawnLoad, operationSpawnLoad } from "../../../src/economy/primitives";

/**
 * Spec 34 D4: the commission price is ALL-IN. A construction sink's declared
 * spawnPartsPerTick covers the builder WORK bodies AND the supply vector that
 * fuels them - the storage->site shuttle the corp operates internally. The old
 * charge was the WORK bodies alone: the vector's carriers were spawn load the
 * planner never budgeted (the P4 "unbudgeted" class, measured live as tanker
 * details the parts ledger did not see). An operation that fields carriers its
 * price omits is lying to the planner. RED against the old charge.
 */
const at = (x: number, y = 25, room = "W1N1") => ({ x, y, roomName: room });

const world: ColonyProblem = {
  spawns: [{ id: "spawn-s1", pos: at(25, 25) }],
  sources: [{ id: "source-a", nodeId: "n-a", pos: at(15, 25), rate: 10, maxMiners: 1 }],
  sinks: [
    { id: "site-1", kind: "construction", pos: at(33, 25), value: 70, capacity: 3000 },
    { id: "ctrl-s1", kind: "controller", pos: at(30, 30), value: 50, capacity: 1000, reserve: 2 }
  ],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

describe("construction commission price is ALL-IN (spec 34 D4: WORK bodies + supply vector)", () => {
  const plan = planColony(world);
  const commissions = commissionsFromPlan(world, plan);
  const build = commissions.find(c => c.kind === "build");

  it("precondition: the plan funds the construction sink", () => {
    expect(build, "a build commission exists").to.not.equal(undefined);
    expect(build!.consumes.energyRate).to.be.greaterThan(0);
  });

  it("declares operationSpawnLoad(node, vector) - not the WORK bodies alone", () => {
    const rate = build!.consumes.energyRate!;
    const d = 8; // |33-25| - the sink's distance from the nearest spawn
    const allIn = operationSpawnLoad(constructionWorkSpawnLoad(rate, d), [{ rate, distance: d }]);
    expect(build!.consumes.spawnPartsPerTick).to.be.closeTo(allIn, 1e-9);
    // And the vector share is REAL (the old price was the node load alone).
    expect(build!.consumes.spawnPartsPerTick).to.be.greaterThan(constructionWorkSpawnLoad(rate, d) + 1e-9);
  });
});

describe("constructionKind wrapper carries the all-in price (spec 34 P4/Acceptance)", () => {
  // The per-room wrapper subsumes the solver's build commissions; its OWN
  // envelope declared spawnPartsPerTick 0 - the documented lie (spec 34) that
  // kept construction bodies "unbudgeted" wherever the wrapper was read. It
  // must now SUM its rooms' build-commission prices (read-through, never a
  // re-derivation): the draft already carries each site's operationSpawnLoad.
  it("sums the draft build commissions' prices for its room - never 0 while fielding", async () => {
    const { constructionKind } = await import("../../../src/corps/kinds/constructionKind");
    const plan = planColony(world);
    const draft = commissionsFromPlan(world, plan);
    const buildSum = draft
      .filter(c => c.kind === "build")
      .reduce((s, c) => s + (c.consumes.spawnPartsPerTick ?? 0), 0);
    expect(buildSum, "precondition: the draft carries priced build work").to.be.greaterThan(0);

    const wrappers = constructionKind.propose(world, draft);
    expect(wrappers.length).to.be.greaterThan(0);
    const w = wrappers.find(c => (c.assignment as { roomName: string }).roomName === "W1N1")!;
    expect(w.consumes.spawnPartsPerTick).to.be.closeTo(buildSum, 1e-9);
  });
});
