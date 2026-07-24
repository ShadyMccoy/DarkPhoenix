/**
 * NOW-planner equivalence (spec 17 acceptance test 2, scheduler half).
 *
 * planAcquisitions restructured the decision walk (returns became recorded
 * outcomes so ONE walk can emit both the agenda and the buy). The doctrine is
 * settled and must not move: this suite freezes the PRE-refactor scheduleSpawn
 * verbatim as the reference and sweeps a deterministic randomized demand-set
 * space, asserting
 *
 *   1. scheduleSpawn === reference (the restructure changed nothing), and
 *   2. planAcquisitions().decision === reference (recording perturbs nothing),
 *   3. the agenda's "buy"-gated entry IS the decision (prescriptive NOW plan).
 */

import { expect } from "chai";
import {
  ScheduleContext,
  ScheduleResult,
  SpawnDemand,
  SpawnRole,
  effectivePriority,
  fleetSecured,
  planAcquisitions,
  scheduleSpawn,
  starvationBoost,
  withMinerPrecedence
} from "../../../src/spawn/SpawnScheduler";

/** THE REFERENCE: pre-spec-17 scheduleSpawn, copied verbatim. */
function referenceScheduleSpawn(demands: SpawnDemand[], ctx: ScheduleContext): ScheduleResult | null {
  if (demands.length === 0) return null;
  const eligible = withMinerPrecedence(demands);
  const secured = fleetSecured(eligible); // conditioned windfall gate (spec 14 E4/P7)
  const ranked = [...eligible].sort(
    (a, b) => effectivePriority(b, ctx.tick, secured) - effectivePriority(a, ctx.tick, secured)
  );
  let holdForBlocking = false;
  let holdStrict = false;
  let pendingAffordable = false;

  for (const demand of ranked) {
    const starved = starvationBoost(demand, ctx.tick) > 0;
    if (ctx.energyAvailable >= demand.minCost) {
      if (holdForBlocking && (holdStrict || !demand.producesIncome)) continue;
      if (demand.opportunistic && pendingAffordable) continue;
      const energyBudget = Math.min(demand.desiredCost, ctx.energyAvailable);
      return {
        demand,
        energyBudget,
        reason: energyBudget >= demand.desiredCost ? "afford-desired" : "afford-min-scaled"
      };
    }
    const canEverAfford = ctx.energyCapacity >= demand.minCost;
    const fundableIncome = demand.producesIncome && (demand.holdToFund === true || starved);
    const fundableConsumer = !demand.producesIncome && demand.holdToFund === true;
    const mustFund =
      !demand.opportunistic && (demand.blocking || demand.replacement === true || fundableIncome || fundableConsumer);
    if (mustFund && canEverAfford) {
      if (ctx.energyIncome > 0) return null;
      holdForBlocking = true;
      if (demand.producesIncome) holdStrict = true;
      if (secured && fundableConsumer) holdStrict = true;
    }
    if (canEverAfford) pendingAffordable = true;
  }
  return null;
}

/** Deterministic LCG so the sweep replays identically on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const ROLES: SpawnRole[] = ["miner", "hauler", "upgrader", "builder", "tanker", "reserver", "guard"];

function randomDemand(rnd: () => number, i: number, tick: number): SpawnDemand {
  const role = ROLES[Math.floor(rnd() * ROLES.length)];
  const minCost = 100 + Math.floor(rnd() * 8) * 100;
  const producesIncome = role === "miner" || role === "hauler" || role === "reserver";
  return {
    buyerCorpId: `corp-${i}`,
    role,
    value: 40 + Math.floor(rnd() * 80),
    blocking: rnd() < 0.25,
    producesIncome,
    ...(rnd() < 0.15 ? { replacement: true } : {}),
    ...(rnd() < 0.1 ? { holdToFund: true } : {}),
    ...(rnd() < 0.1 ? { opportunistic: true } : {}),
    ...(producesIncome && rnd() < 0.8
      ? { groupId: `src-${Math.floor(rnd() * 3)}`, groupStarted: rnd() < 0.6 }
      : {}),
    desiredCost: minCost + Math.floor(rnd() * 6) * 100,
    minCost,
    // 0 = unstamped; a stamped demand may be deep in starvation.
    since: rnd() < 0.3 ? 0 : tick - Math.floor(rnd() * 900)
  };
}

describe("NOW planner: planAcquisitions is the pinned scheduleSpawn walk (spec 17)", () => {
  const rnd = lcg(0xdeadbeef);
  const CASES = 600;

  it(`decision equivalence + agenda consistency across ${CASES} randomized demand sets`, () => {
    for (let c = 0; c < CASES; c++) {
      const tick = 1000 + Math.floor(rnd() * 500);
      const demands: SpawnDemand[] = [];
      const n = 1 + Math.floor(rnd() * 8);
      for (let i = 0; i < n; i++) demands.push(randomDemand(rnd, i, tick));
      const ctx: ScheduleContext = {
        energyAvailable: Math.floor(rnd() * 14) * 100,
        energyCapacity: 300 + Math.floor(rnd() * 15) * 100,
        energyIncome: rnd() < 0.4 ? 0 : 10,
        tick
      };

      const expected = referenceScheduleSpawn(demands, ctx);
      const viaSchedule = scheduleSpawn(demands, ctx);
      const plan = planAcquisitions(demands, ctx);

      const label = `case ${c}: ctx=${JSON.stringify(ctx)}`;
      expect(viaSchedule, `${label} (scheduleSpawn)`).to.deep.equal(expected);
      expect(plan.decision, `${label} (planAcquisitions)`).to.deep.equal(expected);

      // The prescriptive contract: the buy IS the agenda's "buy"-gated entry.
      const buyRows = plan.agenda.filter(a => a.gate === "buy");
      if (plan.decision) {
        expect(buyRows, `${label} (one buy row)`).to.have.length(1);
        expect(buyRows[0].corp, label).to.equal(plan.decision.demand.buyerCorpId);
        expect(buyRows[0].role, label).to.equal(plan.decision.demand.role);
      } else {
        expect(buyRows, `${label} (no buy row without a decision)`).to.have.length(0);
      }
    }
  });

  it("agenda entries carry the walk's verdicts (miner precedence surfaces as no-miner)", () => {
    const tick = 100;
    const demands: SpawnDemand[] = [
      {
        buyerCorpId: "carry-src",
        role: "hauler",
        value: 100,
        blocking: true,
        producesIncome: true,
        groupId: "src",
        groupStarted: false, // no miner fielded: precedence gates the hauler out
        desiredCost: 300,
        minCost: 300,
        since: 0
      },
      {
        buyerCorpId: "harvest-src",
        role: "miner",
        value: 100,
        blocking: true,
        producesIncome: true,
        groupId: "src",
        groupStarted: false,
        desiredCost: 550,
        minCost: 250,
        since: 0
      }
    ];
    const plan = planAcquisitions(demands, { energyAvailable: 550, energyCapacity: 550, energyIncome: 0, tick });
    expect(plan.decision?.demand.buyerCorpId).to.equal("harvest-src");
    const byCorp = new Map(plan.agenda.map(a => [a.corp, a.gate]));
    expect(byCorp.get("harvest-src")).to.equal("buy");
    expect(byCorp.get("carry-src")).to.equal("no-miner");
  });
});
