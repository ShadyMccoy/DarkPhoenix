import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView } from "../../../src/engine/view";
import { workmanCycleRate } from "../../../src/primitives";

/**
 * The broker + real quotes, cleared on staged views: the worked 550-budget
 * example from the contract conversation pinned as a fixture, and the
 * bootstrap cascade staged across three ledgers — empty (the workman root
 * emerges from the solvency filter), standing workmen (specialists trim
 * in beside sunk capital), and expiry (full displacement). Piece 6's
 * no-mode bootstrap, asserted: cold and warm worlds enter the same
 * entry point.
 */

function view(over: Partial<EconomyView> = {}): EconomyView {
  return {
    tick: 100,
    bank: "bank",
    bankStock: 300,
    bodyBudget: 300,
    spawnIds: ["sp1"],
    estateRadius: 1,
    sources: [
      { id: "srcA", spots: 3, distToBank: 10 },
      { id: "srcB", spots: 3, distToBank: 25 }
    ],
    controller: { id: "ctrl", distFromBank: 5 },
    creeps: [],
    ...over
  };
}

function byId(plan: ReturnType<typeof replan>): Map<string, ReturnType<typeof replan>["corps"][number]> {
  return new Map(plan.corps.map(c => [c.id, c]));
}

describe("engine/replan", () => {
  it("pins the worked 550 example: specialists win both sources, distance prices the fleets", () => {
    const plan = replan(view({ bodyBudget: 550, bankStock: 2000 }));
    const corps = byId(plan);

    assert.deepEqual(corps.get("mine:srcA")?.body, { work: 5, carry: 0, move: 1 });
    assert.equal(corps.get("mine:srcA")?.target, 1, "one 5W miner saturates a source");
    assert.equal(corps.get("haul:srcA->bank")?.target, 1, "10 tiles: one 5C hauler");
    assert.equal(corps.get("haul:srcB->bank")?.target, 2, "25 tiles: the same flow costs two");
    assert.deepEqual(corps.get("haul:srcA->bank")?.body, { work: 0, carry: 5, move: 5 });

    // The workman quotes everywhere and loses everywhere — no bootstrap flag.
    assert.isUndefined(corps.get("workman:srcA"));
    const beaten = plan.frontier.filter(f => f.reason === "outcompeted").map(f => f.offerId);
    assert.includeMembers(beaten, ["chain:srcA:workman", "chain:srcB:workman"]);

    // The heartbeat's carrier: one small tender covers the whole refill
    // obligation across the co-located estate (owner 2026-08-23 ruling).
    assert.equal(corps.get("spawning:estate")?.target, 1);
    assert.deepEqual(corps.get("spawning:estate")?.body, { work: 0, carry: 2, move: 2 });

    // The residual funds four upgrader steps; the fifth prints its reason.
    assert.equal(corps.get("upgrade:ctrl")?.target, 4);
    assert.deepEqual(corps.get("upgrade:ctrl")?.body, { work: 4, carry: 1, move: 1 });
    assert.equal(plan.frontier.find(f => f.offerId === "upgrade:ctrl")?.reason, "energy residual");

    // Generic in/out on the instance: every commodity, ALLOCATED flow —
    // the hauler's body could carry 12.5 e/t, but the source matches 10.
    const haulA = corps.get("haul:srcA->bank");
    assert.closeTo(haulA?.inputs.energyAt?.["srcA"] ?? 0, 10, 1e-9, "draws what the mine matches");
    assert.closeTo(haulA?.outputs.energyAt?.["bank"] ?? 0, 10, 1e-9, "delivers the same at the bank");
    assert.isAbove(haulA?.inputs.spawnTime ?? 0, 0, "machine time is an input");
    const up = corps.get("upgrade:ctrl");
    assert.closeTo(up?.outputs.controlPoints ?? 0, 16, 1e-9);
    assert.closeTo(up?.inputs.energyAt?.["ctrl"] ?? 0, 16, 1e-9, "burns at its own feed point");
    assert.closeTo(up?.inputs.energyAt?.["bank"] ?? 0, 4 * (500 / 1500), 1e-9, "the parts bill at the bank");

    // The controller's feed is a haul chain of its own — bank → ctrl.
    assert.equal(corps.get("haul:bank->ctrl")?.target, 1);

    assert.closeTo(plan.expected.deliveredEt, 20, 1e-9);
    assert.closeTo(plan.expected.upgradeEt, 16, 1e-9);
    // The heartbeat identity: refill obligation == Σ funded parts bills.
    const bills = plan.corps.reduce((s, c) => s + c.pnl.costEt, 0);
    assert.closeTo(plan.expected.refillEt, bills, 1e-9);

    // The position book: every place clears; the bank's net IS the
    // leftover — the conservation identity as an engine invariant.
    assert.isEmpty(plan.violations);
    const bank = plan.positions.find(p => p.place === "bank");
    assert.closeTo(bank?.netEt ?? NaN, plan.expected.deliveredEt - plan.expected.refillEt - plan.expected.upgradeEt, 1e-9);

    assert.deepEqual(replan(view({ bodyBudget: 550, bankStock: 2000 })), plan, "same view, same plan");
  });

  it("prices the controller's distance: a far controller pays more for its feed", () => {
    const near = replan(view({ bodyBudget: 550, bankStock: 2000, controller: { id: "ctrl", distFromBank: 5 } }));
    const far = replan(view({ bodyBudget: 550, bankStock: 2000, controller: { id: "ctrl", distFromBank: 30 } }));

    const feederNear = byId(near).get("haul:bank->ctrl")?.target ?? 0;
    const feederFar = byId(far).get("haul:bank->ctrl")?.target ?? 0;
    assert.isAbove(feederFar, feederNear, "distance costs CARRY on the consumption side too");
    assert.isAbove(far.expected.refillEt, near.expected.refillEt, "the bigger feed fleet's bills grow the obligation");
    assert.isAtMost(far.expected.upgradeEt, near.expected.upgradeEt, "and never buys MORE upgrading");
  });

  it("cascade A — empty ledger: the solvency filter leaves only the workman root standing", () => {
    const plan = replan(view());
    const corps = byId(plan);

    assert.deepEqual(corps.get("workman:srcA")?.body, { work: 1, carry: 1, move: 2 });
    assert.equal(corps.get("workman:srcA")?.target, 3, "spots-capped ramp");
    assert.equal(corps.get("workman:srcB")?.target, 3);
    assert.isUndefined(corps.get("mine:srcA"), "no specialist chain can close from a 300 stock");

    const insolvent = plan.frontier.filter(f => f.reason === "ramp insolvent").map(f => f.offerId);
    assert.includeMembers(insolvent, ["chain:srcA:specialist", "chain:srcB:specialist"]);

    // Residual after six workman bills funds one upgrader step.
    assert.equal(corps.get("upgrade:ctrl")?.target, 1);
    assert.deepEqual(corps.get("upgrade:ctrl")?.body, { work: 2, carry: 1, move: 1 });
  });

  it("cascade B — workmen alive: sunk capital holds its funding, the specialist chain trims in beside it", () => {
    const workman = { work: 1, carry: 1, move: 2 };
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 500,
        creeps: [1, 2, 3].map(n => ({ id: `wm${n}`, corp: "workman:srcA", body: workman, ttl: 400 }))
      })
    );
    const corps = byId(plan);

    const standing = corps.get("workman:srcA");
    assert.equal(standing?.target, 3);
    assert.equal(standing?.backed, 3, "living workmen keep their jobs — incumbency");
    assert.isNull(standing?.body, "nothing new to buy on this instance");

    // The challenger enters at the trimmed remainder of the regen cap.
    assert.equal(corps.get("mine:srcA")?.target, 1);
    assert.equal(corps.get("haul:srcA->bank")?.target, 1);
    assert.equal(corps.get("mine:srcB")?.target, 1);

    const backedRate = 3 * workmanCycleRate(workman, 10);
    assert.closeTo(plan.expected.deliveredEt, 20, 1e-9, "both sources at cap: trim made the shares exact");
    assert.closeTo(plan.expected.standingEt, backedRate, 1e-9, "the live fleet's share reported as standing");
    assert.isEmpty(plan.violations, "trimmed chains still clear the book — allocation, not capacity, is what nets");
    assert.notInclude(
      plan.frontier.map(f => f.reason),
      "ramp insolvent",
      "standing income lifts the solvency filter"
    );
  });

  it("cascade C — workmen expired: full displacement, the root reads outcompeted", () => {
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 500,
        creeps: [
          { id: "m1", corp: "mine:srcA", body: { work: 5, carry: 0, move: 1 }, ttl: 900 },
          { id: "h1", corp: "haul:srcA->bank", body: { work: 0, carry: 5, move: 5 }, ttl: 900 }
        ]
      })
    );
    const corps = byId(plan);

    assert.equal(corps.get("mine:srcA")?.backed, 1);
    assert.equal(corps.get("haul:srcA->bank")?.backed, 1);
    assert.isUndefined(corps.get("workman:srcA"), "no workman instance survives the developed economy");
    const beaten = plan.frontier.filter(f => f.reason === "outcompeted").map(f => f.offerId);
    assert.includeMembers(beaten, ["chain:srcA:workman", "chain:srcB:workman"]);
    assert.closeTo(plan.expected.deliveredEt, 20, 1e-9);
  });
});
