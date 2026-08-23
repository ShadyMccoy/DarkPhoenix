import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView } from "../../../src/engine/view";
import { EXTENSION_CAPACITY, EXTENSION_COST, HORIZON } from "../../../src/primitives";

/**
 * Extensions as investment (roadmap Tier 1.2): bodyBudget becomes
 * ENDOGENOUS. The extension is the engine's first GLOBAL candidate — its
 * payoff is a change in every quote at once, so no order book can price
 * it. The planner prices it by COUNTERFACTUAL DIFFERENCING: the same
 * machinery clears the +50e world, and the plans' difference in
 * controller stream meets the piece-9 hurdle (Δ CP/t × H vs capex).
 *
 * The anti-thrash content is the NEGATIVE case: v1 built extensions on a
 * schedule; v2 builds one only when the market says bigger bodies pay.
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
    sources: [{ id: "srcA", spots: 1, distToBank: 10 }],
    controller: { id: "ctrl", distFromBank: 1 },
    creeps: [],
    links: [],
    outposts: [],
    sites: [],
    roads: [],
    ...over
  };
}

describe("engine/extension — the first global candidate", () => {
  it("a spots-starved source makes the extension pay: bigger miner bodies clear the hurdle", () => {
    // One spot, budget 300: the miner caps at 2W = 4 e/t against a 10 e/t
    // source. +50e budget buys a 3W miner: +2 e/t through to the
    // controller — worth ~200k over H against 3000e capex.
    const plan = replan(view({ bankStock: 5000 }));
    const approval = plan.approvals.find(a => a.structure === "extension");
    assert.isOk(approval, "the counterfactual plan showed the bigger body paying");
    assert.equal(approval?.capex, EXTENSION_COST);
    assert.include(approval?.detail ?? "", "over H", "the hurdle arithmetic explains itself");
  });

  it("awaits stock like any investment when the bank cannot pay", () => {
    // 2000e: enough to ramp the specialists (so the counterfactual can
    // SEE the bigger body paying — behind the ramp filter the Δ is
    // invisible, a recorded myopia of depth-0 differencing), not enough
    // for the 3000e capex.
    const plan = replan(view({ bankStock: 2000 }));
    assert.isEmpty(plan.approvals.filter(a => a.structure === "extension"));
    const line = plan.frontier.find(f => f.offerId === "extension:estate");
    assert.equal(line?.reason, "awaiting stock");
    assert.isAbove(plan.expected.warchestEt, 0, "the residual banks toward the estate");
  });

  it("approves NOTHING when every body is already capped — the anti-thrash negative case", () => {
    // Budget 2600: miner capped at 5W (550), upgrader at its own quantum,
    // haulers sized to flow. +50 changes no quote enough to clear 3000e.
    const plan = replan(
      view({
        bodyBudget: 2600,
        bankStock: 50000,
        sources: [
          { id: "srcA", spots: 3, distToBank: 10 },
          { id: "srcB", spots: 3, distToBank: 12 }
        ]
      })
    );
    assert.isEmpty(
      plan.approvals.filter(a => a.structure === "extension"),
      "no schedule builds extensions; only a paying Δ does"
    );
    // Sanity on the hurdle's own arithmetic: 0.03 e/t is the break-even.
    assert.closeTo(EXTENSION_COST / HORIZON, 0.03, 1e-9);
    assert.equal(EXTENSION_CAPACITY, 50);
  });

  it("an open extension site defers the next extension evaluation", () => {
    const plan = replan(
      view({
        bankStock: 20000,
        sites: [{ id: "e1", structure: "extension", at: "bank", dist: 1, total: 3000, remaining: 2000 }]
      })
    );
    assert.isEmpty(plan.approvals.filter(a => a.structure === "extension"));
    assert.isUndefined(plan.frontier.find(f => f.offerId === "extension:estate"));
  });

  it("a grown estate cold-restarts without deadlock: the survival budget floors at the spawn's 300", () => {
    // Global reset with 5 extensions standing and everything dead: the
    // estate quotes 550e bodies the 300e bank can never load. The
    // survival law sizes to cash-in-hand — the world must boot.
    const plan = replan(view({ bodyBudget: 550, bankStock: 300, sources: [{ id: "srcA", spots: 3, distToBank: 10 }] }));
    const workman = plan.corps.find(c => c.kind === "workman");
    assert.isOk(workman, "an affordable root funds");
    assert.isAbove(workman?.target ?? 0, 0);
  });
});
