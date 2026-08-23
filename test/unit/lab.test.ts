import { assert } from "chai";
import { replan } from "../../src/engine/replan";
import { assemble, distanceField, emptyTerrain, exportSave, importSave, setCell, spotsAt } from "../../lab/src/scenario";
import { edgeLabel, edgesFor } from "../../lab/src/graph";
import { bootstrapScenario } from "../../lab/src/scenarios";

/**
 * The lab's pure half, driven headless: world assembly (real path
 * distances over terrain, spots from standing room) and the scenario
 * round-trip. The checked-in bootstrap scenario is replayed through the
 * REAL engine — the same modules the bot ships — pinning that the lab is
 * a certification host, not a mock.
 */
describe("lab/scenario", () => {
  it("derives path distances that respect walls", () => {
    const open = distanceField(emptyTerrain(), { x: 10, y: 10 });
    assert.equal(open[10][20], 10, "8-directional: a straight run costs its Chebyshev length");

    const walled = emptyTerrain();
    for (let y = 0; y <= 20; y++) setCell(walled, 15, y, "#");
    const detour = distanceField(walled, { x: 10, y: 10 });
    assert.isAbove(detour[10][20], 10, "the ridge forces a detour");
  });

  it("counts a source's standing room from terrain", () => {
    const t = emptyTerrain();
    assert.equal(spotsAt(t, { x: 10, y: 10 }), 8);
    setCell(t, 9, 10, "#");
    setCell(t, 9, 9, "#");
    assert.equal(spotsAt(t, { x: 10, y: 10 }), 6);
    assert.equal(spotsAt(t, { x: 0, y: 0 }), 3, "the map edge is standing room lost");
  });

  it("replays the checked-in bootstrap scenario through the real engine", () => {
    const s = bootstrapScenario();
    const view = assemble(s, [], s.bankStock, 0);
    assert.lengthOf(view.sources, 2);
    for (const src of view.sources) assert.isAbove(src.distToBank, 5, "sources sit away from the kernel");

    const plan = replan(view);
    const kinds = new Set(plan.corps.map(c => c.kind));
    assert.deepEqual(
      [...kinds].sort(),
      ["spawning", "upgrade", "workman"],
      "empty ledger: the root, the sink, and the heartbeat's tender"
    );
    assert.isTrue(
      plan.frontier.some(f => f.reason === "ramp insolvent"),
      "the specialist chains print why they cannot start"
    );

    assert.deepEqual(replan(assemble(s, [], s.bankStock, 0)), plan, "deterministic replay");
  });

  it("draws the plan's edges between the places each corp joins", () => {
    const s = bootstrapScenario();
    const plan = replan(assemble(s, [], s.bankStock, 0));

    const funded = edgesFor(s, plan, false);
    assert.isTrue(
      funded.every(e => e.funded),
      "asking for no blocked edges yields only funded ones"
    );
    // Every drawn edge is a corp the engine funded — the GUI invents none.
    const corpIds = new Set(plan.corps.map(c => c.id));
    for (const e of funded) assert.isTrue(corpIds.has(e.id), `${e.id} is a planned corp`);

    // The bootstrap plan runs fused workmen: source → bank, one per source.
    const workmen = funded.filter(e => e.kind === "workman");
    assert.lengthOf(workmen, s.sources.length);
    for (const w of workmen) {
      const src = s.sources.find(x => x.x === w.from.x && x.y === w.from.y);
      assert.isOk(src, "a workman edge starts at its source");
      assert.deepEqual(w.to, s.bank, "and ends at the bank");
    }

    // The sink runs the other way: bank → controller.
    const upgrade = funded.find(e => e.kind === "upgrade");
    assert.isOk(upgrade);
    assert.deepEqual(upgrade!.from, s.bank);
    assert.deepEqual(upgrade!.to, s.controller!);

    // Labels quote plan fields, never anything derived here.
    const w0 = workmen[0];
    assert.include(edgeLabel(w0), w0.netEt.toFixed(1));
    assert.include(edgeLabel(w0), `${w0.backed}/${w0.target}`);

    // The blocked frontier is drawable too — that is the point of the layer.
    const withBlocked = edgesFor(s, plan, true);
    const blocked = withBlocked.filter(e => !e.funded);
    assert.isNotEmpty(blocked, "the insolvent specialist chains draw as blocked");
    for (const b of blocked) {
      assert.isOk(b.reason, "a blocked edge carries the engine's own reason");
      assert.isTrue(
        plan.frontier.some(f => f.offerId === b.id && f.reason === b.reason),
        `${b.id} matches its frontier line`
      );
    }
  });

  it("places a controller-less world's edges without inventing a controller", () => {
    const s = bootstrapScenario();
    s.controller = null;
    const plan = replan(assemble(s, [], s.bankStock, 0));
    const edges = edgesFor(s, plan, true);
    assert.isEmpty(
      edges.filter(e => e.kind === "upgrade"),
      "no controller, no upgrade edge"
    );
  });

  it("round-trips a save through export/import", () => {
    const s = bootstrapScenario();
    const save = { scenario: s, creeps: [], bankStock: 300, tick: 0, cp: 0 };
    assert.deepEqual(importSave(exportSave(save)), save);
    assert.throws(() => importSave("{}"), /not a lab save/);
  });
});
