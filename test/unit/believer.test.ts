import { assert } from "chai";
import { BelieverState, advanceChunk, planFor } from "../../lab/src/believer";
import { Scenario, emptyTerrain } from "../../lab/src/scenario";

/**
 * The INVESTMENT LOOP certified end to end on the believer (scenario
 * ladder tier 2: "hurdle → build → books → payback"): a far source runs
 * on bodies; its link candidate clears the hurdle but outruns the bank;
 * the warchest accumulates (controller dividend pauses); the approval
 * lands, the site appears, the build corp burns the capex down as cash;
 * the standing pair then wins the edge at marginal cost and the haul
 * fleet lapses. Construction takes TIME — the thing the old instant-build
 * stand-in hid.
 */

function farSourceWorld(): BelieverState {
  const scenario: Scenario = {
    name: "invest",
    terrain: emptyTerrain(),
    spawn: { x: 24, y: 25 },
    bank: { x: 25, y: 25 },
    controller: { x: 27, y: 26 },
    sources: [
      { id: "srcA", x: 18, y: 25 },
      { id: "srcB", x: 25, y: 2 }
    ],
    links: [],
    sites: [],
    extensions: [],
    bankBranch: "pile",
    roads: [],
    bankStock: 300,
    bodyBudget: 550,
    creeps: []
  };
  return { scenario, creeps: [], bankStock: 300, tick: 0, cp: 0, seq: 1 };
}

describe("lab/believer — the investment loop", () => {
  it("cold start → warchest → site → build → displacement, with construction time in the middle", () => {
    const state = farSourceWorld();
    let sawWarchest = false;
    let sawSite = false;
    let cpAtLinkSite = -1;

    for (let i = 0; i < 60; i++) {
      const plan = advanceChunk(state);
      if (plan.expected.warchestEt > 0) sawWarchest = true;
      if (state.scenario.sites.length > 0) sawSite = true;
      // Capture ONCE, at the link project's own start — the old
      // `if (cp === 0)` guard re-armed every chunk and certified a false
      // narrative (review finding: the first site was the extension).
      if (cpAtLinkSite < 0 && state.scenario.sites.some(s => s.structure === "link")) cpAtLinkSite = state.cp;
      // Loop closed: links stand and the far edge reprices to the wire.
      if (sawSite && state.scenario.sites.length === 0 && state.scenario.links.length >= 2) break;
    }

    assert.isTrue(sawWarchest, "the residual banked while the candidate awaited stock");
    assert.isTrue(sawSite, "the approval became a construction site");
    assert.isAtLeast(cpAtLinkSite, 0, "the link project actually opened");
    assert.lengthOf(state.scenario.sites, 0, "the project finished");
    assert.isAtLeast(state.scenario.links.length, 2, "both endpoints got their link");

    // Let the market settle on the new capital, then audit the plan.
    for (let i = 0; i < 4; i++) advanceChunk(state);
    const plan = planFor(state);
    const byId = new Map(plan.corps.map(c => [c.id, c]));
    const trunk = byId.get("link:srcB->bank");
    assert.isOk(trunk, "the standing pair holds the far edge");
    assert.equal(trunk?.backed, trunk?.target, "backed by structures, not purchases");
    assert.isUndefined(byId.get("haul:srcB->bank"), "the body fleet lapsed off the wired edge");
    assert.isOk(byId.get("haul:srcA->bank"), "the near edge stays on bodies — distance segments the network");
    assert.isEmpty(plan.violations, "the book clears across the whole arc");
    assert.isAbove(state.cp, cpAtLinkSite, "the dividend resumed after the investment");
  });
});
