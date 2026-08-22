/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain } from "./loadLayout";

/**
 * M1 — the v2 milestone gate (REBOOT.md ladder): from a bare two-source
 * room with one spawn, the bot must stand up an economy and reach RCL2,
 * unattended. Asserts OUTCOMES only: controller level, a standing fleet,
 * and a published plan — never internal shapes (v2 law #6).
 */
describe("v2 cold start (M1)", () => {
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  it("reaches RCL2 with a standing fleet within 600 ticks", async function () {
    this.timeout(300000);

    await helper.beforeEach(async world => {
      await loadLayout(world, {
        room: "W0N0",
        terrain: Array.from({ length: 50 }, () => ".".repeat(50)),
        objects: [
          { type: "controller", x: 25, y: 10 },
          { type: "source", x: 10, y: 40 },
          { type: "source", x: 40, y: 40 }
        ]
      });
      // Edge-adjacent paths touch neighbour terrain; pad it so the native
      // PathFinder has data (the kept-harness convention).
      await padNeighborTerrain(world, ["W0N0"]);
      await helper.addBot({ room: "W0N0", x: 25, y: 25 });
    });

    let level = 1;
    let ticksRun = 0;
    for (let t = 1; t <= 600; t += 1) {
      await helper.server.tick();
      ticksRun = t;
      if (t % 50 === 0) {
        const objects = await helper.server.world.roomObjects("W0N0");
        const controller = objects.find((o: any) => o.type === "controller");
        level = controller?.level ?? 1;
        if (level >= 2) break;
      }
    }

    const objects = await helper.server.world.roomObjects("W0N0");
    const controller = objects.find((o: any) => o.type === "controller");
    const creeps = objects.filter((o: any) => o.type === "creep");
    level = controller?.level ?? 1;

    assert.isAtLeast(level, 2, `controller must reach RCL2 (t${ticksRun}: level ${level}, progress ${controller?.progress ?? 0})`);
    assert.isAtLeast(creeps.length, 3, "a standing workman fleet, not a lone survivor");

    const mem = JSON.parse((await helper.player.memory) || "{}");
    assert.isArray(mem.plan?.jobs, "the plan is published state");
    assert.lengthOf(mem.plan.jobs, 2, "one work job per source");
  });
});
