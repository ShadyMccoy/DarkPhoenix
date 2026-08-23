import { assert } from "chai";
import { replan } from "../../../src/engine/replan";
import { EconomyView } from "../../../src/engine/view";

/**
 * Trunk routing under the displacement ruling (owner 2026-08-24: a far
 * member opting out of a standing tree "would be leaving link transfer
 * capacity on the table — we could displace more hauling"): the trunk's
 * pair, range, and therefore ration come from the LEGAL closest pair
 * (linkPair), never from whichever bank link assembled first; and when
 * the ration truly binds, slices go to the sources whose direct hauling
 * is most expensive to keep — merit, not array order.
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
    sources: [],
    controller: { id: "ctrl", distFromBank: 1 },
    creeps: [],
    links: [],
    outposts: [],
    sites: [],
    roads: [],
    wireOptions: [],
    stationOptions: [],
    ...over
  };
}

describe("engine/trunk — the tree keeps its far members", () => {
  it("rations the trunk from the LEGAL pair: a border bank's off-room hub must not shrink the ration", () => {
    // Two hubs stand at the bank (one per room, the border-bank shape).
    // The station's legal partner is the same-room hub at range 23
    // (ration 34.8): all three members fit. Pairing with the first-found
    // off-room hub (range 27, ration 29.6) shed the third member by
    // 0.37 e/t of phantom shortfall — the settled-forest e3 stall.
    const plan = replan(
      view({
        links: [
          { id: "hubW", at: "bank", room: "R0_1", x: 48, y: 83 },
          { id: "hubE", at: "bank", room: "R1_1", x: 52, y: 83 },
          { id: "st", at: "outpost:st", room: "R1_1", x: 75, y: 61 }
        ],
        outposts: [{ place: "outpost:st", distToSource: { a: 2, b: 2, c: 4 } }],
        sources: [
          { id: "a", spots: 3, distToBank: 26 },
          { id: "b", spots: 3, distToBank: 27 },
          { id: "c", spots: 3, distToBank: 19 }
        ]
      })
    );
    const corps = new Map(plan.corps.map(c => [c.id, c]));
    for (const m of ["a", "b", "c"]) {
      assert.isOk(corps.get(`haul:${m}->outpost:st`), `${m} collects into the station`);
      assert.isUndefined(corps.get(`haul:${m}->bank`), `${m} runs no direct route`);
    }
    assert.equal(corps.get("link:outpost:st->bank")?.target, 3, "one slice per member on the legal trunk");
    assert.isEmpty(plan.violations, "the book audits the joint");
  });

  it("a source with a standing direct wire never rides a tree: 3% flat beats leg + tax + tax", () => {
    // wired's own mouth->hub pair stands. The body-unit heuristic saw
    // direct bodies at 26 tiles vs a 3-tile collector leg and pulled it
    // onto the trunk — a double-taxed relay stealing a slice. The wire's
    // marginal is the same tax with NO leg: direct, always.
    const plan = replan(
      view({
        links: [
          { id: "hubE", at: "bank", room: "R1_1", x: 52, y: 83 },
          { id: "mouth", at: "wired", room: "R1_1", x: 90, y: 60 },
          { id: "st", at: "outpost:st", room: "R1_1", x: 88, y: 62 }
        ],
        outposts: [{ place: "outpost:st", distToSource: { wired: 3, other: 3 } }],
        sources: [
          { id: "wired", spots: 3, distToBank: 26 },
          { id: "other", spots: 3, distToBank: 25 }
        ]
      })
    );
    const corps = new Map(plan.corps.map(c => [c.id, c]));
    assert.isOk(corps.get("link:wired->bank"), "the standing wire keeps its edge");
    assert.isUndefined(corps.get("haul:wired->outpost:st"), "no collector leg for a wired source");
    assert.isOk(corps.get("haul:other->outpost:st"), "the unwired neighbor still rides");
    assert.isEmpty(plan.violations, "the book audits the joint");
  });

  it("a binding ration sheds the CHEAPEST direct haul, not whoever iterates last", () => {
    // Range 28 → ration 28.6 e/t: two whole supplies fit, one must stay
    // direct. The near source (smallest displaced bill) iterates FIRST —
    // first-come slicing would seat it and shed farB; merit seats the
    // two far members and leaves the near one on its cheap direct route.
    const plan = replan(
      view({
        links: [
          { id: "hubE", at: "bank", room: "R1_1", x: 52, y: 83 },
          { id: "st", at: "outpost:st", room: "R1_1", x: 80, y: 57 }
        ],
        outposts: [{ place: "outpost:st", distToSource: { near: 3, farA: 3, farB: 3 } }],
        sources: [
          { id: "near", spots: 3, distToBank: 16 },
          { id: "farA", spots: 3, distToBank: 25 },
          { id: "farB", spots: 3, distToBank: 26 }
        ]
      })
    );
    const corps = new Map(plan.corps.map(c => [c.id, c]));
    assert.isOk(corps.get("haul:farA->outpost:st"), "farA rides the trunk");
    assert.isOk(corps.get("haul:farB->outpost:st"), "farB rides the trunk — merit beats iteration order");
    assert.isOk(corps.get("haul:near->bank"), "the near source keeps its cheap direct route");
    assert.isUndefined(corps.get("haul:near->outpost:st"), "the near source holds no slice");
    assert.equal(corps.get("link:outpost:st->bank")?.target, 2, "exactly the two slices the ration affords");
    assert.isEmpty(plan.violations, "the book audits the joint");
  });
});
