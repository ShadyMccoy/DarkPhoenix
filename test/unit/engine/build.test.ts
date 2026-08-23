import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView } from "../../../src/engine/view";

/**
 * The build corp and the investment pipeline (roadmap Tier 1.1, owner
 * 2026-08-23: "Build corp — the missing verb; retires the believer as
 * interim builder").
 *
 * The pipeline, end to end: a funded haul edge generates a link CANDIDATE
 * (traffic generates infrastructure candidates — piece 7); a candidate that
 * beats the incumbent's unit cost is APPROVED when the bank's spendable
 * stock covers its capex (investments draw from stock — piece 9), else it
 * prints `awaiting stock` and the WARCHEST accumulates toward it; an
 * approval becomes a SITE; the build corp burns energy at the site (capex
 * leaves the bank as build flow, never as a rate against the residual);
 * the standing structure then wins its edge at marginal cost.
 *
 * The candidate never sits in the transport order book: it cannot move
 * energy today, and static clearing would fund it over the workable haul
 * option behind it — stranding the whole edge's flow for the entire
 * construction window (the session finding that forced this shape).
 */

function view(over: Partial<EconomyView> = {}): EconomyView {
  return {
    tick: 100,
    bank: "bank",
    bankStock: 300,
    bankBranch: "storage",
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
    sites: [],
    roads: [],
    // The placement search's output, staged: both edges have legal
    // same-room station pairs at these ranges (no search runs on a pure
    // engine view — the lab's assembly supplies this in real worlds).
    wireOptions: [
      { from: "srcA", to: "bank", range: 10, missingMouth: true, missingHub: true },
      { from: "srcB", to: "bank", range: 25, missingMouth: true, missingHub: true }
    ],
    ...over
  };
}

function byId(plan: ReturnType<typeof replan>): Map<string, ReturnType<typeof replan>["corps"][number]> {
  return new Map(plan.corps.map(c => [c.id, c]));
}

describe("engine/build — the investment pipeline", () => {
  it("approves a link where the candidate beats the incumbent, and the flow KEEPS HAULING meanwhile", () => {
    const plan = replan(view({ bodyBudget: 550, bankStock: 20000 }));
    const corps = byId(plan);

    // srcB (25 tiles): candidate unit (3% tax + 10000e/H over 10 e/t =
    // 0.04/unit) beats two hauler bodies (0.667 e/t on 10 = 0.067/unit).
    const approval = plan.approvals.find(a => a.structure === "link" && a.edge?.from === "srcB");
    assert.isOk(approval, "the far edge's candidate is approved");
    assert.equal(approval?.capex, 10000, "both endpoints missing: two links");

    // The restructure's point: approval is not transport. The edge still
    // runs on bodies until the structure STANDS — nothing strands.
    assert.equal(corps.get("haul:srcB->bank")?.target, 2, "interim coverage holds");
    assert.isUndefined(corps.get("link:srcB->bank"), "nothing standing, nothing funded as transport");

    // srcA (10 tiles): one 0.27 e/t hauler beats the candidate's
    // 0.04/unit — no WIRE where distance doesn't justify it. (The edge
    // paves instead: the road is the near edge's winning investment.)
    assert.isUndefined(plan.approvals.find(a => a.structure === "link" && a.edge?.from === "srcA"));
    assert.isOk(plan.approvals.find(a => a.structure === "road" && a.edge?.from === "srcA"));
    assert.equal(corps.get("haul:srcA->bank")?.target, 1);
  });

  it("prints `awaiting stock` when the winning candidate outruns the bank, and the warchest diverts toward it", () => {
    const plan = replan(view({ bodyBudget: 550, bankStock: 2000 }));

    assert.isEmpty(
      plan.approvals.filter(a => a.structure === "link"),
      "2000e cannot pay 10000e of capex (the near edge's cheap road may still clear)"
    );
    const line = plan.frontier.find(f => f.reason === "awaiting stock" && f.offerId === "link:srcB->bank");
    assert.isOk(line, "the blocked investment prints its reason");
    assert.include(line?.detail ?? "", "10000", "the arithmetic names the capex");

    // The warchest: while a cleared investment awaits stock, the residual
    // banks instead of burning (production over consumption, piece 9's
    // reserve band). The controller's dividend pauses.
    assert.isAbove(plan.expected.warchestEt, 0, "the residual diverts to the warchest");
    assert.equal(plan.expected.upgradeEt, 0, "the controller drinks nothing while the bank accumulates");
    const upgradeLine = plan.frontier.find(f => f.offerId === "upgrade:ctrl");
    assert.isOk(upgradeLine, "the paused sink prints why");
  });

  it("with no cleared candidate awaiting, the warchest is zero and the controller drinks the residual", () => {
    const plan = replan(view({ bodyBudget: 550, bankStock: 20000 }));
    assert.equal(plan.expected.warchestEt, 0);
    assert.isAbove(plan.expected.upgradeEt, 0);
  });

  it("a site employs the build corp: transport feeds it, builders burn it, capex draws STOCK not residual", () => {
    const withSite = replan(
      view({
        bodyBudget: 550,
        bankStock: 20000,
        sites: [{ id: "s1", structure: "link", at: "site:s1", dist: 20, total: 5000, remaining: 5000 }]
      })
    );
    const corps = byId(withSite);

    // 5000e over the project window (300t, one source-regen period) is a
    // 16.67 e/t burn: one 4W builder (20 e/t capacity), trimmed.
    const build = corps.get("build:s1");
    assert.isOk(build, "the build corp exists for the site");
    assert.deepEqual(build?.body, { work: 4, carry: 1, move: 1 });
    assert.equal(build?.target, 1);
    assert.closeTo(withSite.expected.buildEt, 5000 / 300, 1e-9);

    // The site is a real place: transport covers it, the book audits it.
    assert.equal(corps.get("haul:bank->site:s1")?.target, 3, "16.67 e/t over 20 tiles: three 5C bodies");
    assert.isEmpty(withSite.violations, "the site place clears — supply in, burn out");

    // Capex is a stock draw (piece 9: investments draw from stock, not
    // live flow): the bank's rate column goes NEGATIVE by exactly the burn.
    const bank = withSite.positions.find(p => p.place === "bank");
    const e = withSite.expected;
    assert.closeTo(bank?.netEt ?? NaN, e.deliveredEt - e.refillEt - e.feesEt - e.upgradeEt - e.buildEt, 1e-9);

    // Only the build FLEET'S BILLS (~1.37 e/t) ride the residual; the
    // 16.67 e/t burn itself draws stock. The controller loses exactly ONE
    // quantized upgrader step to the bills — if the burn rode the residual
    // it would lose four.
    const without = replan(view({ bodyBudget: 550, bankStock: 20000 }));
    assert.closeTo(without.expected.upgradeEt, 244 / 15, 1e-9);
    assert.closeTo(e.upgradeEt, 46 / 3, 1e-9, "the residual loses the bills (~0.93 e/t), never the 16.67 burn");
  });

  it("does not re-approve an edge whose site is already under construction", () => {
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 20000,
        sites: [
          { id: "s1", structure: "link", at: "site:s1", dist: 25, total: 10000, remaining: 4000, edge: { from: "srcB", to: "bank" } }
        ]
      })
    );
    assert.isEmpty(
      plan.approvals.filter(a => a.edge?.from === "srcB"),
      "the open site suppresses the candidate"
    );
  });

  it("commits open sites against the spendable stock before approving more", () => {
    // Stock 12000, but 4000 already committed to an open site elsewhere:
    // spendable 8000 < 10000 capex — the srcB candidate must wait.
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 12000,
        sites: [
          { id: "s9", structure: "link", at: "site:s9", dist: 8, total: 4000, remaining: 4000, edge: { from: "elsewhere", to: "bank" } }
        ]
      })
    );
    assert.isEmpty(plan.approvals.filter(a => a.edge?.from === "srcB"));
    assert.isOk(plan.frontier.find(f => f.reason === "awaiting stock"));
  });

  it("prints `tender short` when even the derived refill schedule cannot carry the heartbeat", () => {
    // The schedule now sizes itself to the obligation (a const schedule
    // was the finding), but a spread estate (radius 30) caps intake at
    // 12 bodies x ~1.67 = 20 e/t while twenty big haulers owe 33 e/t of
    // sustain alone. Three spawns keep machine time from binding first.
    const bigHauler = { work: 0, carry: 25, move: 25 };
    const plan = replan(
      view({
        bodyBudget: 550,
        bankStock: 2000,
        estateRadius: 30,
        spawnIds: ["sp1", "sp2", "sp3"],
        creeps: Array.from({ length: 20 }, (_, i) => ({
          id: `bh${i}`,
          corp: "haul:srcA->bank",
          body: bigHauler,
          ttl: 1000
        }))
      })
    );
    const line = plan.frontier.find(f => f.reason === "tender short");
    assert.isOk(line, "an uncovered heartbeat is never silent");
  });
});
