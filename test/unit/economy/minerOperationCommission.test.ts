/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { ColonyPlan, ColonyProblem, CommissionedHauler, CommissionedMiner } from "../../../src/economy/CorpPlanner";
import { commissionsFromPlan, MinerOperationAssignment } from "../../../src/economy/commissionPlan";
import { minerSpawnLoad } from "../../../src/economy/primitives";

/**
 * Spec 34 D5 (second half, owner go 2026-07-28): "spawn a minerCorp" - the
 * harvest and its evacuation vector are ONE commission with ONE all-in price;
 * the carry squad is an internal detail of the harvest kind.
 *
 * Before this change a mined source shipped TWO envelopes: a harvest
 * commission whose spawnPartsPerTick was the NOMINAL estimate
 * (spawnPartsFor: miner + 2x carry at nearest-spawn distance) and a separate
 * carry commission carrying the ROUTED truth (per-route distances, paved
 * discounts, deposit legs). Hauler parts were declared twice and neither
 * envelope alone told the truth. The merged envelope prices the operation
 * once: the miner NODE load plus the sum of the ROUTED vector parts the
 * planner actually computed - never a re-derived nominal.
 *
 * The owner's boundary rulings pinned here:
 * - Link-served sources are the haul-of-zero degenerate case: routes [],
 *   price = the node alone (the vector IS the link network).
 * - Minerless sources (scavenge stocks) stay pure-vector operations on the
 *   carry path - there is no node half to merge into.
 * - Bank sources stay uncommissioned for transport (depot movers own those
 *   legs), exactly as before.
 */
const at = (x: number, y = 25, room = "W1N1") => ({ x, y, roomName: room });

const miner = (sourceId: string, distance: number, rate = 10): CommissionedMiner => ({
  sourceId,
  nodeId: `n-${sourceId}`,
  spawnId: "spawn-s1",
  distance,
  rate,
  spawnParts: 0.1, // the legacy NOMINAL estimate - must NOT drive the merged price
  netEnergy: rate,
  efficiency: 1,
  maxMiners: 1
});

const route = (sourceId: string, spawnParts: number, flowRate = 5): CommissionedHauler => ({
  sourceId,
  sinkId: "spawn-s1",
  spawnId: "spawn-s1",
  distance: 10,
  flowRate,
  carryParts: 4,
  spawnParts
});

const problem: ColonyProblem = {
  spawns: [{ id: "s1", pos: at(25) }],
  sources: [
    { id: "source-a", nodeId: "n-a", pos: at(15), rate: 10, maxMiners: 1 },
    // Link-served: energy emerges at the core link (haulPos set by the plan).
    { id: "source-b", nodeId: "n-b", pos: at(40), rate: 10, maxMiners: 1, haulPos: at(26) } as any
  ],
  sinks: [],
  dist: (a: any, b: any) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

const plan = (over: Partial<ColonyPlan>): ColonyPlan =>
  ({ miners: [], haulers: [], sinks: [], ...over } as ColonyPlan);

describe("miner operation commission (spec 34 D5: one envelope, all-in routed price)", () => {
  it("a mined source emits ONE harvest commission carrying {miner, routes} - and NO carry commission", () => {
    const m = miner("source-a", 10);
    const r1 = route("source-a", 0.04);
    const r2 = route("source-a", 0.02);
    const out = commissionsFromPlan(problem, plan({ miners: [m], haulers: [r1, r2] }));

    const harvest = out.filter(c => c.kind === "harvest");
    expect(harvest.length, "one operation per mined source").to.equal(1);
    expect(out.filter(c => c.kind === "carry").length, "no separate transport envelope").to.equal(0);

    const a = harvest[0].assignment as MinerOperationAssignment;
    expect(a.miner.sourceId).to.equal("source-a");
    expect(a.routes.map(r => r.spawnParts)).to.deep.equal([0.04, 0.02]);
  });

  it("the price is the miner NODE load plus the ROUTED vector parts - never the nominal estimate", () => {
    const m = miner("source-a", 10);
    const r1 = route("source-a", 0.04);
    const r2 = route("source-a", 0.02);
    const out = commissionsFromPlan(problem, plan({ miners: [m], haulers: [r1, r2] }));
    const harvest = out.find(c => c.kind === "harvest")!;

    const allIn = minerSpawnLoad(10) + 0.04 + 0.02;
    expect(harvest.consumes.spawnPartsPerTick).to.be.closeTo(allIn, 1e-9);
    // The nominal m.spawnParts (0.1) must not leak into the envelope.
    expect(Math.abs((harvest.consumes.spawnPartsPerTick ?? 0) - 0.1)).to.be.greaterThan(1e-6);
    // And the vector share is real.
    expect(harvest.consumes.spawnPartsPerTick).to.be.greaterThan(minerSpawnLoad(10) + 1e-9);
  });

  it("link-served source: haul-of-zero - routes [], price = the node alone", () => {
    const m = miner("source-b", 15);
    const rb = route("source-b", 0.05);
    const out = commissionsFromPlan(problem, plan({ miners: [m], haulers: [rb] }));
    const harvest = out.find(c => c.kind === "harvest")!;

    const a = harvest.assignment as MinerOperationAssignment;
    expect(a.routes, "the vector IS the link network").to.deep.equal([]);
    expect(harvest.consumes.spawnPartsPerTick).to.be.closeTo(minerSpawnLoad(15), 1e-9);
    expect(out.filter(c => c.kind === "carry").length).to.equal(0);
  });

  it("minerless scavenge stock: the pure-vector operation keeps the carry path", () => {
    const scav = route("intel-W1N1-30-30-scavenge-1", 0.03);
    const out = commissionsFromPlan(problem, plan({ haulers: [scav] }));

    const carry = out.filter(c => c.kind === "carry");
    expect(carry.length, "no node half to merge into").to.equal(1);
    expect((carry[0].assignment as CommissionedHauler[])[0].sourceId).to.equal("intel-W1N1-30-30-scavenge-1");
    expect(out.filter(c => c.kind === "harvest").length).to.equal(0);
  });

  it("IN-ROOM bank routes stay uncommissioned (depot movers own those legs)", () => {
    const bank = route("bank-W1N1", 0.03);
    const out = commissionsFromPlan(problem, plan({ haulers: [bank] }));
    expect(out.length).to.equal(0);
  });

  it("OUT-OF-ROOM bank routes commission the bankfeed carry corp, homed in the SINK's room (owner 2026-08-12)", () => {
    // The t72935339 refusal was a missing executor: publishRoster skipped
    // bank routes, so a bank->remote-controller edge was planned-and-never-
    // fielded. This commission IS the executor - a walking CarryCorp that
    // withdraws at the bank's storage and delivers at the new room's
    // controller input. consumes.at carries the SINK room so legacyNodeId
    // homes the corp where it delivers (deliverToController keys off the
    // corp's room); pickup resolves live from the bank- id.
    const bankProblem: ColonyProblem = {
      ...problem,
      sinks: [
        { id: "controller-cc", kind: "controller", pos: { x: 20, y: 20, roomName: "W2N2" }, value: 60, capacity: 30 }
      ]
    };
    const edge: CommissionedHauler = { ...route("bank-W1N1", 0.05), sinkId: "controller-cc" };
    const out = commissionsFromPlan(bankProblem, plan({ haulers: [edge] }));
    const carry = out.filter(c => c.kind === "carry");
    expect(carry.length, "the executor exists").to.equal(1);
    expect(carry[0].consumes.at?.roomName, "homed in the sink's room").to.equal("W2N2");
    expect((carry[0].assignment as CommissionedHauler[])[0].sourceId).to.equal("bank-W1N1");
  });
});
