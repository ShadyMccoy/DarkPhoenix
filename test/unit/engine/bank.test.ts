import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView } from "../../../src/engine/view";
import {
  CONTAINER_COST,
  CONTAINER_HOLD_ET,
  STORAGE_COST,
  branchHoldingEt,
  pileDecayRate,
  reachableStock
} from "../../../src/primitives";

/**
 * Bank branches as real places (roadmap Tier 1.3): the bank's physical
 * branch has a HOLDING COST (piece 9 — the pile's convex decay is "the
 * bank's own cost line"), the branch ladder pile → container → storage
 * clears rung by rung on holding savings, and capex beyond a branch's
 * decay asymptote prints `capex unreachable` instead of pausing the
 * dividend forever chasing stock that can never accumulate.
 */

function view(over: Partial<EconomyView> = {}): EconomyView {
  return {
    tick: 100,
    bank: "bank",
    bankStock: 300,
    bankBranch: "pile",
    bodyBudget: 550,
    spawnIds: ["sp1"],
    estateRadius: 1,
    sources: [
      { id: "srcA", spots: 3, distToBank: 10 },
      { id: "srcB", spots: 3, distToBank: 12 }
    ],
    controller: { id: "ctrl", distFromBank: 1 },
    creeps: [],
    links: [],
    outposts: [],
    sites: [],
    roads: [],
    ...over
  };
}

describe("engine/bank — branches and holding (Tier 1.3)", () => {
  it("pins the ported decay laws: convex pile rot, container upkeep, the asymptote", () => {
    assert.equal(pileDecayRate(999), 1);
    assert.equal(pileDecayRate(1001), 2, "one energy over the boundary pays a whole extra e/t forever");
    assert.closeTo(CONTAINER_HOLD_ET, 0.1, 1e-9, "5000 hits / 500t / 100 hits-per-energy, owned");
    assert.closeTo(branchHoldingEt("pile", 2500, 0), 3, 1e-9);
    assert.equal(branchHoldingEt("pile", 300, 300), 0, "the estate's own stores are decay-free vessels");
    assert.closeTo(branchHoldingEt("container", 2500, 0), 0.1 + 1, 1e-9, "overflow above 2000 piles on the ground");
    assert.equal(branchHoldingEt("storage", 50000, 0), 0);
    assert.equal(reachableStock("pile", 16, 550), 16550, "a pile warchest asymptotes at vault + 1000·stream");
    assert.equal(reachableStock("storage", 1, 0), Infinity);
  });

  it("charges the branch's holding against the residual — rot is never free upgrading", () => {
    const rotting = replan(view({ bankStock: 5000 }));
    const clean = replan(view({ bankStock: 5000, bankBranch: "storage" }));
    assert.closeTo(rotting.expected.holdingEt, 5, 1e-9, "5000e less the 550e vault rots at ceil(4.45) = 5 e/t");
    assert.equal(clean.expected.holdingEt, 0);
    assert.isBelow(
      rotting.expected.upgradeEt + rotting.expected.warchestEt,
      clean.expected.upgradeEt + clean.expected.warchestEt,
      "the rot comes out of the dividend"
    );
  });

  it("clears the container rung on decay savings, one rung at a time", () => {
    // Edges pre-paved: road candidates would otherwise take the purse
    // first — investments compete for one spendable stock, honestly.
    const paved = [
      { from: "srcA", to: "bank", dist: 10 },
      { from: "srcB", to: "bank", dist: 12 }
    ];
    const plan = replan(view({ bankStock: 12000, roads: paved }));
    const rung = plan.approvals.find(a => a.structure === "container");
    assert.isOk(rung, "11 e/t of rot vs 0.1 e/t of upkeep: the capex clears at a glance");
    assert.equal(rung?.capex, CONTAINER_COST);
    assert.isEmpty(plan.approvals.filter(a => a.structure === "storage"), "the ladder moves one rung at a time");

    const open = replan(
      view({
        bankStock: 12000,
        roads: paved,
        sites: [{ id: "c1", structure: "container", at: "bank", dist: 1, total: 5000, remaining: 3000 }]
      })
    );
    assert.isEmpty(open.approvals.filter(a => a.structure === "container"), "an open branch site defers the next look");
  });

  it("prints `capex unreachable` for storage beyond the container's decay asymptote — the dividend never pauses for it", () => {
    // A two-source economy nets ~20 e/t: the container branch can hold
    // ~2000 + 1000·stream ≈ 22000e at best, and storage costs 30000e.
    // The old behavior would have parked the controller forever.
    const plan = replan(view({ bankStock: 12000, bankBranch: "container" }));
    const line = plan.frontier.find(f => f.offerId === "storage:bank");
    assert.equal(line?.reason, "capex unreachable", "the printed line IS the case for flow-funded capex");
    assert.isAbove(plan.expected.upgradeEt, 0, "the controller keeps drinking — no eternal pause");
    assert.equal(plan.expected.warchestEt, 0, "unreachable capex never joins the warchest target");
  });

  it("approves storage where the stream genuinely reaches it", () => {
    // Same world, stock already at 31000 (hand-staged): spendable covers
    // the 30000e outright — overflow rot of ~29 e/t pays for it 96x over.
    const plan = replan(view({ bankStock: 40000, bankBranch: "container" }));
    const rung = plan.approvals.find(a => a.structure === "storage");
    assert.isOk(rung);
    assert.equal(rung?.capex, STORAGE_COST);
  });
});
