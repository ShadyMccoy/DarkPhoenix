/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout } from "./loadLayout";

before(() => hookConsole());
afterEach(async () => helper.afterEach());

/**
 * Quality gate for the colony's early game: starting from a bare room with a
 * spawn, two sources and a controller, the bot must bootstrap a working economy
 * (spawn creeps, harvest, and upgrade the controller) without manual help.
 *
 * This is the regression guard for the bootstrap wiring - before it was fixed
 * the colony spawned a single scout and made zero controller progress forever.
 */
describe("colony bootstrap", () => {
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
      await helper.addBot({ room: "W0N0", x: 25, y: 25 });
    });

    for (let t = 1; t <= 400; t += 1) {
      await helper.server.tick();
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
  });
});
