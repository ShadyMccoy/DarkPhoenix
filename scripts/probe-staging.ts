/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-staging - can the grid's raw-db stage() hook inject dropped energy and
 * construction sites? (docs/specs/08 errata #4: ScenarioState supports only
 * controller/structures/creeps/memory, so ~5 designed cells depend on raw
 * {type:'energy'} / {type:'constructionSite'} db inserts whose engine
 * acceptance was never verified. This probe answers it once.)
 *
 * Verdict criteria, per doc type, observed over 10 ticks with an idle bot:
 *   energy pile        - survives (not purged tick 1), decays ~ceil(amount/1000)
 *                        per tick per the game rule.
 *   construction site  - survives, keeps structureType/progress, and appears
 *                        in the room's objects for the owning user.
 *
 * Usage: npx ts-node -P tsconfig.test.json scripts/probe-staging.ts
 */

import { mkdirSync, readFileSync } from "fs";
import * as fs from "fs";
import * as path from "path";
import { RoomBuilder } from "../test/integration/scenario/RoomBuilder";
import { loadLayout, padNeighborTerrain } from "../test/integration/loadLayout";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const PORT = 26900;
const ROOM = "W0N0";

async function main(): Promise<void> {
  const serverPath = path.resolve("server", `grid-probe-${PORT}`);
  (fs as any).rmSync(serverPath, { recursive: true, force: true });
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port: PORT, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const room = new RoomBuilder(ROOM).border().controller(25, 10).source(30, 25).toRoom();
  await loadLayout(server.world, room);
  await padNeighborTerrain(server.world, [ROOM]);
  const bot = await server.world.addBot({
    username: "prober",
    room: ROOM,
    x: 25,
    y: 25,
    // An idle bot: we only care whether the ENGINE keeps the injected docs.
    modules: { main: "module.exports.loop = function() {};" },
  });

  const { db } = await server.world.load();
  await db["rooms.objects"].insert({
    type: "energy",
    room: ROOM,
    x: 20,
    y: 20,
    energy: 500,
    resourceType: "energy",
  });
  await db["rooms.objects"].insert({
    type: "constructionSite",
    room: ROOM,
    x: 22,
    y: 22,
    user: bot.id,
    structureType: "extension",
    progress: 0,
    progressTotal: 3000,
  });

  await server.start();

  const observe = async (tick: number) => {
    const objs = await server.world.roomObjects(ROOM);
    const pile = objs.find((o: any) => o.type === "energy");
    const site = objs.find((o: any) => o.type === "constructionSite");
    console.log(
      `tick ${tick}: pile=${pile ? `energy ${pile.energy} @(${pile.x},${pile.y})` : "GONE"} ` +
        `site=${site ? `${site.structureType} ${site.progress}/${site.progressTotal} user=${site.user === bot.id ? "bot" : site.user}` : "GONE"}`
    );
    return { pile, site };
  };

  let last: any = {};
  for (let t = 1; t <= 10; t++) {
    await server.tick();
    last = await observe(t);
  }

  const pileOk = !!last.pile && last.pile.energy < 500; // survived AND decaying
  const siteOk = !!last.site && last.site.structureType === "extension";
  console.log(`\nVERDICT: energy-pile injection ${pileOk ? "WORKS (decaying normally)" : "FAILS"}`);
  console.log(`VERDICT: construction-site injection ${siteOk ? "WORKS" : "FAILS"}`);

  await server.stop?.();
  process.exit(pileOk && siteOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
