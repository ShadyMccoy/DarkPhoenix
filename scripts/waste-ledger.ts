/**
 * @fileoverview Waste ledger (spec 15 phase 1) - every leak as a number.
 *
 * Reads two telemetry captures (fixtures) and prints the ledger: each row
 * computed from data, ranked FAIL > WARN > ok. The audit loop runs this FIRST
 * each cycle; any FAIL outranks the symptomatic triage checklist.
 *
 * Decision symmetry (spec 14): every economic constant here is IMPORTED from
 * the module the bot runs - the ledger can only drift from the bot if the bot
 * drifts from itself. Fleet body ratios are MEASURED from the capture's actual
 * bodies where a fleet exists (fallback ratios only when a fleet is empty).
 *
 * Usage: npm run audit:ledger [-- --capture <path|latest> --baseline <path|prev>]
 *
 * @module scripts/waste-ledger
 */

import * as fs from "fs";
import * as path from "path";
import {
  MINER_PARTS,
  SPAWN_PARTS_PER_TICK,
  carryPartsFor,
  effectiveLife
} from "../src/economy/primitives";
import { WARCHEST_TARGET, feederRelayRate } from "../src/economy/bank";
import { CLAIM_LIFETIME, RESERVER_DUTY } from "../src/corps/economics";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LedgerRow {
  id: string;
  name: string;
  value: number;
  unit: string;
  verdict: "FAIL" | "WARN" | "ok";
  detail: string;
}

const FIXTURE_DIR = path.join(__dirname, "..", "test", "fixtures", "telemetry");

function listFixtures(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter(f => /^shard1-t\d+\.json$/.test(f))
    .sort((a, b) => Number(b.match(/t(\d+)/)![1]) - Number(a.match(/t(\d+)/)![1]))
    .map(f => path.join(FIXTURE_DIR, f));
}

function loadCapture(spec: string, fallbackIndex: number): any {
  if (spec !== "latest" && spec !== "prev") return JSON.parse(fs.readFileSync(spec, "utf8"));
  const files = listFixtures();
  const file = files[spec === "latest" ? 0 : fallbackIndex];
  if (!file) throw new Error(`no fixture for --${spec === "latest" ? "capture" : "baseline"} in ${FIXTURE_DIR}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Measured parts-per-WORK from an actual upgrader body; 4/3 fallback (15W1C4M). */
function upgraderPartsPerWork(corps: any[]): number {
  for (const c of corps) {
    if (c.kind === "upgrade" && c.bodyParts > 0 && (c.body.work ?? 0) > 0) return c.bodyParts / c.body.work;
  }
  return 4 / 3;
}

function fleetParts(corps: any[], kind: string, fallback: number): number {
  for (const c of corps) if (c.kind === kind && c.creepCount > 0) return c.bodyParts / c.creepCount;
  return fallback;
}

/**
 * P4: the WHOLE plan's amortized spawn maintenance (parts/tick) vs the
 * physical ceiling - including every line the planner's own mining budget
 * never prices (transient-route haulers, consumers, infra). The plan is
 * infeasible when this exceeds spawnCount * SPAWN_PARTS_PER_TICK: actuals
 * then converge to the ceiling, never to the plan (measured 2026-07-18:
 * 0.561 p/t vs 0.333, 168%, while progress ran at ~3 of a 115 e/t plan).
 */
export function planSpawnLoad(cap: any): { total: number; lines: Array<[string, number, number]> } {
  const flow = cap.data.flow;
  const corps: any[] = cap.data.corps?.corps ?? [];
  const rooms = cap.data.core?.rooms ?? [];
  const banked = rooms[0]?.storageEnergy ?? 0;
  const lines: Array<[string, number, number]> = []; // [name, parts, partsPerTick]

  let p = 0,
    l = 0;
  for (const s of flow.sources ?? []) {
    p += MINER_PARTS;
    l += MINER_PARTS / effectiveLife(s.spawnDistance);
  }
  lines.push(["miners", p, l]);

  let sp = 0,
    sl = 0,
    tp = 0,
    tl = 0;
  for (const h of flow.haulers ?? []) {
    // ECHO the planner's OWN per-route spawn-parts (CorpPlanner sets
    // `spawnParts = ((paved?1.5:2)*carryPartsFor(take,dEff))/effectiveLife(d)`)
    // rather than re-deriving it here (owner 2026-07-22: "eliminate the ledger
    // vs planner drift at the root by having them share the same code"). The
    // old recompute `2*carryParts` hardcoded the UNPAVED body for every route,
    // so a paved-remote colony over-counted its hauler load and P4 read
    // infeasible (t72508069: 1.01x FAIL where the planner's paved-aware number
    // is 0.90x). The parts figure (display) backs out of the load over the
    // same effectiveLife so the "Np" reads consistently. Legacy captures with
    // no spawnParts fall back to the conservative 2x recompute (no crash).
    const life = effectiveLife(h.distance);
    const load = h.spawnParts ?? (2 * h.carryParts) / life;
    const parts = h.spawnParts !== undefined ? h.spawnParts * life : 2 * h.carryParts;
    const transient = h.sourceId.startsWith("scavenge") || h.sourceId.startsWith("bank");
    if (transient) {
      tp += parts;
      tl += load;
    } else {
      sp += parts;
      sl += load;
    }
  }
  lines.push(["source-route haulers", sp, sl]);
  lines.push(["transient-route haulers (unbudgeted)", tp, tl]);

  const ctrl = (flow.sinks ?? []).find((s: any) => s.type === "controller");
  if (ctrl?.workParts) {
    const parts = ctrl.workParts * upgraderPartsPerWork(corps);
    lines.push(["upgraders (plan WORK)", parts, parts / effectiveLife(10)]);
  }
  const relay = feederRelayRate(banked);
  // LINK-FED feeder charges at distance 1, not the nominal 6 (owner
  // 2026-07-22 "the feeder seems way too large": this line overcharged 64p
  // vs the true ~18-22p link-fed body all week, inflating P4 ~0.03
  // parts/t). Read the corp's own stamp - decision symmetry, not a guess.
  // NOTE: deliberately the PLAN-side trip model, NOT the corp's realized
  // neededCarry stamp - P4's budget-dry identity is constructed from the
  // plan's own formulas, and injecting actual bodies breaks it at every
  // equilibrium (the t72420007 boundary pin). The parked-post body shrink
  // (2026-07-22) shows up on the ACTUAL side of plan-vs-actual instead.
  const feederLinkFed = corps.find(c => (c.id ?? "").includes("controllerFeeder"))?.sizing?.linkFed === true;
  const feederDist = feederLinkFed ? 1 : 6;
  const feederParts = 2 * carryPartsFor(relay, feederDist);
  lines.push([
    `feeder @ relay ${Math.round(relay)}${feederLinkFed ? " (link-fed d1)" : ""}`,
    feederParts,
    feederParts / effectiveLife(feederDist)
  ]);

  const tenderTarget = corps.find(c => c.kind === "tender")?.sizing?.target ?? 3;
  const tenderBody = fleetParts(corps, "tender", 24);
  lines.push(["tenders", tenderTarget * tenderBody, (tenderTarget * tenderBody) / 1500]);

  const resTargets = corps.find(c => c.kind === "reservation")?.sizing?.targets ?? 0;
  const resBody = fleetParts(corps, "reservation", 4);
  const resLoad = (resTargets * resBody) / Math.max(1, CLAIM_LIFETIME - 60);
  lines.push(["reservers (claim life)", resTargets * resBody, resLoad]);

  const total = lines.reduce((s, [, , x]) => s + x, 0);
  return { total, lines };
}

export function computeLedger(cap: any, base: any): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const core = cap.data.core;
  const bcore = base.data.core;
  const dt = cap.tick - base.tick;
  const flow = cap.data.flow;
  const corps: any[] = cap.data.corps?.corps ?? [];

  // ---- P4 plan spawn-feasibility (the audit gap of 2026-07-18) ----
  const { total, lines } = planSpawnLoad(cap);
  const ceiling = (core.spawns?.length ?? 1) * SPAWN_PARTS_PER_TICK;
  const ratio = total / ceiling;
  rows.push({
    id: "P4",
    name: "plan spawn-infeasibility",
    value: ratio,
    unit: "x ceiling",
    // The fill runs budget-dry BY DESIGN, so an equilibrium plan sits AT the
    // ceiling; this script recomputes each class independently and drifts
    // ~0.1% from the planner's own ledger. 0.5% tolerance: smaller than any
    // real fleet class (min ~3% of ceiling), bigger than arithmetic noise.
    verdict: ratio > 1.005 ? "FAIL" : ratio > 0.85 ? "WARN" : "ok",
    detail:
      `plan-implied ${total.toFixed(3)} parts/t vs ${ceiling.toFixed(3)} physical; ` +
      lines
        .filter(([, , x]) => x > 0.005)
        .map(([n, p, x]) => `${n} ${Math.round(p)}p=${x.toFixed(3)}`)
        .join(", ")
  });

  // ---- P5 price/behavior drift: reserver duty ----
  const res = corps.find(c => c.kind === "reservation");
  const dutyImplemented = res?.sizing && (res.sizing.banks !== undefined || res.sizing.gate === "reservation-banked");
  if (dutyImplemented) {
    const banks = res.sizing.banks ?? {};
    rows.push({
      id: "P5",
      name: "reserver duty vs priced",
      value: RESERVER_DUTY,
      unit: "duty (gate reads reservation bank)",
      verdict: "ok",
      detail:
        `gate ${res.sizing.gate}; banks ` +
        (Object.entries(banks as Record<string, number>)
          .map(([r, t]) => `${r}:${t}`)
          .join(" ") || "(none stamped)")
    });
  } else if (res?.sizing) {
    const bres = (base.data.corps?.corps ?? []).find((c: any) => c.kind === "reservation");
    const duty =
      (res.sizing.staffed / Math.max(1, res.sizing.targets) +
        (bres?.sizing ? bres.sizing.staffed / Math.max(1, bres.sizing.targets) : 0)) /
      (bres?.sizing ? 2 : 1);
    rows.push({
      id: "P5",
      name: "reserver duty vs priced",
      value: 1.0,
      unit: "gate duty (priced " + RESERVER_DUTY + ")",
      verdict: "FAIL",
      detail:
        `corp gate re-staffs whenever staffed < targets (duty 1.0 by construction; ` +
        `reservation bank to 5000 never read) while reserverTollPerRoom prices ${RESERVER_DUTY}; ` +
        `staffing proxy across captures ${duty.toFixed(2)} (raid-distorted); ` +
        `2x spawn+energy vs priced until the corp reads reservation.ticksToEnd`
    });
  }

  // ---- E4 idle capital ----
  const room = core.rooms?.[0];
  if (room) {
    const broom = (bcore.rooms ?? []).find((r: any) => r.name === room.name);
    const slope = broom ? (room.storageEnergy - broom.storageEnergy) / dt : 0;
    const excess = room.storageEnergy - WARCHEST_TARGET;
    rows.push({
      id: "E4",
      name: "idle capital",
      value: excess,
      unit: "energy above warchest",
      verdict: excess > WARCHEST_TARGET && slope >= 0 ? "FAIL" : excess > WARCHEST_TARGET ? "WARN" : "ok",
      detail: `storage ${room.storageEnergy} vs target ${WARCHEST_TARGET}, slope ${slope.toFixed(2)}/t over ${dt}t, feederActive ${room.feederActive}`
    });
  }

  // ---- P1/S2 plan flap: candidate verdict flips between captures ----
  const verdicts = new Map<string, string>((flow.candidates ?? []).map((c: any) => [c.sourceId, c.verdict]));
  const bverdicts = new Map<string, string>(
    (base.data.flow?.candidates ?? []).map((c: any) => [c.sourceId, c.verdict])
  );
  const flips: string[] = [];
  for (const [id, v] of verdicts) {
    const bv = bverdicts.get(id);
    if (bv && bv !== v && (v === "funded" || bv === "funded")) flips.push(`${id.slice(-8)} ${bv}->${v}`);
  }
  // A funded source VANISHING from the candidate list is the biggest flip of
  // all (raid embargo pulls remotes from the problem entirely - measured
  // t72415443: five funded remotes dropped, P1 read "0 flips").
  for (const [id, bv] of bverdicts) {
    if (bv === "funded" && !verdicts.has(id)) flips.push(`${id.slice(-8)} funded->DROPPED`);
  }
  rows.push({
    id: "P1",
    name: "plan flap (funded flips)",
    value: flips.length,
    unit: "sources",
    verdict: flips.length > 1 ? "FAIL" : flips.length === 1 ? "WARN" : "ok",
    detail: flips.join(", ") || "stable vs baseline"
  });

  // ---- P2 micro-routes ----
  const micro = (flow.haulers ?? []).filter((h: any) => h.carryParts < 3);
  rows.push({
    id: "P2",
    name: "micro-routes (<3 CARRY planned)",
    value: micro.length,
    unit: `of ${(flow.haulers ?? []).length} routes`,
    verdict: micro.length > (flow.haulers ?? []).length / 2 ? "WARN" : "ok",
    detail: micro.map((h: any) => `${h.sourceId.slice(-8)} ${h.carryParts.toFixed(1)}c`).join(", ") || "none"
  });

  // ---- E2 stranded fleet: actual carry corps serving routes absent from plan ----
  const planSuffixes = new Set(
    (flow.haulers ?? []).map((h: any) => h.sourceId.replace(/^source-|^scavenge-|^bank-/, "").slice(-4))
  );
  let strandedParts = 0;
  const strandedIds: string[] = [];
  for (const c of corps) {
    if (c.kind !== "carry" || c.creepCount === 0) continue;
    const suffix = c.id.slice(-4);
    if (!planSuffixes.has(suffix)) {
      strandedParts += c.bodyParts;
      strandedIds.push(c.id.replace(/^hauling-/, ""));
    }
  }
  rows.push({
    id: "E2",
    name: "stranded fleet",
    value: strandedParts,
    unit: "body parts off-plan",
    verdict: strandedParts > 60 ? "FAIL" : strandedParts > 20 ? "WARN" : "ok",
    detail: strandedIds.join(", ") || "every fielded hauler serves a planned route"
  });

  // ---- E5 runt purchases ----
  const agenda: any = Object.values(core.agenda ?? {})[0] ?? {};
  const runts = (agenda.executed ?? []).filter((e: any) => e.cost < 300 && !["reserver", "scout"].includes(e.role));
  rows.push({
    id: "E5",
    name: "runt purchases",
    value: runts.length,
    unit: "of last " + (agenda.executed ?? []).length + " receipts",
    verdict: runts.length > 1 ? "WARN" : "ok",
    detail: runts.map((e: any) => `${e.role}@${e.cost}`).join(", ") || "none"
  });

  // ---- S3 scheduler stall: idle spawn with an AFFORDABLE head ----
  const spawn = core.spawns?.[0];
  if (spawn && room) {
    const head = (agenda.queue ?? [])[0];
    const affordable = head && room.energyAvailable >= head.minCost;
    // Staleness guard: the director republishes the agenda only on idle-spawn
    // evaluation ticks, so a snapshot older than ~20 ticks means the spawn has
    // been BUSY building since - the opposite of stalled (measured t72412472:
    // 37-tick-stale agenda while a 1127-cost tanker built, false S3 FAIL).
    const agendaFresh = agenda.tick !== undefined && cap.tick - agenda.tick <= 20;
    const stalled = agendaFresh && spawn.utilization < 0.5 && (agenda.queue ?? []).length > 0 && affordable;
    rows.push({
      id: "S3",
      name: "scheduler stall",
      value: stalled ? 1 : 0,
      unit: "boolean",
      verdict: stalled ? "FAIL" : "ok",
      detail: head
        ? `util ${spawn.utilization.toFixed(2)}, head ${head.role}@${head.minCost} vs bank ${room.energyAvailable}` +
          (!agendaFresh
            ? ` (agenda ${cap.tick - agenda.tick}t stale = spawn busy building - not a stall)`
            : affordable
            ? " AFFORDABLE+IDLE"
            : " (holding/funding - not a stall)")
        : "queue empty"
    });
  }

  // ---- P6 reservation pump (owner marathon: "reservers not reserving") ----
  // pump_r = bank2 - (bank1 - stampDt): what the fielded reservers actually
  // ADDED per room, decay netted out. Zero pump on a needy room with claim
  // parts fielded = a reserver walking / blocked / dead - the delivery gap
  // no other line sees. Stamp ticks, not capture ticks: banks are read at
  // sizing time.
  {
    const res = (cap.data.corps?.corps ?? []).find((c: any) => c.kind === "reservation");
    const bres = (base.data.corps?.corps ?? []).find((c: any) => c.kind === "reservation");
    const banks1 = bres?.sizing?.banks;
    const banks2 = res?.sizing?.banks;
    const stampDt = res?.sizing?.tick && bres?.sizing?.tick ? res.sizing.tick - bres.sizing.tick : dt;
    if (banks1 && banks2 && stampDt > 0) {
      const rooms = Object.keys(banks2).filter(r => r in banks1);
      // Expected decay is bounded by the starting bank (a bank at 0 cannot
      // decay): pump = bank2 - (bank1 - min(bank1, dt)). The unbounded form
      // fabricated "+dt banked per room" from four zero banks with no
      // reservers fielded (live t72481477 vs t72481270).
      const pumps = rooms.map(
        r => [r, Math.round(banks2[r] - (banks1[r] - Math.min(banks1[r], stampDt)))] as [string, number]
      );
      const zero = pumps.filter(([, p]) => p <= 0);
      const fielded = (res?.bodyParts ?? 0) > 0 && (bres?.bodyParts ?? 0) > 0;
      const totalPump = pumps.reduce((a, [, p]) => a + Math.max(0, p), 0);
      rows.push({
        id: "P6",
        name: "reservation pump (delivered bank)",
        value: totalPump,
        unit: `ticks banked over ${stampDt}t`,
        verdict:
          fielded && rooms.length > 0 && zero.length === rooms.length
            ? "FAIL"
            : fielded && zero.length >= rooms.length / 2
            ? "WARN"
            : "ok",
        detail: pumps.map(([r, p]) => `${r}:${p}`).join(" ") + (fielded ? "" : " (no reservers fielded)")
      });
    }
  }

  // ---- P7 controller delivery (owner marathon: "upgraders not upgrading") ----
  // Actual rclProgress delta vs the LOWER of the two endpoint plans (a plan
  // that legitimately moved mid-window - construction preempt - must not
  // false-fail). FAIL only when a stable-ish plan went undelivered WITH
  // stock standing at the controller: energy was there, upgraders were not.
  {
    const allocOf = (f: any): number =>
      (f?.sinks ?? []).filter((s: any) => s.type === "controller").reduce((a: number, s: any) => a + (+s.allocated || 0), 0);
    const alloc = Math.min(allocOf(base.data.flow), allocOf(flow));
    const prog1 = (bcore.rooms ?? []).reduce((a: number, r: any) => a + (r.rclProgress ?? 0), 0);
    const prog2 = (core.rooms ?? []).reduce((a: number, r: any) => a + (r.rclProgress ?? 0), 0);
    const actual = dt > 0 ? (prog2 - prog1) / dt : 0;
    const stock1 = (bcore.rooms ?? []).reduce((a: number, r: any) => a + (r.controllerStock ?? 0), 0);
    const stock2 = (core.rooms ?? []).reduce((a: number, r: any) => a + (r.controllerStock ?? 0), 0);
    const stocked = stock1 > 500 && stock2 > 500;
    const ratio = alloc > 0 ? actual / alloc : 1;
    rows.push({
      id: "P7",
      name: "controller delivery vs plan",
      value: +ratio.toFixed(2),
      unit: "x lower-endpoint plan",
      verdict: alloc > 0 && stocked && ratio < 0.5 ? "FAIL" : alloc > 0 && ratio < 0.75 ? "WARN" : "ok",
      detail:
        `actual ${actual.toFixed(1)} e/t vs plan ${alloc.toFixed(1)} (lower endpoint); ` +
        `stock ${stock1}->${stock2}${stocked ? " (stock stood - the energy was there)" : ""}`
    });
  }

  // ---- P8 build delivery (owner marathon: "builders not building") ----
  // Sites standing at BOTH endpoints, construction allocated, and summed site
  // progress FLAT = the build crew idled a whole window. A completion makes
  // progress vanish (site removed), so any drop in count/total reads
  // ambiguous and is skipped - no false alarms on finished builds.
  {
    const sum = (c: any, f: string): number => (c.rooms ?? []).reduce((a: number, r: any) => a + (r[f] ?? 0), 0);
    const hasFields = (core.rooms ?? []).some((r: any) => r.siteCount !== undefined) &&
      (bcore.rooms ?? []).some((r: any) => r.siteCount !== undefined);
    if (hasFields) {
      const consAlloc = Math.min(
        (base.data.flow?.sinks ?? []).filter((s: any) => s.type === "construction").reduce((a: number, s: any) => a + (+s.allocated || 0), 0),
        (flow?.sinks ?? []).filter((s: any) => s.type === "construction").reduce((a: number, s: any) => a + (+s.allocated || 0), 0)
      );
      const count1 = sum(bcore, "siteCount");
      const count2 = sum(core, "siteCount");
      const prog1 = sum(bcore, "siteProgress");
      const prog2 = sum(core, "siteProgress");
      const total1 = sum(bcore, "siteTotal");
      const total2 = sum(core, "siteTotal");
      // REMOTE SITES are sites (gap measured t72503018: home siteCount 0 at
      // both ends while W43N24 held 3 standing sites across 2171t with the
      // receipts frozen at 36/38 and a funded 5-creep crew - the stalled
      // trunk pipeline read "ok / no sites standing"). The segment-0
      // remoteSites census joins the standing/completion predicates; remote
      // progress itself is only measurable via the receipts floor below, so
      // a remote-only window with flat receipts is exactly the stall class.
      const remoteCount = (c: any): number =>
        Object.values(c.remoteSites ?? {}).reduce((a: number, n: any) => a + (+n || 0), 0);
      const remotes1 = remoteCount(bcore);
      const remotes2 = remoteCount(core);
      const completion = count2 < count1 || total2 < total1 || remotes2 < remotes1;
      const standing = count1 + remotes1 > 0 && count2 + remotes2 > 0;
      const delivered = prog2 - prog1;
      // REMOTE BUILD via receipts (gap measured 2026-07-22: P8 read "0 e/t
      // built" all day while cee0's trunk went 35 -> 45 - the rooms[] site
      // meter is home-only and remote build-out was INVISIBLE to the
      // ledger). roadReceipts.built RATCHETS (never counts down), so its
      // delta x ROAD_BUILD_COST is a floor on energy actually built into
      // remote roads - swamp tiles cost more, so this undercounts, never
      // overcounts.
      const ROAD_BUILD_COST = 300;
      const receiptsDelta = ((): number => {
        const r1 = bcore.roadReceipts ?? {};
        const r2 = core.roadReceipts ?? {};
        let tiles = 0;
        for (const k of Object.keys(r2)) {
          const b2 = r2[k]?.built;
          const b1 = r1[k]?.built;
          if (typeof b2 === "number" && typeof b1 === "number" && b2 > b1) tiles += b2 - b1;
        }
        return tiles * ROAD_BUILD_COST;
      })();
      const flat = standing && !completion && delivered <= 0 && receiptsDelta <= 0;
      rows.push({
        id: "P8",
        name: "build delivery (site progress)",
        value: dt > 0 ? +((Math.max(0, delivered) + receiptsDelta) / dt).toFixed(2) : 0,
        unit: "e/t built",
        verdict: flat && consAlloc > 5 ? "FAIL" : flat && consAlloc > 0 ? "WARN" : "ok",
        detail: completion
          ? `completion window (sites ${count1}->${count2}, remote ${remotes1}->${remotes2}) - progress delta ambiguous, skipped` +
            (receiptsDelta > 0 ? `; remote roads +${receiptsDelta}e via receipts` : "")
          : standing || receiptsDelta > 0
          ? `sites ${count1}->${count2}, remote ${remotes1}->${remotes2}, progress ${prog1}->${prog2}, plan alloc ${consAlloc.toFixed(1)} e/t` +
            (receiptsDelta > 0 ? `, remote roads +${receiptsDelta}e (receipts)` : "") +
            (flat ? " - CREW IDLE (energy allocated, nothing built)" : "")
          : "no sites standing across the window"
      });
    }
  }

  // ---- P9 mined-production rot (owner-caught #19, 2026-07-19) ----
  // The plan self-consistency invariant that had NO ledger line: a funded miner
  // whose output the plan never routes. Live t72425058/t72424537: 7 funded mined
  // sources = 70 e/t produced, ZERO mined-source haulers, 0 e/t routed - the 555k
  // bank surplus out-competed real production at the nearest-first fill, so the
  // mined energy rotted at remote containers while the plan still paid to mine
  // it. The leak was invisible: it scattered across E2 (strands), E4 (idle
  // capital) and P7 (starved controller) with no single line naming it. Mined
  // sources carry the "source-" prefix; scavenge/bank ("scavenge-"/"bank-") are
  // free/transient and excluded. Production-first routing + the storage-as-hub
  // sink (this cycle) restore routed ~= produced.
  if (flow?.sources && flow?.haulers) {
    const isMined = (id: any): boolean => typeof id === "string" && id.startsWith("source-");
    // Spec 25 phase 3: no dedication carve-out - a source building locally
    // has ROUTES (source->construction) which count as routed below, so the
    // plain produced-vs-routed test is honest for every source again.
    const produced = (flow.sources as any[]).reduce((a, s) => a + (+s.harvestRate || 0), 0);
    const minedHaulers = (flow.haulers as any[]).filter(h => isMined(h.sourceId));
    const routed = minedHaulers.reduce((a, h) => a + (+h.flowRate || 0), 0);
    const ratio = produced > 0 ? routed / produced : 1;
    const meaningful = produced > 5; // no verdict on a colony with no remote mining
    rows.push({
      id: "P9",
      name: "mined production routed (rot detector)",
      value: +ratio.toFixed(2),
      unit: "x of funded mining",
      verdict: meaningful && ratio < 0.5 ? "FAIL" : meaningful && ratio < 0.8 ? "WARN" : "ok",
      detail:
        `funded mining ${(flow.sources as any[]).length} src / ${produced.toFixed(1)} e/t; ` +
        `routed ${routed.toFixed(1)} e/t via ${minedHaulers.length} mined-source haulers` +
        (meaningful && ratio < 0.5 ? " - MINED PRODUCTION ROTTING (funded but unrouted, #19)" : "")
    });
  }

  // ---- X1 dry WORK ticks (owner doctrine 2026-07-21: "having body parts
  // standing around, unable to do their job is one form of waste ... hauling
  // and working grow in concert, spawned as a package") ----
  // The upgrade meter (Memory.upgradeMeter, tallied at the upgradeController
  // call site) stamps workUtil/dryShare into the upgrader sizing record.
  // Idle standing WORK = work parts x (1 - workUtil): capacity the colony
  // paid spawn time for that produced nothing. dryShare names the supply-
  // starved share of it - the half the package-spawn remedy targets.
  // Pre-meter captures (no workUtil in the stamp) skip the row.
  {
    const upg = (cap.data.corps?.corps ?? []).find((c: any) => c.kind === "upgrade" && c.sizing?.workUtil !== undefined);
    const work = upg?.body?.work ?? 0;
    if (upg && work > 0) {
      const workUtil = +upg.sizing.workUtil;
      const dryShare = +upg.sizing.dryShare || 0;
      const idleWork = work * (1 - workUtil);
      const meaningful = work > 10 && (upg.sizing.meterTicks ?? 0) > 100;
      rows.push({
        id: "X1",
        name: "dry WORK ticks (standing-but-idle)",
        value: +idleWork.toFixed(1),
        unit: "WORK parts idle-equivalent",
        verdict: meaningful && workUtil < 0.7 ? "FAIL" : meaningful && workUtil < 0.85 ? "WARN" : "ok",
        detail:
          `${work} WORK standing, workUtil ${workUtil.toFixed(2)} over ${upg.sizing.meterTicks}t; ` +
          `dry (supply-starved) ${dryShare.toFixed(2)}` +
          (meaningful && workUtil < 0.7 ? " - STANDING PARTS NOT WORKING (grow hauling+working as a package)" : "")
      });
    }
  }

  // ---- X3 census ----
  // ---- X4 lifetime quantization (owner 2026-07-22: "this rounding factor
  // is something we can track in telemetry as well for the future") ----
  // A hauler's effective life divides into floor(life/roundTrip) full
  // trips; the remainder ticks cannot fit another trip. With END-OF-LIFE
  // recycling (same commit) that tail converts to a spawn refund; without
  // it, the body walks its tail off and the amortization is lost. Priced
  // from the PLAN's routes: remainder/life x standing body cost per tick.
  {
    const srcRoutes = (flow?.haulers ?? []).filter((h: any) => (h.sourceId ?? "").startsWith("source-"));
    let waste = 0;
    let worst = "";
    let worstV = 0;
    for (const h of srcRoutes) {
      const d = +h.distance || 0;
      const rt = 2 * d + 2;
      const life = Math.max(1, 1500 - d);
      const rem = life % rt;
      const partsPerCarry = h.ratio === "2:1" ? 1.5 : 2;
      const bodyPerTick = ((+h.carryParts || 0) * partsPerCarry * 50) / life;
      const v = bodyPerTick * (rem / life);
      waste += v;
      if (v > worstV) {
        worstV = v;
        worst = `${String(h.sourceId ?? "").slice(-8)} rem ${rem}t of ${rt}t trips`;
      }
    }
    rows.push({
      id: "X4",
      name: "lifetime quantization (trip rounding)",
      value: +waste.toFixed(2),
      unit: "e/t amortization in trip tails",
      verdict: "ok",
      detail:
        srcRoutes.length > 0
          ? `${srcRoutes.length} routes; worst ${worst}; EOL recycle converts tails to refunds`
          : "no source routes"
    });
  }

  rows.push({
    id: "X3",
    name: "untracked creeps",
    value: core.creeps.untracked,
    unit: "creeps",
    verdict: core.creeps.untracked > 2 ? "FAIL" : "ok",
    detail: `${core.creeps.tracked}/${core.creeps.total} tracked`
  });

  const rank = { FAIL: 0, WARN: 1, ok: 2 };
  return rows.sort((a, b) => rank[a.verdict] - rank[b.verdict]);
}

export function formatLedger(rows: LedgerRow[], capTick: number, baseTick: number): string {
  const out: string[] = [`waste ledger  capture t${capTick}  baseline t${baseTick}  (dt ${capTick - baseTick})`];
  for (const r of rows) {
    out.push(
      `  [${r.verdict.padEnd(4)}] ${r.id.padEnd(3)} ${r.name.padEnd(34)} ${
        Number.isInteger(r.value) ? r.value : r.value.toFixed(2)
      } ${r.unit}`
    );
    out.push(`         ${r.detail}`);
  }
  const fails = rows.filter(r => r.verdict === "FAIL");
  out.push(
    fails.length
      ? `TOP LINE: ${fails[0].id} ${fails[0].name} - this is the cycle's work item`
      : "no FAIL lines - attack the largest WARN or ship the backlog"
  );
  return out.join("\n");
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const get = (flag: string, dflt: string): string => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const cap = loadCapture(get("--capture", "latest"), 0);
  const base = loadCapture(get("--baseline", "prev"), 1);
  console.log(formatLedger(computeLedger(cap, base), cap.tick, base.tick));
}
