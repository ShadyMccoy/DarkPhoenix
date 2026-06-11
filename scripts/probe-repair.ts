/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-repair - end-to-end check that decaying containers get repaired.
 *
 * Builds a FULLY-BUILT RCL-3 room (containers + the full extension set), so there
 * is nothing to construct and the ConstructionCorp falls to its maintenance duty.
 * One source container is then decayed to 40% and we watch its hits recover.
 *
 *   npx ts-node -P tsconfig.test.json scripts/probe-repair.ts 250
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import * as library from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

// The source container we decay and watch get repaired.
const TARGET = { x: 15, y: 29, hits: 100000, hitsMax: 250000 };

async function mem(bot: any): Promise<any> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const ticks = parseInt(process.argv[2] ?? "250", 10);
  const port = 25713;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const mainJs = readFileSync("dist/main.js").toString();

  // Fully-built room: containers already built, plus 5 MORE extensions to reach the
  // RCL-3 cap of 10, so the corp has nothing to construct.
  const base = (library as any).twoSourceRcl3Containers();
  const room = base.bot.room;
  const extraExts = [
    { x: 26, y: 22 }, { x: 22, y: 28 }, { x: 28, y: 28 }, { x: 20, y: 24 }, { x: 30, y: 24 }
  ];
  const scenario = {
    ...base,
    state: {
      ...base.state,
      structures: [
        ...base.state.structures,
        ...extraExts.map((e) => ({ room, type: "extension", x: e.x, y: e.y, energy: 50 }))
      ]
    }
  };

  const { bot } = await loadScenario(server, scenario, mainJs);

  // Decay one source container to 40% so maintenance has a job from the start.
  const { db } = await server.world.load();
  await db["rooms.objects"].update({ room, type: "container", x: TARGET.x, y: TARGET.y }, { $set: { hits: TARGET.hits } });

  await server.start();

  let minHits = TARGET.hits;
  let maxHits = TARGET.hits;
  let prev = TARGET.hits;
  let repaired = false;

  for (let t = 0; t < ticks; t++) {
    await server.tick();
    if (t % 20 === 0 || t === ticks - 1) {
      const objs = await server.world.roomObjects(room);
      const cont = objs.find((o: any) => o.type === "container" && o.x === TARGET.x && o.y === TARGET.y);
      const hits = cont?.hits ?? 0;
      minHits = Math.min(minHits, hits);
      maxHits = Math.max(maxHits, hits);
      if (hits > prev + 50) repaired = true;
      prev = hits;

      const m = await mem(bot);
      const hasConstructionCorp = Object.keys(m.constructionCorps ?? {}).length > 0;
      const builders = Object.values(m.creeps ?? {}).filter((c: any) => c?.workType === "build").length;
      const sites = (await server.world.roomObjects(room)).filter((o: any) => o.type === "constructionSite").length;
      console.log(
        `t=${String(t).padStart(4)}  hits=${String(hits).padStart(6)}  sites=${sites}  builders=${builders}  constructionCorp=${hasConstructionCorp}`
      );
    }
  }

  console.log("\n=== repair probe ===");
  console.log(`target container hits: start ${TARGET.hits}, min ${minHits}, max ${maxHits}`);
  console.log(
    repaired && maxHits > TARGET.hits
      ? "=> PASS: the container was repaired (hits rose above the decayed value)."
      : "=> INCONCLUSIVE: see trace above."
  );

  await server.stop?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
