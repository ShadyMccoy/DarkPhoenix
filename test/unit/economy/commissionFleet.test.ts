/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { ColonyPlan, ColonyProblem, CommissionedHauler, CommissionedMiner, planColony } from "../../../src/economy/CorpPlanner";
import { commissionsFromPlan } from "../../../src/economy/commissionPlan";
import {
  HARVEST_ENERGY_PER_WORK,
  MINER_PARTS,
  UPGRADER_PARTS_PER_WORK,
  UPGRADE_ENERGY_PER_WORK,
  BUILD_ENERGY_PER_WORK,
  TANKER_CARRY_PER_MOVE_PLAIN,
  constructionWorkSpawnLoad,
  effectiveLife,
  minerSpawnLoad,
  workPartsForEnergyRate
} from "../../../src/economy/primitives";
import { vectorSupplyPartsGait, vectorSupplyPartsGaitRate } from "../../../src/economy/roadEconomics";
import { harvestKind } from "../../../src/corps/kinds/harvestKind";
import { carryKind } from "../../../src/corps/kinds/carryKind";
import { upgradeKind } from "../../../src/corps/kinds/upgradeKind";
import { constructionKind } from "../../../src/corps/kinds/constructionKind";

/**
 * Spec 39 phase 1: commissions declare their FLEET (count + body per role),
 * not just a price. The declaration is the plan's OWN terms - standing parts,
 * the amortized load, and the working-part total behind them - derived from
 * the exact primitives the envelope price already composes. It is one fact in
 * two units, never a second book: per-commission, the role loads must sum to
 * consumes.spawnPartsPerTick to 1e-9, so the fleet cannot drift from the
 * price (the P5 trap class). This is what makes per-commission
 * plan-vs-actual free: segment-4 actual bodyParts joins against fleet[role]
 * by the kind's declared role keys.
 */
const at = (x: number, y = 25, room = "W1N1") => ({ x, y, roomName: room });

const miner = (sourceId: string, distance: number, rate = 10): CommissionedMiner => ({
  sourceId,
  nodeId: `n-${sourceId}`,
  spawnId: "spawn-s1",
  distance,
  rate,
  spawnParts: 0.1,
  netEnergy: rate,
  efficiency: 1,
  maxMiners: 1
});

const route = (
  sourceId: string,
  spawnParts: number,
  distance = 10,
  carryParts = 4,
  flowRate = 5
): CommissionedHauler => ({
  sourceId,
  sinkId: "spawn-s1",
  spawnId: "spawn-s1",
  distance,
  flowRate,
  carryParts,
  spawnParts
});

const problem: ColonyProblem = {
  spawns: [{ id: "s1", pos: at(25) }],
  sources: [
    { id: "source-a", nodeId: "n-a", pos: at(15), rate: 10, maxMiners: 1 },
    { id: "source-b", nodeId: "n-b", pos: at(40), rate: 10, maxMiners: 1, haulPos: at(26) } as any
  ],
  sinks: [],
  dist: (a: any, b: any) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

const plan = (over: Partial<ColonyPlan>): ColonyPlan => ({ miners: [], haulers: [], sinks: [], ...over } as ColonyPlan);

/** The consumer world (same shape as constructionCommissionPrice.test.ts). */
const consumerWorld: ColonyProblem = {
  spawns: [{ id: "spawn-s1", pos: at(25, 25) }],
  sources: [{ id: "source-a", nodeId: "n-a", pos: at(15, 25), rate: 10, maxMiners: 1 }],
  sinks: [
    { id: "site-1", kind: "construction", pos: at(33, 25), value: 70, capacity: 3000 },
    { id: "ctrl-s1", kind: "controller", pos: at(30, 30), value: 50, capacity: 1000, reserve: 2 }
  ],
  dist: (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
};

describe("commission fleet declaration (spec 39 phase 1: the plan owns the fleet)", () => {
  it("HARVEST: the operation declares its miner (count 1, MINER_PARTS body) and its routed hauler squad", () => {
    const m = miner("source-a", 12);
    const r1 = route("source-a", 0.04, 10, 4);
    const r2 = route("source-a", 0.02, 20, 3);
    const out = commissionsFromPlan(problem, plan({ miners: [m], haulers: [r1, r2] }));
    const harvest = out.find(c => c.kind === "harvest")!;

    expect(harvest.fleet, "the operation declares a fleet").to.not.equal(undefined);
    const f = harvest.fleet!;

    expect(f.miner, "the node role").to.not.equal(undefined);
    expect(f.miner.count, "one full-size miner body per source").to.equal(1);
    expect(f.miner.parts).to.be.closeTo(MINER_PARTS, 1e-9);
    expect(f.miner.load).to.be.closeTo(minerSpawnLoad(12), 1e-9);
    expect(f.miner.workingParts).to.equal(workPartsForEnergyRate(10, HARVEST_ENERGY_PER_WORK));

    expect(f.hauler, "the routed vector squad").to.not.equal(undefined);
    expect(f.hauler.load, "load = the planner's own routed spawnParts").to.be.closeTo(0.04 + 0.02, 1e-9);
    expect(f.hauler.parts, "standing parts = each route's load un-amortized at ITS distance").to.be.closeTo(
      0.04 * effectiveLife(10) + 0.02 * effectiveLife(20),
      1e-9
    );
    expect(f.hauler.workingParts).to.be.closeTo(4 + 3, 1e-9);
  });

  it("the fleet loads sum EXACTLY to the envelope price - one fact, two units, no second book", () => {
    const m = miner("source-a", 12);
    const out = commissionsFromPlan(
      problem,
      plan({ miners: [m], haulers: [route("source-a", 0.04, 10), route("source-a", 0.02, 20)] })
    );
    for (const c of out) {
      if (!c.fleet) continue;
      const sum = Object.values(c.fleet).reduce((s, r) => s + r.load, 0);
      expect(sum, `${c.corpId}: fleet load == price`).to.be.closeTo(c.consumes.spawnPartsPerTick ?? 0, 1e-9);
    }
  });

  it("link-served source: no hauler role (the link network IS the vector)", () => {
    const m = miner("source-b", 15);
    const out = commissionsFromPlan(problem, plan({ miners: [m], haulers: [route("source-b", 0.05)] }));
    const harvest = out.find(c => c.kind === "harvest")!;
    expect(harvest.fleet).to.not.equal(undefined);
    expect(harvest.fleet!.miner).to.not.equal(undefined);
    expect(harvest.fleet!.hauler, "haul-of-zero: no hauler entry").to.equal(undefined);
  });

  it("CARRY: the scavenge vector declares its hauler fleet; load == price", () => {
    const scav1 = route("intel-W1N1-30-30-scavenge-1", 0.03, 8, 5);
    const scav2 = route("intel-W1N1-30-30-scavenge-1", 0.01, 16, 2);
    const out = commissionsFromPlan(problem, plan({ haulers: [scav1, scav2] }));
    const carry = out.find(c => c.kind === "carry")!;

    expect(carry.fleet).to.not.equal(undefined);
    const h = carry.fleet!.hauler;
    expect(h, "the one transport role").to.not.equal(undefined);
    expect(h.load).to.be.closeTo(carry.consumes.spawnPartsPerTick ?? 0, 1e-9);
    expect(h.parts).to.be.closeTo(0.03 * effectiveLife(8) + 0.01 * effectiveLife(16), 1e-9);
    expect(h.workingParts).to.be.closeTo(5 + 2, 1e-9);
  });

  it("UPGRADE: upgrader fleet from the allocation - parts = WORK x UPGRADER_PARTS_PER_WORK", () => {
    const p = planColony(consumerWorld);
    const out = commissionsFromPlan(consumerWorld, p);
    const upgrade = out.find(c => c.kind === "upgrade")!;
    expect(upgrade, "the plan funds the controller").to.not.equal(undefined);

    const u = upgrade.fleet!.upgrader;
    expect(u, "the upgrader role").to.not.equal(undefined);
    const allocated = upgrade.consumes.energyRate!;
    expect(u.workingParts).to.be.closeTo(allocated / UPGRADE_ENERGY_PER_WORK, 1e-9);
    expect(u.parts).to.be.closeTo((allocated / UPGRADE_ENERGY_PER_WORK) * UPGRADER_PARTS_PER_WORK, 1e-9);
    expect(u.load).to.be.closeTo(upgrade.consumes.spawnPartsPerTick ?? 0, 1e-9);
  });

  it("BUILD: builder + tanker roles; loads sum to the all-in price", () => {
    const p = planColony(consumerWorld);
    const out = commissionsFromPlan(consumerWorld, p);
    const build = out.find(c => c.kind === "build")!;
    expect(build, "the plan funds construction").to.not.equal(undefined);

    const f = build.fleet!;
    expect(f.builder, "the WORK role").to.not.equal(undefined);
    expect(f.tanker, "the supply vector role").to.not.equal(undefined);

    const rate = build.consumes.energyRate!;
    const d = 8; // |33-25| from the nearest spawn (the price test pins the same)
    expect(f.builder.workingParts).to.be.closeTo(rate / BUILD_ENERGY_PER_WORK, 1e-9);
    expect(f.builder.load).to.be.closeTo(constructionWorkSpawnLoad(rate, d), 1e-9);
    expect(f.builder.parts).to.be.closeTo(constructionWorkSpawnLoad(rate, d) * effectiveLife(d), 1e-9);
    // The CONTINUOUS gait (spec 51 GAP 1, 2026-08-08): the budget is a rate, so
    // it is not ceiled to a fieldable body - that rounding is what let the
    // envelope and the fill drift apart. `vectorSupplyPartsGait` still ceils
    // and still sizes the actual tanker; the two differ 0.6% here (10.88 vs 12).
    expect(f.tanker.parts).to.be.closeTo(vectorSupplyPartsGaitRate(rate, d, 0, TANKER_CARRY_PER_MOVE_PLAIN), 1e-9);
    expect(vectorSupplyPartsGait(rate, d, 0, TANKER_CARRY_PER_MOVE_PLAIN), "the sizing form still ceils").to.equal(12);

    const sum = f.builder.load + f.tanker.load;
    expect(sum, "fleet load == the all-in price").to.be.closeTo(build.consumes.spawnPartsPerTick ?? 0, 1e-9);
  });

  it("fleet role keys are the kind's DECLARED role keys - the actuals join key", () => {
    const p = planColony(consumerWorld);
    const out = commissionsFromPlan(consumerWorld, p).concat(
      commissionsFromPlan(problem, plan({ miners: [miner("source-a", 12)], haulers: [route("source-a", 0.04)] }))
    );
    const kindRoles: Record<string, Set<string>> = {
      harvest: new Set(Object.keys(harvestKind.roles)),
      carry: new Set(Object.keys(carryKind.roles)),
      upgrade: new Set(Object.keys(upgradeKind.roles)),
      build: new Set(Object.keys(constructionKind.roles))
    };
    let checked = 0;
    for (const c of out) {
      if (!c.fleet) continue;
      const declared = kindRoles[c.kind];
      expect(declared, `kind ${c.kind} has a role table here`).to.not.equal(undefined);
      for (const role of Object.keys(c.fleet)) {
        expect(declared.has(role), `${c.corpId}: role "${role}" is declared by its kind`).to.equal(true);
        checked += 1;
      }
    }
    expect(checked, "the sweep saw real fleet entries").to.be.greaterThan(3);
  });

  it("auxiliary commissions declare NO fleet (off-budget: the director prices them, spec 39 phase 4 migrates them)", async () => {
    const { perRoomAuxiliaryCommission } = await import("../../../src/economy/proposeHelpers");
    const aux = perRoomAuxiliaryCommission("extensionTender", "W1N1", "s1");
    expect(aux.fleet).to.equal(undefined);
  });
});
