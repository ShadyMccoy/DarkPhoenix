import { assert } from "chai";
import { replan } from "../../src/engine/replan";
import { assemble, distanceField, emptyTerrain, exportSave, importSave, setCell, spotsAt } from "../../lab/src/scenario";
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

  it("round-trips a save through export/import", () => {
    const s = bootstrapScenario();
    const save = { scenario: s, creeps: [], bankStock: 300, tick: 0, cp: 0 };
    assert.deepEqual(importSave(exportSave(save)), save);
    assert.throws(() => importSave("{}"), /not a lab save/);
  });
});
