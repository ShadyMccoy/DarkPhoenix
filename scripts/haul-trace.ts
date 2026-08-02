/**
 * haul-trace - render one hauler's per-tick flight recorder as a timeline.
 *
 * Owner 2026-08-02: *"store to memory each of the 1500 ticks of a hauler. See
 * what it's doing. Or not doing."*
 *
 * 1500 raw rows are not readable, and reading them one by one is how you miss
 * the thing you are looking for. RUN-LENGTH COMPRESSION is what turns the trace
 * into an answer: consecutive ticks in the same state collapse to one line with
 * a duration, so "stood on 34,21 empty for 44 ticks" becomes a single row that
 * cannot be scrolled past.
 *
 * The summary at the end is the part that answers the owner's question
 * directly: where the life actually went, ranked.
 *
 * Usage:
 *   SCREEPS_TOKEN=... npm run capture:telemetry -- --shard shard1 --segments 7
 *   npm run haul:trace
 *   npm run haul:trace -- --min 5     # only runs of >= 5 ticks
 *
 * @module scripts/haul-trace
 */

import * as fs from "fs";
import * as path from "path";

const FIXTURES = path.join(__dirname, "..", "test", "fixtures", "telemetry");

interface Trace {
  subject: string;
  corpId: string;
  bornAt: number;
  body: { carry: number; move: number };
  rooms: string[];
  targets: string[];
  rows: number[][];
}

const CLASS_NAME = ["ACTIVE", "IDLE-at-source", "IDLE-loaded", "seed"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function latestTrace(): Trace | undefined {
  const files = fs
    .readdirSync(FIXTURES)
    .filter(f => /^shard1-t\d+\.json$/.test(f))
    .sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const cap = JSON.parse(fs.readFileSync(path.join(FIXTURES, files[i]), "utf8"));
    const t = cap?.data?.haulTrace ?? cap?.data?.["7"];
    if (t?.rows?.length) return t as Trace;
  }
  return undefined;
}

function main(): void {
  const t = latestTrace();
  if (!t) {
    console.log("no haul trace in any capture.");
    console.log("  arm it live:  Memory.haulTrace = { corp: \"mining-W43N24-harvest-cd8e\" }");
    console.log("  then capture: npm run capture:telemetry -- --shard shard1 --segments 7");
    return;
  }
  const minRun = Number(arg("min") ?? 1);

  console.log(
    `HAUL TRACE  ${t.subject}  (${t.body.carry}C ${t.body.move}M)  corp ${t.corpId}\n` +
      `  ${t.rows.length} ticks recorded, from t${t.rows[0][0]} to t${t.rows[t.rows.length - 1][0]}\n`
  );

  // ---- run-length compress consecutive identical states ----
  interface Run {
    from: number;
    to: number;
    x: number;
    y: number;
    room: string;
    energy: number;
    leg: number;
    cls: number;
    target: string;
  }
  const runs: Run[] = [];
  for (const r of t.rows) {
    const [tick, x, y, roomIdx, energy, leg, cls, targetIdx] = r;
    const room = t.rooms[roomIdx] ?? "?";
    const target = targetIdx >= 0 ? (t.targets[targetIdx] ?? "").slice(-4) : "-";
    const last = runs[runs.length - 1];
    // A run is "same place, same leg, same verdict". Energy is allowed to move
    // within a run; its END value is what the line reports, so a load in
    // progress reads as one row rather than fifty.
    if (last && last.x === x && last.y === y && last.room === room && last.leg === leg && last.cls === cls) {
      last.to = tick;
      last.energy = energy;
      continue;
    }
    runs.push({ from: tick, to: tick, x, y, room, energy, leg, cls, target });
  }

  console.log(`  ${"ticks".padStart(12)}  ${"dur".padStart(5)}  ${"where".padEnd(18)} ${"load".padStart(5)}  leg      state`);
  for (const r of runs) {
    const dur = r.to - r.from + 1;
    if (dur < minRun) continue;
    console.log(
      `  ${`${r.from}-${r.to}`.padStart(12)}  ${String(dur).padStart(5)}  ` +
        `${`${r.x},${r.y} ${r.room}`.padEnd(18)} ${String(r.energy).padStart(5)}  ` +
        `${(r.leg ? "load" : "deliver").padEnd(7)}  ${CLASS_NAME[r.cls] ?? "?"}` +
        `${r.target !== "-" ? `  ->${r.target}` : ""}`
    );
  }

  // ---- where the life actually went ----
  const byClass = new Map<number, number>();
  const stuck: Run[] = [];
  for (const r of runs) {
    const dur = r.to - r.from + 1;
    byClass.set(r.cls, (byClass.get(r.cls) ?? 0) + dur);
    if (r.cls !== 0 && dur >= 5) stuck.push(r);
  }
  const total = t.rows.length || 1;
  console.log("\n  WHERE THE LIFE WENT");
  for (const [cls, ticks] of [...byClass].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(CLASS_NAME[cls] ?? "?").padEnd(16)} ${String(ticks).padStart(5)}t  ${((ticks / total) * 100).toFixed(0)}%`);
  }
  if (stuck.length) {
    console.log("\n  LONGEST STALLS (>=5t in one place, not active)");
    for (const r of stuck.sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, 10)) {
      console.log(
        `    ${String(r.to - r.from + 1).padStart(4)}t at ${`${r.x},${r.y} ${r.room}`.padEnd(18)} ` +
          `load ${String(r.energy).padStart(4)}  ${r.leg ? "load" : "deliver"} leg  ${CLASS_NAME[r.cls]}`
      );
    }
    console.log(
      "\n    A stall on the LOAD leg with an empty store means the source had nothing\n" +
        "    to give (or it could not reach it); on the DELIVER leg with a full store it\n" +
        "    means the sink would not take it. Those are different bugs."
    );
  }
}

if (require.main === module) main();
