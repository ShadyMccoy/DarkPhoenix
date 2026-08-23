import { assert } from "chai";
import { roomOf, wireStations } from "../../lab/src/placement";
import { replan } from "../../src/engine/replan";
import { Scenario, assemble, emptyTerrain, setCell } from "../../lab/src/scenario";

/**
 * The spatial search (owner 2026-08-24: "break the room agnostic rule…
 * perform the spatial search to find the optimal link placements").
 * Rooms are 50×50 link-legality cells; link range is CHEBYSHEV and fires
 * through walls; the search picks station tiles per edge and the
 * assembly prices them into the view.
 */

function world(over: Partial<Scenario> = {}): Scenario {
  return {
    name: "placement",
    terrain: emptyTerrain(100, 100),
    spawn: { x: 24, y: 25 },
    bank: { x: 25, y: 25 },
    controller: { x: 28, y: 28 },
    sources: [],
    links: [],
    sites: [],
    extensions: [],
    bankBranch: "storage",
    roads: [],
    bankStock: 30000,
    bodyBudget: 550,
    creeps: [],
    ...over
  };
}

describe("lab/placement — rooms and the station search", () => {
  it("rooms are 50×50 grid cells", () => {
    assert.equal(roomOf({ x: 0, y: 0 }), "R0_0");
    assert.equal(roomOf({ x: 49, y: 49 }), "R0_0");
    assert.equal(roomOf({ x: 50, y: 49 }), "R1_0");
    assert.equal(roomOf({ x: 49, y: 50 }), "R0_1");
  });

  it("finds a same-room station pair and prices its Chebyshev range", () => {
    const s = world({ sources: [{ id: "srcA", x: 5, y: 25 }] });
    const w = wireStations(s, "srcA", "bank");
    assert.isOk(w);
    assert.isAtMost(Math.max(Math.abs(w!.mouth.x - 5), Math.abs(w!.mouth.y - 25)), 2, "mouth in the source's reach");
    assert.isAtMost(Math.max(Math.abs(w!.hub.x - 25), Math.abs(w!.hub.y - 25)), 2, "hub by the bank");
    assert.isAtMost(w!.range, 22, "argmin-range station choice");
    assert.isTrue(w!.missingMouth && w!.missingHub, "nothing stands yet");
  });

  it("refuses a wire across a room border — the ruling as a null", () => {
    const s = world({ sources: [{ id: "far", x: 75, y: 25 }] });
    assert.isNull(wireStations(s, "far", "bank"), "R1_0 cannot pair with R0_0");
  });

  it("pulls a border-hugging source's mouth to the LEGAL side", () => {
    // Source at x=51 (room R1_0) — but the bank sits in R0_0, and the
    // source's reach crosses the border: the search must pick a mouth at
    // x<=49 so the pair is legal.
    const s = world({ sources: [{ id: "edge", x: 51, y: 25 }] });
    const w = wireStations(s, "edge", "bank");
    assert.isOk(w, "the footprint crosses the border, so a legal mouth exists");
    assert.equal(roomOf(w!.mouth), "R0_0", "the mouth stands on the bank's side");
  });

  it("the wire is TERRAIN-IMMUNE: a canyon wall triples the haul path, the range ignores it", () => {
    const terrain = emptyTerrain(100, 100);
    for (let y = 0; y <= 45; y++) setCell(terrain, 15, y, "#");
    const s = world({ terrain, sources: [{ id: "canyon", x: 5, y: 25 }] });
    const view = assemble(s, [], s.bankStock, 0);
    const src = view.sources.find(v => v.id === "canyon");
    const wire = view.wireOptions.find(w => w.from === "canyon");
    assert.isAbove(src!.distToBank, 35, "the haul path detours around the wall (~2x the range)");
    assert.isAtMost(wire!.range, 22, "the wire fires straight through it");

    // And the market acts on it: the candidate wins the edge on a range
    // the fleet could never match, and the approval says so.
    const plan = replan(view);
    const approval = plan.approvals.find(a => a.structure === "link" && a.edge?.from === "canyon");
    assert.isOk(approval, "terrain that taxes bodies is free to the wire");
  });

  it("a hand-staged CROSS-ROOM pair never quotes: the edge stays on bodies", () => {
    const s = world({
      sources: [{ id: "far", x: 75, y: 25 }],
      links: [
        { id: "LF", x: 74, y: 24 },
        { id: "LB", x: 26, y: 24 }
      ]
    });
    const plan = replan(assemble(s, [], s.bankStock, 0));
    const corps = new Map(plan.corps.map(c => [c.id, c]));
    assert.isUndefined(corps.get("link:far->bank"), "an illegal pair is no pair");
    assert.isOk(corps.get("haul:far->bank"), "bodies keep the cross-room edge");
  });

  it("a standing hub never locks the other room out: a border bank keeps one hub per side", () => {
    // Bank at x=50 (room R1_0's west edge... here R1_0 sits east of the
    // border at x=50). A hub already stands WEST of the border (R0_0);
    // an east-room source must still get a wire — through a FRESH
    // east-side hub, not through the illegal standing one.
    const s = world({
      bank: { x: 50, y: 25 },
      spawn: { x: 51, y: 25 },
      sources: [{ id: "east", x: 75, y: 25 }],
      links: [{ id: "W", x: 48, y: 25 }]
    });
    const w = wireStations(s, "east", "bank");
    assert.isOk(w, "the standing west hub must not doom the east room to bodies");
    assert.equal(roomOf(w!.hub), "R1_0", "a fresh hub on the east side");
    assert.isTrue(w!.missingHub, "paid for, not reused");
  });

  it("reuses standing stations: hub built once, the next wire is mouth-only capex", () => {
    const s = world({
      sources: [
        { id: "s1", x: 5, y: 25 },
        { id: "s2", x: 25, y: 5 }
      ],
      links: [{ id: "HUB", x: 26, y: 24 }]
    });
    const w1 = wireStations(s, "s1", "bank");
    assert.isOk(w1);
    assert.isFalse(w1!.missingHub, "the standing hub is reused");
    assert.isTrue(w1!.missingMouth, "only the mouth is still to build");
  });
});
