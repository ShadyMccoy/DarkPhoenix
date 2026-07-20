/**
 * audit-report - the standardized cycle scoreboard (owner 2026-07-20: "a
 * concise standardized report with figures and variances ... a quick
 * shorthand summary. It will evolve over time.").
 *
 * Reads the trailing telemetry captures (test/fixtures/telemetry) and prints
 * one fixed-format block: every figure with its latest value, the per-window
 * rate where a rate is meaningful, and a TRAILING-WINDOW BAND [min..max] over
 * the last N windows - the multi-draw doctrine applied to live windows: one
 * window's rate is noise, the band is the signal. Score rates (GCL/RCL) are
 * the ground truth for energy burned at controllers (1 energy = 1 progress),
 * so BURN here needs no model - it IS the score.
 *
 * Shorthand legend:
 *   value (xT)  = value as a multiple of its target
 *   +r/t        = per-tick rate over the latest window
 *   [a..b]      = min..max of the per-window rates across trailing windows
 *   [plan]      = a planner figure (the current solve), not a measured actual
 */

import * as fs from "fs";
import * as path from "path";

const FIXTURES = path.join(__dirname, "..", "test", "fixtures", "telemetry");
const TRAILING_WINDOWS = 5;

interface Capture {
  tick: number;
  data: {
    core?: any;
    flow?: any;
    corps?: any;
  };
}

function loadCaptures(): Capture[] {
  const files = fs
    .readdirSync(FIXTURES)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      const d = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8"));
      return { tick: d.tick, data: d.data ?? {} } as Capture;
    })
    .filter(c => typeof c.tick === "number" && c.data.core)
    .sort((a, b) => a.tick - b.tick);
  return files;
}

/** Per-window rate series for a numeric field; negative deltas (level-up /
 * completion resets) are skipped as undefined windows. */
function rates(caps: Capture[], read: (c: Capture) => number | undefined): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 1; i < caps.length; i++) {
    const a = read(caps[i - 1]);
    const b = read(caps[i]);
    const dt = caps[i].tick - caps[i - 1].tick;
    if (a === undefined || b === undefined || dt <= 0) {
      out.push(null);
      continue;
    }
    out.push((b - a) / dt);
  }
  return out;
}

const fmt = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined || Number.isNaN(n) ? "-" : n.toFixed(digits);

/** "latest [min..max]" band over the trailing windows of a rate series. */
function band(series: (number | null)[], digits = 1): { latest: string; band: string } {
  const tail = series.slice(-TRAILING_WINDOWS).filter((v): v is number => v !== null);
  const latest = series.length > 0 ? series[series.length - 1] : null;
  if (tail.length === 0) return { latest: fmt(latest, digits), band: "[-]" };
  const lo = Math.min(...tail);
  const hi = Math.max(...tail);
  return { latest: fmt(latest, digits), band: `[${fmt(lo, digits)}..${fmt(hi, digits)}]` };
}

function main(): void {
  const caps = loadCaptures();
  if (caps.length < 2) {
    console.log("audit-report: need at least 2 captures");
    return;
  }
  const cur = caps[caps.length - 1];
  const prev = caps[caps.length - 2];
  const dt = cur.tick - prev.tick;
  const core = cur.data.core;
  const flow = cur.data.flow ?? {};

  // SCORE - gcl progress is energy burned at controllers, ground truth.
  const gclRate = band(rates(caps, c => c.data.core?.gcl?.progress));
  const gclPct = (core.gcl.progress / core.gcl.progressTotal) * 100;

  // Rooms: rcl progress rate per owned room (level-up resets skipped).
  const roomLines: string[] = [];
  for (const room of core.rooms ?? []) {
    const r = band(rates(caps, c => (c.data.core?.rooms ?? []).find((x: any) => x.name === room.name)?.rclProgress));
    const pct = room.rclProgressTotal > 0 ? (room.rclProgress / room.rclProgressTotal) * 100 : 0;
    roomLines.push(
      `       ${room.name} rcl${room.rcl} @ ${fmt(pct, 1)}%  +${r.latest}/t ${r.band}`
    );
  }

  // INCOME [plan]: funded vs routed mined e/t from the current solve.
  const cands = (flow.candidates ?? []).filter((c: any) => !String(c.sourceId).includes("intel"));
  const funded = cands.filter((c: any) => c.verdict === "funded");
  const fundedRate = funded.reduce((s: number, c: any) => s + (c.rate ?? 0), 0);
  const unrouted = cands.filter((c: any) => c.verdict === "unrouted").length;
  const overBudget = cands.filter((c: any) => c.verdict === "over-budget").length;
  const routed = (flow.haulers ?? [])
    .filter((h: any) => !String(h.sourceId).startsWith("bank-") && !String(h.sourceId).startsWith("scavenge-"))
    .reduce((s: number, h: any) => s + (h.flowRate ?? 0), 0);
  const routedX = fundedRate > 0 ? routed / fundedRate : 1;

  // BANK vs warchest target (kept in sync with economy/bank.ts manually -
  // the report reads captures only, no src imports, so it stays runnable
  // against any checkout).
  const WARCHEST_TARGET = 27_650;
  const bankNow = core.rooms?.[0]?.storageEnergy ?? null;
  const bankRate = band(rates(caps, c => c.data.core?.rooms?.[0]?.storageEnergy ?? undefined));

  // SPAWN
  const sp = core.spawns?.[0] ?? {};

  // FLEET
  const k = core.creeps?.byKind ?? {};
  const kindStr = ["harvest", "carry", "upgrade", "construction", "tender"]
    .map(name => `${k[name] ?? 0} ${name.slice(0, 4)}`)
    .join(" ");

  console.log(`DARKPHOENIX SCOREBOARD  t${cur.tick}  window ${dt}t  trailing ${Math.min(TRAILING_WINDOWS, caps.length - 1)} windows`);
  console.log(`SCORE  gcl ${core.gcl.level} @ ${fmt(gclPct, 1)}%   +${gclRate.latest}/t ${gclRate.band}`);
  for (const line of roomLines) console.log(line);
  console.log(
    `INCOME funded ${fmt(fundedRate, 0)} e/t  routed ${fmt(routed, 1)} (${fmt(routedX, 2)}x)` +
      `  unrouted ${unrouted}  over-budget ${overBudget}  [plan]`
  );
  console.log(
    `BANK   ${bankNow === null ? "-" : (bankNow / 1000).toFixed(1) + "k"} (${bankNow === null ? "-" : fmt(bankNow / WARCHEST_TARGET, 1)}xT)  ${bankRate.latest}/t ${bankRate.band}`
  );
  // FLEET-MASS CROSS-CHECK (owner 2026-07-20): at this utilization the
  // spawn sustains util*ceiling*1500 standing parts if every part lived a
  // full life. actual/expected below ~0.8 = the lifetime taxes (travel,
  // short-lived CLAIM bodies, recycled runts, premature deaths) are eating
  // spawn output - a churn flag, not just a number.
  const expectedParts = (sp.utilization ?? 0) * (sp.ceiling ?? 0) * 1500;
  const massRatio = expectedParts > 0 ? (core.bodyParts?.total ?? 0) / expectedParts : null;
  console.log(
    `SPAWN  util ${fmt(sp.utilization, 2)}  parts ${fmt(sp.partsPerTick, 3)}/${fmt(sp.ceiling, 3)}  queue ${sp.queueDepth ?? "-"}` +
      `  sustains ~${fmt(expectedParts, 0)}p  mass ${fmt(massRatio, 2)}`
  );
  // SRCBUF: per-source mouth stocks (container+pile). Pinned near 2000 =
  // under-hauled (rot); ~0 everywhere = hauling has headroom.
  const buf = core.sourceBuffers as { [id: string]: number } | undefined;
  if (buf) {
    const entries = Object.entries(buf).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    const hot = entries.filter(([, v]) => v >= 1500).length;
    console.log(
      `SRCBUF ${entries.length} sources, ${(total / 1000).toFixed(1)}k standing, ${hot} near-full  ` +
        entries.slice(0, 6).map(([id, v]) => `${id}:${v >= 1000 ? (v / 1000).toFixed(1) + "k" : v}`).join(" ")
    );
  } else {
    console.log("SRCBUF (not in this capture - deploy pending)");
  }
  console.log(
    `FLEET  ${core.creeps?.total ?? "-"} creeps (${kindStr})  untracked ${core.creeps?.untracked ?? "-"}`
  );
  // PARTS: the colony's standing body inventory - the thing the spawn's
  // 0.333/t actually buys - with composition and the fleet-growth band.
  const bp = core.bodyParts?.byPart ?? {};
  const partOrder = ["work", "carry", "move", "attack", "heal", "claim", "tough", "ranged_attack"];
  const partStr = partOrder
    .filter(p => (bp[p] ?? 0) > 0)
    .map(p => `${bp[p]} ${p === "ranged_attack" ? "ra" : p.slice(0, 4)}`)
    .join(" ");
  const partsRate = band(rates(caps, c => c.data.core?.bodyParts?.total), 2);
  console.log(
    `PARTS  ${core.bodyParts?.total ?? "-"} (${partStr})  ${partsRate.latest}/t ${partsRate.band}`
  );
  console.log(`CPU    ${fmt(core.cpu?.used, 1)}/${core.cpu?.limit ?? "-"}  bucket ${((core.cpu?.bucket ?? 0) / 1000).toFixed(1)}k`);
}

main();
