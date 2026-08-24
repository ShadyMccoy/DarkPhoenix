import { assert } from "chai";
import { planNetwork, roomOf, stationSearch, wireStations } from "../../lab/src/placement";
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
    linkBudget: 6,
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

  it("scarce links buy the BRANCHING TREE: one shared station for the cluster, not private mouths", () => {
    // Three clustered sources, a budget of TWO links (station + hub).
    // Private mouths would want four; the network plan consolidates:
    // M1..M3 short-haul into one station, which fires to the bank hub
    // (owner 2026-08-24, the tree made arithmetic).
    const s = world({
      linkBudget: 2,
      bank: { x: 36, y: 36 },
      spawn: { x: 35, y: 36 },
      controller: { x: 39, y: 39 },
      sources: [
        { id: "m1", x: 12, y: 10 },
        { id: "m2", x: 10, y: 16 },
        { id: "m3", x: 16, y: 7 }
      ]
    });
    const dists = { m1: 25, m2: 24, m3: 27 };
    const net = planNetwork(s, dists);
    assert.isEmpty(net.mouths, "no source is worth a private link under this budget");
    assert.lengthOf(net.stations, 1, "one shared station serves the cluster");
    assert.deepEqual(net.stations[0].sources.map(x => x.id).sort(), ["m1", "m2", "m3"]);
    assert.isAtMost(Math.max(...net.stations[0].sources.map(x => x.collectRange)), 8, "short collector legs");
    assert.isAtLeast(800 / net.stations[0].range, 30, "the sender's ration covers all three flows");

    // And the assembly hands the engine exactly this: no per-source wire
    // options, one station option.
    const view = assemble(s, [], s.bankStock, 0);
    assert.isEmpty(view.wireOptions.filter(w => w.to === "bank"));
    assert.lengthOf(view.stationOptions, 1);
  });

  it("places the station to DISPLACE hauling, not to split legs evenly (owner 2026-08-24)", () => {
    // A far member and a marginal one. The fleet bill is a staircase, so
    // the summed-range objective is TIED across the whole between-region
    // — and the centroid tiebreak splits legs evenly, pricing the
    // marginal member out (its saving band is one CARRY pair wide). The
    // displacement objective shifts one plateau over, keeps both, and
    // displaces strictly more hauling for the same links.
    const s = world({
      terrain: emptyTerrain(50, 50),
      bank: { x: 5, y: 25 },
      spawn: { x: 4, y: 25 },
      controller: { x: 5, y: 28 },
      sources: [
        { id: "far", x: 34, y: 25 },
        { id: "mid", x: 22, y: 25 }
      ]
    });
    const search = stationSearch(s, ["far", "mid"]);
    assert.isOk(search, "the pair stations");
    assert.deepEqual(
      search!.members.map(m => m.id).sort(),
      ["far", "mid"],
      "the marginal member is kept — shedding it leaves trunk capacity idle"
    );
    const mid = search!.members.find(m => m.id === "mid");
    assert.isAtMost(mid!.collectRange, 5, "the tile shifted into the marginal member's paying band");
    for (const m of search!.members) assert.isAbove(m.saving, 0, `${m.id} genuinely pays`);

    // And the honest opposite: a member whose direct route is too cheap
    // to ever pay the tax stays out — "only close ones opt out".
    const close = world({
      terrain: emptyTerrain(50, 50),
      bank: { x: 5, y: 25 },
      spawn: { x: 4, y: 25 },
      controller: { x: 5, y: 28 },
      sources: [
        { id: "far", x: 34, y: 25 },
        { id: "mid", x: 20, y: 25 }
      ]
    });
    assert.isNull(stationSearch(close, ["far", "mid"]), "one paying member is no station");
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
