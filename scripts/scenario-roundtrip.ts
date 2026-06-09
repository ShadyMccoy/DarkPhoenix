/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * scenario-roundtrip - validate the scenario toolset end to end.
 *
 * Loads a built scenario, runs it a while, exports a snapshot to a saved JSON
 * state, then reloads that snapshot into a fresh server and checks the captured
 * state (controller, structures, memory) replays faithfully. Exits non-zero on
 * any mismatch so it can gate CI / manual checks.
 */
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import { loadScenario } from "../test/integration/scenario/Scenario";
import { exportSnapshot } from "../test/integration/scenario/Snapshot";
import { threeChamber } from "../test/integration/scenario/library";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer } = require("screeps-server-mockup");

async function freshServer(port: number): Promise<any> {
  const serverPath = path.resolve("server", String(port));
  mkdirSync(path.join(serverPath, "logs"), { recursive: true });
  const server = new ScreepsServer({ port, path: serverPath, logdir: path.join(serverPath, "logs") });
  await server.world.reset();
  return server;
}

async function controllerOf(server: any, room: string): Promise<any> {
  const objs = await server.world.roomObjects(room);
  return objs.find((o: any) => o.type === "controller");
}

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const ticks = Number(process.argv[2] ?? 250);
  const main = readFileSync("dist/main.js").toString();

  // --- run the original scenario ------------------------------------------
  const s1 = await freshServer(25400);
  const { bot } = await loadScenario(s1, threeChamber(), main);
  await s1.start();
  for (let t = 0; t < ticks; t++) await s1.tick();

  // Give the controller a recognisable level/progress to verify round-trip.
  const { db } = await s1.world.load();
  await db["rooms.objects"].update(
    { room: "W0N0", type: "controller" },
    { $set: { level: 2, progress: 1234, downgradeTime: null, safeMode: null } }
  );
  await db["rooms.objects"].insert({
    room: "W0N0", type: "extension", x: 23, y: 25, user: bot.id,
    store: { energy: 30 }, storeCapacityResource: { energy: 50 },
  });

  const snap = await exportSnapshot(s1, bot, { name: "three-chamber-snap", username: "player" });
  await s1.stop();

  // Persist to a saved-state file (the "export to saved state" capability).
  const outDir = path.resolve("test/fixtures/snapshots");
  mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, "three-chamber-snap.json");
  writeFileSync(file, JSON.stringify(snap, null, 2));
  console.log(`snapshot written: ${path.relative(process.cwd(), file)}`);

  // --- reload the snapshot into a fresh server ----------------------------
  const saved = JSON.parse(readFileSync(file).toString());
  const s2 = await freshServer(25401);
  const reload = await loadScenario(s2, saved, main);
  await s2.start();
  await s2.tick(); // settle one tick

  const ctrl = await controllerOf(s2, "W0N0");
  const objs2 = await s2.world.roomObjects("W0N0");
  const ext = objs2.find((o: any) => o.type === "extension");
  const mem = JSON.parse((await reload.bot.memory) || "{}");

  check("controller level restored", ctrl?.level === 2, `level=${ctrl?.level}`);
  check("controller progress restored", ctrl?.progress === 1234, `progress=${ctrl?.progress}`);
  check("extension restored", !!ext, ext ? `(${ext.x},${ext.y}) e${ext.store?.energy}` : "missing");
  check("source preserved", objs2.some((o: any) => o.type === "source"), "");
  check("memory restored (nodes present)", !!mem.nodes && Object.keys(mem.nodes).length > 0,
    `nodes=${mem.nodes ? Object.keys(mem.nodes).length : 0}`);

  await s2.stop();

  console.log(failures === 0 ? "\nROUND-TRIP OK" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
