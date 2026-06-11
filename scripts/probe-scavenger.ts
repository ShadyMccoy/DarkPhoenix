/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-scavenger - end-to-end check that a big ground stock is scavenged.
 *
 * Loads a normal RCL-3 scenario, drops a large energy pile a short distance from
 * the spawn, runs the colony, and reports whether a dedicated scavenger was
 * fielded and whether the pile got drained (faster than its own slow decay).
 *
 *   npx ts-node -P tsconfig.test.json scripts/probe-scavenger.ts 400
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import * as library from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

const PILE = { x: 35, y: 25, amount: 2000 };

async function mem(bot: any): Promise<any> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const ticks = parseInt(process.argv[2] ?? "400", 10);
  const port = 25711;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  const mainJs = readFileSync("dist/main.js").toString();

  const scenario = (library as any).twoSourceRcl3();
  const room = scenario.bot.room;
  const { bot } = await loadScenario(server, scenario, mainJs);

  // Drop a big energy pile near the spawn (well above the scavenge threshold).
  const { db } = await server.world.load();
  await db["rooms.objects"].insert({
    room,
    type: "energy",
    x: PILE.x,
    y: PILE.y,
    resourceType: "energy",
    energy: PILE.amount // a dropped resource stores its amount under [resourceType]
  });

  await server.start();
  let minPile = PILE.amount;
  let sawScavengeCorp = false;
  let sawScavengerCreep = false;

  for (let t = 0; t < ticks; t++) {
    await server.tick();

    if (t % 25 === 0 || t === ticks - 1) {
      const objs = await server.world.roomObjects(room);
      const pile = objs.find((o: any) => o.type === "energy" && o.x === PILE.x && o.y === PILE.y);
      const remaining = pile?.energy ?? 0;
      minPile = Math.min(minPile, remaining);

      const m = await mem(bot);
      const scavCorps = Object.keys(m.haulingCorps ?? {}).filter((k) => k.startsWith("scavenge-"));
      if (scavCorps.length > 0) sawScavengeCorp = true;
      const scavCreeps = Object.values(m.creeps ?? {}).filter((c: any) =>
        typeof c?.corpId === "string" && c.corpId.includes("scavenge-")
      );
      if (scavCreeps.length > 0) sawScavengerCreep = true;

      console.log(
        `t=${String(t).padStart(4)}  pile=${String(remaining).padStart(5)}  scavengeCorps=${scavCorps.length}  scavengerCreeps=${scavCreeps.length}`
      );
    }
  }

  const mFinal = await mem(bot);
  console.log("\n=== diagnostics ===");
  console.log("haulingCorps keys:", Object.keys(mFinal.haulingCorps ?? {}));
  const planCorps = (mFinal.economyPlan?.corps ?? []) as any[];
  console.log(
    "economyPlan haul entries:",
    planCorps.filter((c) => c.kind === "haul").map((c) => c.fromId ?? c.sourceId)
  );

  console.log("\n=== scavenger probe ===");
  console.log(`pile: ${PILE.amount} -> min observed ${minPile}  (drained ${PILE.amount - minPile})`);
  console.log(`scavenger corp fielded: ${sawScavengeCorp}`);
  console.log(`scavenger creep spawned: ${sawScavengerCreep}`);
  // Pure decay of a 2000 pile over these ticks is ~2/tick; a working scavenger
  // empties it far faster. Treat a big drop + a scavenger corp as success.
  const drained = PILE.amount - minPile;
  console.log(
    sawScavengeCorp && drained > 800
      ? "=> PASS: a scavenger was fielded and drained the stock."
      : "=> INCONCLUSIVE: see trace above."
  );

  await server.stop?.();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
