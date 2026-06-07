/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-3node - the "three useless nodes" scenario.
 *
 * One room split by walls into three chambers connected by corridors:
 *   - chamber 1 (west):   the energy SOURCE   (no spawn, no controller)
 *   - chamber 2 (centre): the SPAWN           (no source, no controller)
 *   - chamber 3 (east):   the CONTROLLER      (no source, no spawn)
 *
 * Each chamber on its own is useless; the colony is only viable if energy is
 * hauled source -> spawn (to keep spawning) and source -> controller (to climb
 * RCL) across node boundaries. This probe runs the real bot and reports whether
 * it forms three nodes, seeds the spawn, and climbs RCL.
 */
import { readFileSync, mkdirSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import { threeChamber } from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

/** Read the bot's persisted Memory object via the user handle from addBot. */
async function readPlayerMemory(bot: any): Promise<any> {
  try {
    return JSON.parse((await bot.memory) || "{}");
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const ticks = Number(process.argv[2] ?? 800);
  const port = 25300;
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });

  await server.world.reset();
  const main = readFileSync("dist/main.js").toString();

  const { bot } = await loadScenario(server, threeChamber(), main);

  await server.start();

  let nodesPrinted = false;
  const pad = (s: string) => s.padStart(11);
  const chamber = (x: number) => (x < 16 ? "W" : x < 32 ? "C" : "E");
  console.log(["tick", "rcl", "prog", "spawnE", "creeps", "byChamber"].map(pad).join(" "));

  for (let t = 1; t <= ticks; t++) {
    await server.tick();
    if (t % 40 !== 0 && t !== ticks) continue;

    if (!nodesPrinted) {
      const mem = await readPlayerMemory(bot);
      const nodes: any[] = Object.values(mem?.nodes || {}).filter((n: any) => n.roomName === "W0N0");
      if (nodes.length > 0) {
        console.log(`\n[W0N0 nodes: ${nodes.length}]`);
        for (const n of nodes) {
          const kinds = (n.resources || []).map((r: any) => r.type).join(",") || "(none)";
          console.log(`  ${n.id} peak(${n.peakPosition.x},${n.peakPosition.y}) [${kinds}]`);
        }
        console.log("");
        nodesPrinted = true;
      }
    }

    const objs = await server.world.roomObjects("W0N0");
    const ctrl = objs.find((o: any) => o.type === "controller");
    const spawn = objs.find((o: any) => o.type === "spawn");
    const creeps = objs.filter((o: any) => o.type === "creep");
    const counts: Record<string, number> = { W: 0, C: 0, E: 0 };
    for (const c of creeps) counts[chamber(c.x)]++;

    // Role breakdown via memory.creeps[name].workType.
    const mem = await readPlayerMemory(bot);
    const memCreeps = mem?.creeps || {};
    const roles: Record<string, number> = {};
    for (const c of creeps) {
      const role = memCreeps[c.name]?.workType ?? "?";
      roles[role] = (roles[role] ?? 0) + 1;
    }
    const roleStr = Object.entries(roles).map(([r, n]) => `${r}:${n}`).join(",");

    // Construction sites: count + total remaining work.
    const sites = objs.filter((o: any) => o.type === "constructionSite");
    const siteInfo = sites
      .map((s: any) => `${s.structureType}@(${s.x},${s.y})${s.progress}/${s.progressTotal}`)
      .join(" ");

    console.log(
      [
        String(t),
        `R${ctrl?.level}`,
        String(ctrl?.progress ?? 0),
        String(spawn?.store?.energy ?? 0),
        String(creeps.length),
        `W${counts.W}C${counts.C}E${counts.E}`,
      ].map(pad).join(" ") + `  ${roleStr}` + (siteInfo ? `  sites:[${siteInfo}]` : "")
    );

    // Detailed per-creep dump once the stall sets in.
    if (t >= 1000 && t % 80 === 0) {
      const detail = creeps
        .map((c: any) => {
          const m = memCreeps[c.name] || {};
          return `${m.workType ?? "?"}@(${c.x},${c.y})e${(c.store?.energy) ?? 0}${m.working ? "w" : ""}`;
        })
        .join(" ");
      console.log(`    creeps: ${detail}`);
    }
  }

  await server.stop();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
