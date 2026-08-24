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
    linkBudget: 6,
    bankStock: 300,
    bodyBudget: 550,
    creeps: []
  };
  return { scenario, creeps: [], bankStock: 300, tick: 0, cp: 0, seq: 1 };
}

describe("lab/believer — the investment loop", () => {
  it("builds the branching tree under a scarce link budget: collectors into one station, one trunk to the hub", () => {
    const scenario: Scenario = {
      name: "tree",
      terrain: emptyTerrain(50, 50),
      spawn: { x: 35, y: 36 },
      bank: { x: 36, y: 36 },
      controller: { x: 38, y: 38 },
      sources: [
        { id: "m1", x: 12, y: 10 },
        { id: "m2", x: 10, y: 16 },
        { id: "m3", x: 16, y: 7 }
      ],
      links: [],
      sites: [],
      extensions: [],
      bankBranch: "storage",
      roads: [],
      linkBudget: 2,
      bankStock: 30000,
      bodyBudget: 550,
      creeps: []
    };
    const state: BelieverState = { scenario, creeps: [], bankStock: 30000, tick: 0, cp: 0, seq: 1 };

    let treed = false;
    for (let i = 0; i < 50 && !treed; i++) {
      advanceChunk(state);
      treed = state.scenario.links.length >= 2 && state.scenario.sites.length === 0 && i > 2;
    }
    assert.isTrue(treed, "station and hub stand");
    assert.equal(state.scenario.links.length, 2, "the budget held: exactly two links");

    const plan = planFor(state);
    const corps = new Map(plan.corps.map(c => [c.id, c]));
    const outpost = plan.corps.find(c => c.kind === "link" && c.id.indexOf("outpost:") > 0);
    assert.isOk(outpost, "the station assembled as an OUTPOST and the trunk holds it");
    const outpostPlace = outpost!.id.slice("link:".length).split("->")[0];
    for (const m of ["m1", "m2", "m3"]) {
      assert.isOk(corps.get(`haul:${m}->${outpostPlace}`), `${m} short-hauls into the station`);
      assert.isUndefined(corps.get(`haul:${m}->bank`), `${m} runs no direct route`);
    }
    assert.isEmpty(plan.violations, "the book audits the joint");
    // Addendum 4 (ratified 2026-08-24): the port anatomy follows the
    // tree — the buffer container approves as the standing trunk's
    // OBLIGATION and gets built, and the throat is hired as the trunk
    // corp's own body. Mouth (container), throat (tender), pipe (link).
    let anatomy = false;
    for (let i = 0; i < 30 && !anatomy; i++) {
      const p = advanceChunk(state);
      const trunkId = p.corps.find(c => c.kind === "link" && c.id.indexOf("outpost:") > 0)?.id;
      anatomy =
        (state.scenario.containers ?? []).length === 1 &&
        !!trunkId &&
        state.creeps.some(c => c.corp === trunkId);
    }
    assert.isTrue(anatomy, "the port grew its buffer and its throat");
    assert.isAbove(state.cp, 0, "and the dividend flows once the invest queue clears");
  });

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
