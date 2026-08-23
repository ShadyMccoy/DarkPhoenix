import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView } from "../../../src/engine/view";
import { ROAD_COST_PER_TILE, ROAD_UPKEEP_ET_PER_TILE } from "../../../src/primitives";

/**
 * Roads (roadmap Tier 1.4): a route-cost modifier priced from the funded
 * plan's own traffic. Every busy edge is a three-way market — bodies
 * off-road, bodies on-road, the wire — and `roaded` is INSTANCE DATA
 * priced by one formula whose terms shift (REBOOT piece 2, by name):
 * the same edge, the same corp id, repriced as its route is paved.
 */

function view(over: Partial<EconomyView> = {}): EconomyView {
  return {
    tick: 100,
    bank: "bank",
    bankStock: 20000,
    bankBranch: "storage",
    bodyBudget: 550,
    spawnIds: ["sp1"],
    estateRadius: 1,
    sources: [{ id: "srcA", spots: 3, distToBank: 10 }],
    controller: { id: "ctrl", distFromBank: 1 },
    creeps: [],
    links: [],
    outposts: [],
    sites: [],
    roads: [],
    wireOptions: [],
    ...over
  };
}

describe("engine/road — the three-way edge market", () => {
  it("paves a busy edge where the gait saving clears the hurdle, and never under a winning wire", () => {
    const plan = replan(view());
    const road = plan.approvals.find(a => a.structure === "road" && a.edge?.from === "srcA");
    assert.isOk(road, "4 pairs off-road vs 2 roaded units: 0.057 e/t of fleet saved");
    assert.equal(road?.capex, 10 * ROAD_COST_PER_TILE);
    assert.include(road?.detail ?? "", "over H", "the hurdle arithmetic explains itself");

    // A far edge the WIRE wins gets no road — capex twice for one flow.
    const far = replan(
      view({
        sources: [{ id: "srcB", spots: 3, distToBank: 25 }],
        wireOptions: [{ from: "srcB", to: "bank", range: 25, missingMouth: true, missingHub: true }]
      })
    );
    assert.isOk(far.approvals.find(a => a.structure === "link" && a.edge?.from === "srcB"));
    assert.isUndefined(far.approvals.find(a => a.structure === "road" && a.edge?.from === "srcB"));
  });

  it("reprices the paved edge: same corp id, 2C:1M bodies, upkeep on the holding line", () => {
    const plan = replan(view({ roads: [{ from: "srcA", to: "bank", dist: 10 }] }));
    const haul = plan.corps.find(c => c.id === "haul:srcA->bank");
    assert.deepEqual(haul?.body, { work: 0, carry: 4, move: 2 }, "the roaded gait, same instance identity");
    assert.closeTo(plan.expected.holdingEt, 10 * ROAD_UPKEEP_ET_PER_TILE, 1e-9, "the network's upkeep, owed always");
    assert.isUndefined(
      plan.approvals.find(a => a.structure === "road" && a.edge?.from === "srcA"),
      "a paved route never re-approves"
    );
  });

  it("declines to pave a sliver flow — the roaded floor unit costs MORE than one bare pair", () => {
    // One spot at budget 300: a 2W miner moves 4 e/t; 2 CARRY of need
    // saves (200−150)/1500 − upkeep ≈ 0.023 e/t: under the 3000e hurdle.
    const plan = replan(
      view({ bodyBudget: 300, bankStock: 5000, sources: [{ id: "srcA", spots: 1, distToBank: 10 }] })
    );
    assert.isUndefined(plan.approvals.find(a => a.structure === "road"));
  });
});
