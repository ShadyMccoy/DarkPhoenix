/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-antidowngrade - verify BootstrapCorp.runAntiDowngrade rescues a room
 * whose controller is about to downgrade.
 *
 * Starts a room at RCL 2, forces the controller's downgrade timer dangerously
 * low, then watches: a rescue jack should spawn, upgrade the controller until
 * the timer climbs back above the safe threshold, then recycle itself.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { startAtRcl } from "../test/integration/startAtRcl";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function main(): Promise<void> {
  const ticks = Number(process.argv[2] ?? 400);
  const port = 25200;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const main = readFileSync("dist/main.js").toString();

  await startAtRcl(server, {
    room: "W0N0",
    level: 2,
    spawn: { x: 25, y: 25 },
    sources: [{ x: 25, y: 35 }],
    controller: { x: 25, y: 15 },
    mainModule: main,
  });

  await server.start();

  const { db } = await server.world.load();
  // Force the downgrade timer low so the anti-downgrade trigger fires. The
  // engine reports ticksToDowngrade as downgradeTime - Game.time.
  const FORCED = 1500;
  let forcedAt = -1;

  const pad = (s: string) => s.padStart(10);
  console.log(["tick", "rcl", "ttd", "rescue", "src-jacks"].map(pad).join(" "));

  for (let t = 1; t <= ticks; t++) {
    await server.tick();

    if (t === 5) {
      await db["rooms.objects"].update(
        { room: "W0N0", type: "controller" },
        { $set: { downgradeTime: t + FORCED } }
      );
      forcedAt = t;
    }

    if (t % 20 === 0 || (forcedAt > 0 && t < forcedAt + 10)) {
      const objs = await server.world.roomObjects("W0N0");
      const ctrl = objs.find((o: any) => o.type === "controller");
      const creeps = objs.filter((o: any) => o.type === "creep");
      const rescue = creeps.filter((c: any) => /^antidowngrade-/.test(c.name)).length;
      const ttd = ctrl?.downgradeTime != null ? ctrl.downgradeTime - t : "-";
      console.log(
        [String(t), `R${ctrl?.level}`, String(ttd), String(rescue), String(creeps.length)]
          .map(pad)
          .join(" ")
      );
    }
  }

  await server.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
