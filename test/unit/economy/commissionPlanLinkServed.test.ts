import { expect } from "chai";
import { ColonyProblem, planColony } from "../../../src/economy/CorpPlanner";
import { commissionsFromPlan } from "../../../src/economy/commissionPlan";
import { corpIdFor } from "../../../src/economy/Commission";

/**
 * EMERGENT kind selection (spec 02 feeder-router, owner 2026-07-26): a
 * link-served source - one whose energy EMERGES at the core link (haulPos set by
 * detectLinkHaulPositions) - is transported by the link network + the
 * ControllerFeederCorp, so commissionsFromPlan must NOT also emit a walking
 * carry commission for it. A CarryCorp there would drain the very core link the
 * feeder loads (the storage->core->storage thrash, t72595372). This falls out of
 * the planner's own haulPos lens - not a bolt-on to CarryCorp (spec 00/17).
 *
 * RED against the old code, which emitted one carry commission per source
 * unconditionally (only bank- sources were skipped).
 */
const at = (x: number, y = 25, room = "W1N1") => ({ x, y, roomName: room });

const world: ColonyProblem = {
  spawns: [{ id: "spawn-s1", pos: at(25, 25) }],
  sources: [
    // A normal WALKING source: no haulPos, keeps its walking CarryCorp.
    { id: "source-walk", nodeId: "n-walk", pos: at(15, 25), rate: 10, maxMiners: 1 },
    // A LINK-SERVED source: haulPos points at the core link beside the storage,
    // so its energy is logged home by the link + drained by the feeder.
    { id: "source-link", nodeId: "n-link", pos: at(40, 25), rate: 10, maxMiners: 1, haulPos: at(26, 25) }
  ],
  sinks: [
    { id: "storage-s1", kind: "storage", pos: at(25, 25), value: 1, capacity: 100_000 },
    { id: "ctrl-s1", kind: "controller", pos: at(30, 30), value: 50, capacity: 1000, reserve: 2 }
  ],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

describe("commissionsFromPlan: no walking carry for a link-served source", () => {
  const plan = planColony(world);
  const commissions = commissionsFromPlan(world, plan);
  const carryFor = (id: string) =>
    commissions.filter(c => c.kind === "carry" && c.corpId === corpIdFor("carry", id));

  it("precondition: the planner DID route both sources' haulers (funding is not the reason)", () => {
    expect(plan.haulers.some(h => h.sourceId === "source-walk"), "walking source routed").to.equal(true);
    expect(plan.haulers.some(h => h.sourceId === "source-link"), "link-served source routed").to.equal(true);
  });

  it("the WALKING source keeps its carry commission", () => {
    expect(carryFor("source-walk")).to.have.length(1);
  });

  it("the LINK-SERVED source gets NO carry commission (link + feeder own its transport)", () => {
    expect(carryFor("source-link")).to.have.length(0);
  });

  it("a source flips to no-carry exactly when it becomes link-served (haulPos appears)", () => {
    // Same world, but source-link is NOT yet link-served (no haulPos): it must
    // then get a walking carry commission - the selection tracks haulPos, one
    // kind per route, flipping cleanly link<->walk.
    const walking: ColonyProblem = {
      ...world,
      sources: world.sources.map(s => (s.id === "source-link" ? { ...s, haulPos: undefined } : s))
    };
    const wPlan = planColony(walking);
    const wCommissions = commissionsFromPlan(walking, wPlan);
    const wCarry = wCommissions.filter(c => c.kind === "carry" && c.corpId === corpIdFor("carry", "source-link"));
    expect(wCarry, "without haulPos it is a walking route again").to.have.length(1);
  });
});
