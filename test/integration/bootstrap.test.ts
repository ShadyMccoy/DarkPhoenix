/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain } from "./loadLayout";

/**
 * Quality gate for the colony's early game: starting from a bare room with a
 * spawn, two sources and a controller, the bot must bootstrap a working economy
 * (spawn creeps, harvest, and upgrade the controller) without manual help.
 *
 * This is the regression guard for the bootstrap wiring - before it was fixed
 * the colony spawned a single scout and made zero controller progress forever.
 */
describe("colony bootstrap", () => {
  // Scoped to THIS suite: root-level hooks would run around every test in
  // every loaded file (mocha hoists them to the root suite) and cross-corrupt
  // the shared server helper between files.
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  it("harvests and upgrades the controller within 400 ticks", async function () {
    this.timeout(180000);

    await helper.beforeEach(async (world) => {
      await loadLayout(world, {
        room: "W0N0",
        terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
        objects: [
          { type: "controller", x: 25, y: 10 },
          { type: "source", x: 10, y: 40 },
          { type: "source", x: 40, y: 40 },
        ],
      });
      // Sources sit near the room edges; pad neighbours so the native
      // PathFinder doesn't throw "Could not load terrain data" when a creep
      // paths from an edge source to the controller.
      await padNeighborTerrain(world, ["W0N0"]);
      await helper.addBot({ room: "W0N0", x: 25, y: 25 });
    });

    // The population-gap check (spec 60 phase A) samples the reset-surviving
    // ring tail DURING the run: the tail keeps only the last ~40 rows, so by
    // t400 the flow economy's purchases may have evicted the cold-start rows.
    let jackRowSeen = false;
    for (let t = 1; t <= 400; t += 1) {
      await helper.server.tick();
      if (t % 100 === 0 && !jackRowSeen) {
        const mem = JSON.parse((await helper.player.memory) || "{}");
        const tail: any[] = mem.blackBoxTail ?? [];
        jackRowSeen = tail.some((r: any) => r.k === "spawn" && r.d?.role === "jack");
      }
    }

    const objects = await helper.server.world.roomObjects("W0N0");
    const creeps = objects.filter((o: any) => o.type === "creep").length;
    const controller = objects.find((o: any) => o.type === "controller");

    assert.isAbove(creeps, 1, "colony should spawn more than one working creep");

    const level = controller?.level ?? 1;
    const progress = controller?.progress ?? 0;
    assert.isTrue(
      level > 1 || progress > 0,
      `controller should make upgrade progress (level=${level}, progress=${progress})`
    );

    // SPEC 60 PHASE A - the purchase books itself at the contract door, so
    // bootstrap's cold-start jacks appear in BOTH books: the cumulative spend
    // ledger (the account's spend side) and the forensic BlackBox ring (read
    // here via its Memory tail). Before the door booked purchases itself,
    // BootstrapCorp hand-fed the ledger and filed no ring row, so the two
    // covered different creep populations.
    const mem = JSON.parse((await helper.player.memory) || "{}");
    const jackSpend = mem.spawnLedger?.energyByRole?.jack ?? 0;
    assert.isAbove(jackSpend, 0, "bootstrap jack purchases must accrue the spawn ledger");
    assert.isTrue(jackRowSeen, 'bootstrap jack purchases must file a forensic "spawn" ring row');
  });
});
