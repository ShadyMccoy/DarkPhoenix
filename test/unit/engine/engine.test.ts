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
    links: [],
    outposts: [],
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
    const leftover =
      plan.expected.deliveredEt - plan.expected.refillEt - plan.expected.feesEt - plan.expected.upgradeEt;
    assert.closeTo(bank?.netEt ?? NaN, leftover, 1e-9);

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

  it("a standing link pair wins its edge at marginal cost; nearby edges stay with bodies", () => {
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 2000,
        links: [
          { id: "L1", at: "srcB" },
          { id: "L2", at: "bank" }
        ]
      })
    );
    const corps = byId(plan);

    // srcB (25 tiles): the pair moves 10 e/t for a 0.3 tax and no spawn
    // time — it beats two hauler bodies and takes the whole edge.
    const linkB = corps.get("link:srcB->bank");
    assert.equal(linkB?.target, 1);
    assert.equal(linkB?.backed, 1, "standing structures back the step");
    assert.isUndefined(corps.get("haul:srcB->bank"), "bodies lost the far edge");
    assert.closeTo(linkB?.outputs.energyAt?.["bank"] ?? 0, 10, 1e-9, "allocated to the mine's real flow");

    // srcA (10 tiles): a hauler body is still the cheaper unit — the same
    // market splits the network by distance, no logistics module deciding.
    assert.equal(corps.get("haul:srcA->bank")?.target, 1);
    assert.isUndefined(corps.get("link:srcA->bank"));

    assert.closeTo(plan.expected.feesEt, 0.3, 1e-9, "the 3% tax on 10 e/t");
    assert.isEmpty(plan.violations);
    const bank = plan.positions.find(p => p.place === "bank");
    const leftover =
      plan.expected.deliveredEt - plan.expected.refillEt - plan.expected.feesEt - plan.expected.upgradeEt;
    assert.closeTo(bank?.netEt ?? NaN, leftover, 1e-9, "conservation holds with fees on the books");
  });

  it("a CANDIDATE link prices at full cost — capex over the horizon — and wins only where distance justifies it", () => {
    const plan = replan(view({ bodyBudget: 550, bankStock: 20000 }));
    const corps = byId(plan);

    // srcB: tax 0.3 + 10000e/100k = 0.4 e/t beats two haulers at 0.67 —
    // the investment clears; the believer (or the owner) builds the pair.
    const candidate = corps.get("link:srcB->bank");
    assert.equal(candidate?.target, 1);
    assert.equal(candidate?.backed, 0, "nothing stands yet: this is an approved build");
    assert.isUndefined(corps.get("haul:srcB->bank"));

    // srcA: the same candidate arithmetic loses to one 0.33 e/t hauler.
    assert.equal(corps.get("haul:srcA->bank")?.target, 1);
    assert.isUndefined(corps.get("link:srcA->bank"));
  });

  it("consolidates far sources through a link outpost: short collectors, one shared trunk, the book audits the joint", () => {
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 2000,
        sources: [
          { id: "src1", spots: 3, distToBank: 30 },
          { id: "src2", spots: 3, distToBank: 32 },
          { id: "src3", spots: 3, distToBank: 34 }
        ],
        links: [
          { id: "L1", at: "outpost:L1" },
          { id: "LB", at: "bank" }
        ],
        outposts: [{ place: "outpost:L1", distToBank: 20, distToSource: { src1: 5, src2: 5, src3: 5 } }]
      })
    );
    const corps = byId(plan);

    // Three short collector legs converge on the outpost...
    for (const src of ["src1", "src2", "src3"]) {
      assert.equal(corps.get(`haul:${src}->outpost:L1`)?.target, 1, `${src} collects to the outpost`);
      assert.isUndefined(corps.get(`haul:${src}->bank`), `${src} runs no direct route`);
    }
    // ...and ONE standing pair trunks them all: a slice per source.
    const trunk = corps.get("link:outpost:L1->bank");
    assert.equal(trunk?.target, 3, "three slices of one pair");
    assert.equal(trunk?.backed, 3);
    assert.closeTo(trunk?.outputs.energyAt?.["bank"] ?? 0, 30, 1e-9);

    assert.closeTo(plan.expected.deliveredEt, 30, 1e-9);
    assert.isEmpty(plan.violations, "the outpost place clears: collectors in, trunk out");
    const joint = plan.positions.find(p => p.place === "outpost:L1");
    assert.closeTo(joint?.netEt ?? NaN, 0, 0.01);
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
