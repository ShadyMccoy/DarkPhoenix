import { expect } from "chai";
import { ColonyProblem, planColony } from "../../../src/economy/CorpPlanner";
import { commissionsFromPlan, MinerOperationAssignment } from "../../../src/economy/commissionPlan";
import { corpIdFor } from "../../../src/economy/Commission";
import { minerSpawnLoad } from "../../../src/economy/primitives";

/**
 * EMERGENT kind selection (spec 02 feeder-router, owner 2026-07-26): a
 * link-served source - one whose energy EMERGES at the core link (haulPos set by
 * detectLinkHaulPositions) - is transported by the link network + the
 * LinkCorp, so the planner must NOT also field a walking haul
 * vector for it. A walking crew there would drain the very core link the
 * feeder loads (the storage->core->storage thrash, t72595372). This falls out
 * of the planner's own haulPos lens - not a bolt-on to the haul runtime
 * (spec 00/17).
 *
 * Since spec 34 D5 the observable moved: a mined source is ONE miner-operation
 * commission, and "no walking transport" is the HAUL-OF-ZERO shape - the
 * operation's routes are [] and its all-in price is the node alone (owner
 * 2026-07-28: "the suppressions are generally haul-of-zero situations"). The
 * selection contract is unchanged: it tracks haulPos, flipping cleanly
 * link<->walk.
 */
const at = (x: number, y = 25, room = "W1N1") => ({ x, y, roomName: room });

const world: ColonyProblem = {
  spawns: [{ id: "spawn-s1", pos: at(25, 25) }],
  sources: [
    // A normal WALKING source: no haulPos, its operation carries real routes.
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

describe("miner operation: link-served sources are haul-of-zero (no walking vector)", () => {
  const plan = planColony(world);
  const commissions = commissionsFromPlan(world, plan);
  const operationFor = (id: string) =>
    commissions.find(c => c.kind === "harvest" && c.corpId === corpIdFor("harvest", id));
  const routesOf = (id: string) => (operationFor(id)!.assignment as MinerOperationAssignment).routes;

  it("precondition: the planner DID route both sources' haulers (funding is not the reason)", () => {
    expect(plan.haulers.some(h => h.sourceId === "source-walk"), "walking source routed").to.equal(true);
    expect(plan.haulers.some(h => h.sourceId === "source-link"), "link-served source routed").to.equal(true);
  });

  it("the WALKING source's operation carries its routed vector", () => {
    expect(routesOf("source-walk").length).to.be.greaterThan(0);
  });

  it("the LINK-SERVED source is haul-of-zero: routes [], price = the node alone", () => {
    expect(routesOf("source-link")).to.deep.equal([]);
    const op = operationFor("source-link")!;
    const distance = (op.assignment as MinerOperationAssignment).miner.distance;
    expect(op.consumes.spawnPartsPerTick).to.be.closeTo(minerSpawnLoad(distance), 1e-9);
  });

  it("no standalone carry commission exists for either mined source", () => {
    expect(commissions.filter(c => c.kind === "carry")).to.have.length(0);
  });

  it("a source flips to a real vector exactly when it stops being link-served (haulPos gone)", () => {
    const walking: ColonyProblem = {
      ...world,
      sources: world.sources.map(s => (s.id === "source-link" ? { ...s, haulPos: undefined } : s))
    };
    const wPlan = planColony(walking);
    const wCommissions = commissionsFromPlan(walking, wPlan);
    const op = wCommissions.find(c => c.kind === "harvest" && c.corpId === corpIdFor("harvest", "source-link"))!;
    expect((op.assignment as MinerOperationAssignment).routes.length, "walking again: the vector returns").to.be.greaterThan(0);
  });
});
