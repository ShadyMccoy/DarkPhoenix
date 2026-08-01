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
  CLAIM_LIFETIME,
  CREEP_LIFETIME,
  MINER_PARTS,
  RESERVER_DUTY,
  SOURCE_REGEN_TIME,
  SPAWN_PARTS_PER_TICK,
  carryPartsFor,
  effectiveLife,
  haulerOverhead
} from "../src/economy/primitives";
import { BASE_RESERVE, MAX_SURPLUS_DRAW, SURPLUS_DRAIN_TICKS, feederRelayRate } from "../src/economy/bank";

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

  // CONSTRUCTION, charged THROUGH the plan's all-in price (spec 34 P4): the
  // segment echoes the build commission's operationSpawnLoad (WORK bodies +
  // supply vector) as sinks[].spawnLoad - the class stops being invisible to
  // P4, and for the right reason: an ECHO of the planner's own number, never
  // a ledger-side re-derivation. Legacy captures without the echo emit no
  // line (exactly the pre-v11 behavior - no fabricated figures).
  let cp = 0,
    cl = 0;
  for (const k of (flow.sinks ?? []).filter((s: any) => s.type === "construction" && s.spawnLoad !== undefined)) {
    cl += k.spawnLoad;
    cp += k.spawnLoad * effectiveLife(k.spawnDist ?? 8);
  }
  if (cl > 0) lines.push(["construction (all-in)", cp, cl]);

  const ctrl = (flow.sinks ?? []).find((s: any) => s.type === "controller");
  if (ctrl?.workParts) {
    const parts = ctrl.workParts * upgraderPartsPerWork(corps);
    lines.push(["upgraders (plan WORK)", parts, parts / effectiveLife(10)]);
  }
  const relay = feederRelayRate(banked, BASE_RESERVE);
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

  // PER-ROOM corps are SUMMED, never sampled (measured t72683137): reservation
  // is one corp PER RESERVED ROOM, and `find()` priced only the first. The live
  // colony ran SEVEN, each targets:1 / 4 parts - P4 charged 4 parts where 28
  // stood (0.0074 vs 0.0519 parts/t, a 7x under-count) on a class that was
  // 21.7% of MEASURED spawn spend and ~26% of the session's unexplained
  // plan-vs-actual parts gap. P4's charter is ALL fleet classes; a sampling
  // read of a per-room class breaks it silently.
  const resFallback = fleetParts(corps, "reservation", 4);
  const resParts = corps
    .filter(c => c.kind === "reservation")
    .reduce((sum, c) => {
      const targets = c.sizing?.targets ?? 0;
      // Each corp's OWN measured body when it has one; the fleet body otherwise
      // (a corp between deaths still costs its replacement).
      const body = c.creepCount > 0 ? c.bodyParts / c.creepCount : resFallback;
      return sum + targets * body;
    }, 0);
  const resLoad = resParts / Math.max(1, CLAIM_LIFETIME - 60);
  lines.push(["reservers (claim life)", resParts, resLoad]);

  const total = lines.reduce((s, [, , x]) => s + x, 0);
  return { total, lines };
}

/** HOME-room roles run inside the owned room; an early death there is a bot
 * signal, not the invader/revocation noise the remote-exposed roles (haul,
 * mine, reserve, scout, fight) eat as the price of leaving the walls. */
const HOME_ROLES = new Set(["upgrader", "tanker", "tender", "controllerFeeder", "builder", "bootstrap"]);

/**
 * X5 churn analysis (spec 15): spawn energy lost to EARLY-DEATH rebuilds, read
 * from the blackbox spawn log (segment 5). Discovered live t72509177 - remote
 * haulers were spawned small then replaced full a few hundred ticks later
 * (afford-min-scaled body under a momentary extension dip), and a reserver
 * respawned 25t after itself (below a claim body's ~78t spawn time - a
 * re-order, not a death). Method, so the number can't lie:
 *
 *  - per corp, spawns BEYOND its current staffing are the ones that died and
 *    were replaced (census cross-check) - so fleet GROWTH, e.g. the upgrader
 *    2->3 ramp, never counts as churn (my first hand-count wrongly did);
 *  - each dead spawn is weighted by the fraction of life it did NOT live (gap
 *    to its successor / lifetime), so a natural end-of-life replacement scores
 *    ~0 and only genuinely-early deaths accrue;
 *  - HOME vs REMOTE-exposed split by role: home churn is the bot-controllable
 *    signal the verdict keys on; remote churn is reported but largely
 *    unavoidable (a global reset inflates BOTH for ~1 window - read against the
 *    deploy log).
 *
 * Returns null when the capture predates the blackbox segment (graceful skip).
 */
export function computeChurn(cap: any): {
  churnEnergy: number;
  homeChurn: number;
  remoteChurn: number;
  totalSpawnEnergy: number;
  windowTicks: number;
  worst: string;
  worstGap: number;
} | null {
  const spawns: Array<{ t: number; corp: string; role: string; cost: number }> = (cap.data?.blackbox?.rows ?? [])
    .filter((r: any) => r.k === "spawn" && r.d)
    .map((r: any) => ({ t: r.t, corp: String(r.d.corp), role: String(r.d.role), cost: +r.d.cost || 0 }));
  if (spawns.length < 2) return null;

  const corpsList: any[] = cap.data?.corps?.corps ?? [];
  const staffingOf = (corp: string): number => {
    const c = corpsList.find((x: any) => x.id === corp);
    return c?.creepCount ?? c?.staffing ?? 0;
  };

  const byCorp = new Map<string, Array<{ t: number; role: string; cost: number }>>();
  for (const s of spawns) {
    const arr = byCorp.get(s.corp) ?? [];
    arr.push({ t: s.t, role: s.role, cost: s.cost });
    byCorp.set(s.corp, arr);
  }

  let homeChurn = 0;
  let remoteChurn = 0;
  let worst = "none";
  let worstV = 0;
  let worstGap = Infinity;
  for (const [corp, ss] of byCorp) {
    // A corp of staffing N runs N INDEPENDENT slots. Filled round-robin, a
    // slot's own successor is the spawn N positions later - the CONSECUTIVE
    // spawn is a DIFFERENT slot ~life/N away (and a cohort rebuild wave
    // serialises all N through one spawn ~spawn-time apart). Reading the
    // consecutive gap as one creep's lifetime charged phantom churn to any
    // multi-room corp (measured t72587664: the 4-room reservation corp booked
    // 11828e of "churn" though its per-room cadence was ~656t ~ the 600t claim
    // life - a false WARN on the reserver mechanism the trap list says never to
    // bandaid). The correct lifetime is the SAME-slot gap ss[i+N] - ss[i]; for
    // N=1 that IS the consecutive gap, so single-slot behaviour is unchanged.
    const slots = Math.max(1, staffingOf(corp));
    if (ss.length <= slots) continue; // <= staffing => the fleet GREW, nothing died
    ss.sort((a, b) => a.t - b.t);
    // every spawn with a same-slot successor (i + slots in range) was replaced;
    // the last `slots` spawns are the current incumbents.
    const churned = ss.length - slots;
    for (let i = 0; i < churned; i++) {
      let gap = ss[i + slots].t - ss[i].t;
      const life = ss[i].role === "reserver" ? CLAIM_LIFETIME : 1500;
      // EOL-window exemption (t72651837 phantom, owner 2026-07-29): the
      // stride uses CURRENT staffing, so a fleet that SHRANK mid-window
      // (governor relegation) mispairs a cohort-wave spawn as a slot death
      // (two 4350e bodies bought 153t apart - the spawn's own build time -
      // read as one slot dying at 153t, though both lived full lives). A
      // slot with a natural-lifetime successor ANYWHERE in the log did not
      // churn: if any later spawn sits in [0.9, 1.15]x life from ss[i],
      // that is its real replacement - measure the gap there. Real early
      // deaths (0.2x-life replacements) and re-order loops (<60t) have no
      // such successor and stay caught. EXCUSE-ONLY (max): a window alt may
      // LENGTHEN the measured gap, never shorten it - on a healthy staggered
      // multi-slot corp a DIFFERENT slot's spawn can sit slightly earlier in
      // the window than the true successor, and taking it verbatim would
      // manufacture small churn on exactly the corps this line must not flag.
      for (let m = i + 1; m < ss.length; m++) {
        const alt = ss[m].t - ss[i].t;
        if (alt >= 0.9 * life && alt <= 1.15 * life) {
          gap = Math.max(gap, alt);
          break;
        }
        if (alt > 1.15 * life) break;
      }
      const waste = ss[i].cost * Math.max(0, 1 - gap / life);
      if (HOME_ROLES.has(ss[i].role)) homeChurn += waste;
      else remoteChurn += waste;
      if (waste > worstV) {
        worstV = waste;
        worst = `${corp.replace(/^(hauling|mining|reservation|upgrading|building|moving)-/, "")} ${ss[i].cost}e@${gap}t`;
        worstGap = gap;
      }
    }
  }
  const ts = spawns.map(s => s.t);
  return {
    churnEnergy: homeChurn + remoteChurn,
    homeChurn,
    remoteChurn,
    totalSpawnEnergy: spawns.reduce((a, s) => a + s.cost, 0),
    windowTicks: Math.max(1, Math.max(...ts) - Math.min(...ts)),
    worst,
    worstGap: worstV > 0 ? worstGap : Infinity
  };
}

/**
 * F1's ACTUAL side, bucketed into the same classes `planSpawnLoad` prices.
 *
 * F1 reported "0.286 p/t UNBUDGETED" for five straight cycles while naming
 * only the largest PLANNED class - a different question, and one whose answer
 * never changed. Locating the breach meant hand-bucketing the blackbox ring
 * by role every cycle (t72689264: haulers 0.444 p/t actual vs 0.188 priced =
 * 0.256 of the 0.286 gap, 89%, with the whole remainder in construction and
 * one entirely UNPRICED kind). That is spec 40 Part A's thesis applied to the
 * line that already exists: one number nobody can decompose is worse than a
 * table.
 *
 * The join is the buyer corp's own KIND (segment 4), never a guess from the
 * id string - decision symmetry, same as everywhere else in this file. A kind
 * with no plan line at all is reported separately as UNPRICED: an absent class
 * is a different defect from a mispriced one, and no tuning of an existing
 * line can ever surface it.
 */
export const F1_CLASS_OF_KIND: Record<string, string> = {
  harvest: "miners", // role `hauler` on a harvest corp re-routes below
  construction: "construction (all-in)",
  tender: "tenders",
  controllerFeeder: "feeder",
  reservation: "reservers",
  upgrade: "upgraders"
};

/** Plan-line prefix that each actual class settles against. */
export const F1_PLAN_PREFIX: Record<string, string[]> = {
  miners: ["miners"],
  haulers: ["source-route haulers", "transient-route haulers"],
  "construction (all-in)": ["construction (all-in)"],
  tenders: ["tenders"],
  feeder: ["feeder"],
  reservers: ["reservers"],
  upgraders: ["upgraders"]
};

/**
 * Cost -> parts fallback for rings captured before the spawn row carried a
 * `parts` count. Derived from the archetype bodies the kinds actually build
 * (hauler CARRY+MOVE = 100e/2p; miner 5W+3M = 700e/8p; reserver 2C+2M =
 * 1300e/4p; upgrader 2W+1C+1M = 300e/4p). Estimated lines are LABELLED - the
 * ledger never presents an inference as a measurement.
 */
const F1_ENERGY_PER_PART: Record<string, number> = {
  hauler: 50,
  tanker: 50,
  feeder: 50,
  builder: 100,
  miner: 87.5,
  upgrader: 75,
  reserver: 325,
  guard: 100
};

export function f1Decompose(
  cap: any,
  planLines: Array<[string, number, number]>
): { rows: Array<{ cls: string; actual: number; planned: number; unpriced: boolean }>; estimated: boolean; windowTicks: number } | null {
  const ring: any[] = (cap.data?.blackbox?.rows ?? []).filter((r: any) => r.k === "spawn");
  if (ring.length === 0) return null;
  const corps: any[] = cap.data?.corps?.corps ?? [];
  const kindOf = new Map<string, string>(corps.map(c => [c.id, c.kind]));

  const ts = ring.map(r => r.t);
  const windowTicks = Math.max(1, Math.max(...ts) - Math.min(...ts));
  let estimated = false;
  const actual = new Map<string, number>();
  for (const r of ring) {
    const kind = kindOf.get(r.d.corp) ?? String(r.d.corp).split("-")[0];
    // A hauler is a hauler whoever buys it: the per-source haulers are owned by
    // the HARVEST corp, and the plan prices them on the hauler lines, not the
    // miner line. Route by role first, kind second.
    const cls = r.d.role === "hauler" ? "haulers" : F1_CLASS_OF_KIND[kind] ?? `UNPRICED:${kind}`;
    let parts = r.d.parts;
    if (parts === undefined) {
      estimated = true;
      parts = r.d.cost / (F1_ENERGY_PER_PART[r.d.role] ?? 100);
    }
    actual.set(cls, (actual.get(cls) ?? 0) + parts);
  }

  const rows = [...actual].map(([cls, parts]) => {
    const prefixes = F1_PLAN_PREFIX[cls] ?? [];
    const planned = planLines
      .filter(([name]) => prefixes.some(p => name.startsWith(p)))
      .reduce((a, [, , load]) => a + load, 0);
    return { cls, actual: parts / windowTicks, planned, unpriced: cls.startsWith("UNPRICED:") };
  });
  rows.sort((a, b) => Math.abs(b.actual - b.planned) - Math.abs(a.actual - a.planned));
  return { rows, estimated, windowTicks };
}

export function computeLedger(cap: any, base: any): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const core = cap.data.core;
  const bcore = base.data.core;
  const dt = cap.tick - base.tick;
  const flow = cap.data.flow;
  const corps: any[] = cap.data.corps?.corps ?? [];

  // ---- G1 sustained progress: score NET OF BANK DRAWDOWN (owner 2026-08-01) ----
  //
  // THE GOAL METRIC. Raw pts/t is not it, because the same colony scored 68.29
  // while burning the bank at -45.52 e/t and 47.59 while burning it at -5.74 -
  // and the first is a stockpile liquidation that ends, the second is income.
  //
  // What the sum MEANS (derived, not asserted - the P10 lesson):
  //   bankSlope = income - controller - spawn - construction
  //   => score + bankSlope = income - spawn - construction
  // i.e. the RESIDUAL the economy can sustainably route to the controller at
  // its current spawn and construction burn. Score above it is drawdown; score
  // below it is banking. Both sides are measured in the same unit (energy/tick;
  // one GCL point IS one energy delivered), so the addition is meaningful.
  //
  // Caveat carried in the detail line, not hidden: bankSlope also absorbs
  // construction spend and decay, so `funded` is "not drawn from storage",
  // NOT "converted to progress". It is a floor on sustainability, not an
  // energy audit. Shares an input with E4 but asks a different question - E4
  // asks whether capital is idle, this asks what is paying for the score.
  {
    const bankOf = (c: any): number =>
      (c.data.core.rooms ?? []).reduce((s: number, r: any) => s + (r.storageEnergy ?? 0), 0);
    const g = core.gcl?.progress;
    const bg = bcore.gcl?.progress;
    if (typeof g === "number" && typeof bg === "number" && dt > 0) {
      const score = (g - bg) / dt;
      const slope = (bankOf(cap) - bankOf(base)) / dt;
      const funded = score + slope;
      const share = score > 0 ? funded / score : 1;
      // A window shorter than the measured limit-cycle period samples a PHASE
      // (OSC carries the same warning); say so rather than pretending to a rate.
      const shortWindow = dt < 6000;
      // THREE regimes, not one axis. `funded` is the sustainable capacity;
      // `score` is what was actually delivered against it.
      //  - score >> funded  => LIQUIDATION (the saw-tooth down-stroke)
      //  - score ~= funded  => matched, the healthy state
      //  - score << funded  => UNDER-SPENDING: capacity banked instead of
      //    delivered. Caught in validation: the t72703512 trough scored 19.63
      //    while banking +25.88 and the share form read "232% income-funded,
      //    ok" - a compliment on the wasteful quadrant. A share above 1 is not
      //    more health, it is unconverted capacity, so it gets its own arm.
      const banking = share > 1.05;
      const shortfall = funded - score;
      rows.push({
        id: "G1",
        name: "sustained progress (score net of bank drawdown)",
        value: +funded.toFixed(2),
        unit: `pts/t sustainable (delivered ${score.toFixed(2)}, bank ${slope >= 0 ? "+" : ""}${slope.toFixed(2)})`,
        // FAIL only on LIQUIDATION - the down-stroke shape (measured t72701842:
        // delivered 68.29 against 22.77 sustainable, 33%). Healthy arcs measured
        // 76-88%, so 0.5 separates them with room. Under-spending WARNs: it is
        // real waste (OSC names the same quadrant from the fleet side) but it
        // burns no capital, so it never outranks a liquidation.
        verdict: banking ? "WARN" : score > 0 && share < 0.5 ? "FAIL" : share < 0.75 ? "WARN" : "ok",
        detail:
          (banking
            ? `UNDER-SPENDING: delivering ${score.toFixed(2)} of ${funded.toFixed(2)} sustainable - ` +
              `${shortfall.toFixed(2)} pts/t of capacity BANKED instead of delivered`
            : `${(share * 100).toFixed(0)}% of the score is income-funded`) +
          ` over ${dt}t` +
          (shortWindow ? " [SHORT WINDOW - phase sample, not a rate]" : "") +
          `; sustainable = income - spawn - construction (bank slope also absorbs construction + decay,` +
          ` so this is a sustainability floor, not an energy audit)`
      });
    }
  }

  // ---- P4 plan spawn-feasibility (the audit gap of 2026-07-18) ----
  const { total, lines } = planSpawnLoad(cap);
  const ceiling = (core.spawns?.length ?? 1) * SPAWN_PARTS_PER_TICK;
  const ratio = total / ceiling;

  // ---- F1 plan FIDELITY (owner doctrine 2026-07-30) ----
  // "More than points what we're chasing is a controllable economy ... plan it
  // all on the abstract level and then it gets implemented faithfully ... we
  // end up having to chase down why is this or that thing happening. That's
  // something to optimize for as well."
  //
  // Fidelity was first-class in SIMS (fid-* grid cells) but had NO production
  // number, so every live divergence this session was found BY HAND: the
  // 100-tile fuel price on a 4-tile pile (spec 37), three bank-drain rates
  // (spec 38), P4's 7x reserver under-count, and a six-capture parts gap
  // (measured 0.649 vs plan 0.478) that no line reported. P4 asks "is the plan
  // PHYSICALLY POSSIBLE"; F1 asks "is the plan what actually HAPPENS" - a plan
  // can be perfectly feasible and still describe a different colony.
  //
  // Two-sided ON PURPOSE: a plan that OVER-states is exactly as uncontrollable
  // as one that under-states, and only the under-stating direction looks like
  // "waste" - so a waste-only ledger is blind to half the failure mode.
  {
    const measured = (core.spawns ?? []).reduce((a: number, s: any) => a + (+s.partsPerTick || 0), 0);
    const hasMeter = (core.spawns ?? []).some((s: any) => s.partsPerTick !== undefined);
    if (hasMeter && total > 0) {
      const fidelity = measured / total;
      const gap = measured - total;
      const worst = [...lines].sort((a, b) => b[2] - a[2])[0];
      // WHICH class is in breach - the question five cycles of "largest
      // planned class" could not answer (see f1Decompose).
      const dec = f1Decompose(cap, lines);
      let breach = "";
      if (dec) {
        const top = dec.rows.filter(r => Math.abs(r.actual - r.planned) >= 0.005).slice(0, 3);
        const unpriced = dec.rows.filter(r => r.unpriced && r.actual > 0);
        if (top.length) {
          breach =
            `; in breach: ` +
            top
              .map(
                r =>
                  `${r.cls.replace("UNPRICED:", "")} ${r.actual.toFixed(3)} vs ${r.planned.toFixed(3)} ` +
                  `(${r.actual > r.planned ? "+" : ""}${(r.actual - r.planned).toFixed(3)})`
              )
              .join(", ");
        }
        if (unpriced.length) {
          breach += `; UNPRICED classes: ${unpriced.map(r => `${r.cls.replace("UNPRICED:", "")} ${r.actual.toFixed(3)} p/t`).join(", ")}`;
        }
        if (breach) breach += ` [over ${dec.windowTicks}t${dec.estimated ? ", parts est. from cost" : ""}]`;
      }
      rows.push({
        id: "F1",
        name: "plan fidelity (measured vs planned spawn load)",
        value: +fidelity.toFixed(2),
        unit: "x planned",
        // 1.25/0.8 = a quarter of the plan unaccounted for in either direction.
        verdict: fidelity > 1.25 || fidelity < 0.8 ? "FAIL" : fidelity > 1.1 || fidelity < 0.9 ? "WARN" : "ok",
        detail:
          `spawn builds ${measured.toFixed(3)} p/t, plan prices ${total.toFixed(3)} p/t` +
          (gap > 0
            ? ` - ${gap.toFixed(3)} p/t UNBUDGETED (${(100 * gap / Math.max(1e-9, measured)).toFixed(0)}% of what the spawn builds is not in the plan)`
            : gap < 0
            ? ` - the plan OVER-states by ${(-gap).toFixed(3)} p/t (a fleet priced but never built)`
            : " - faithful") +
          `; largest planned class: ${worst ? `${worst[0]} ${worst[2].toFixed(3)}` : "n/a"}` +
          breach
      });
    }
  }
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

  // ---- P10 plan ENERGY accounting: WITHDRAWN 2026-08-01 (double-counting) ----
  //
  // This row asserted that `netEnergy = totalHarvest - totalOverhead` is "what
  // the solver hands to sinks", and priced the ~28 e/t of spawn spend it does
  // not subtract. The owner called it as double accounting and was right. Two
  // reads killed it:
  //
  //  1. `netEnergyTotal` (flowAdapter.ts:1189) is consumed ONLY by the reported
  //     `netEnergy` / `efficiency` / `isSustainable` fields (lines 1204-1207).
  //     It never gates the sink fill. It is a source-ranking and reporting
  //     statistic, not a budget - so nothing is "handed to sinks" against it.
  //  2. The plan ALREADY funds the spawn as a first-class SINK. Measured
  //     t72707443: spawn sinks allocated 100.0 + 10.0 = 110 e/t against ~48 e/t
  //     of measured spawn spend. Subtracting producer bodies from source yield
  //     AND routing energy to the spawn sink would be the double count - the
  //     solver correctly does only the latter.
  //
  // The row compared a per-source amortized efficiency statistic (producer
  // bodies only) against total measured spend across all classes and called the
  // difference a leak. Those quantities are not comparable and the difference
  // is not a leak.
  //
  // A VALID successor would ask "does the spawn sink allocation cover actual
  // spawn spend", but the sink's `demand` is a REFILL-CAPACITY figure (spawn +
  // extensions), not a rate, so that comparison needs a rate-shaped plan term
  // that does not exist yet. Left unbuilt rather than shipping a second
  // questionable formulation - a ledger line that cries wolf is worse than no
  // line, which X6 already taught this session.

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
    // Compare the bank against the reserve the DECISIONS use: the dynamic
    // income-scaled warchest (core.warchestTarget, exported v17) when the
    // capture carries it, else the static BASE_RESERVE floor (older captures /
    // cold start). Without the dynamic reserve E4 read a bank sitting AT its
    // target as "idle" - a false WARN (t72555188: bank 54.8k == dynamic reserve
    // but 32k "above" the 22.65k base). `idleThreshold` still requires a full
    // reserve's worth of TRUE excess before FAIL, so the signal stays honest.
    const reserve = typeof core.warchestTarget === "number" ? core.warchestTarget : BASE_RESERVE;
    const excess = room.storageEnergy - reserve;
    const idleThreshold = BASE_RESERVE; // a reserve's worth of genuine excess above the (dynamic) target
    // DAMPED-EQUILIBRIUM FRAME (owner 2026-07-29: "we would expect the
    // surplus to maybe rise, until it reaches an equilibrium ... don't
    // necessarily flag that as a red"). Spending is surplus/SURPLUS_DRAIN_TICKS,
    // so the bank does NOT settle at the reserve - it settles where the draw
    // equals net inflow: S* = reserve + SURPLUS_DRAIN_TICKS x netInflow.
    // Projected from the measured slope (slope = inflow - surplus/T =>
    // S*_excess = excess + T x slope), a bank climbing toward a FINITE,
    // absorbable equilibrium is convergence, not idle capital. The leak
    // signatures survive: an equilibrium past the draw-saturation knee
    // (MAX_SURPLUS_DRAW x T - income the spend path physically cannot
    // absorb), and any big idle bank with the spend path DOWN.
    const projectedExcess = excess + SURPLUS_DRAIN_TICKS * slope;
    const knee = MAX_SURPLUS_DRAW * SURPLUS_DRAIN_TICKS;
    // SPEND PATH DOWN vs BETWEEN GENERATIONS (live false FAIL t72665987). The
    // bank's route to the controller is the FEEDER relay (links carry SOURCE
    // energy, not banked energy, so a busy link network does NOT mean the bank
    // is being spent - that distinction is load-bearing here). But
    // `feederActive false` alone conflates a relay that is GATED OFF with one
    // whose creep is simply between generations: at t72665987 the feeder
    // stamped gate "demand" with wantedFeeders 1 / feeders 0 - it had ordered
    // a body and was waiting on the spawn - while P7 delivered 0.91x plan and
    // upgraders ran workUtil 0.999. Trust the stamp over the derived boolean
    // (spec 14): a relay that has DEMANDED a body is in transition; one gated
    // off ("no-storage"/"no-miner"/"no-spawn") or absent entirely is down.
    const feederCorp = corps.find((c: any) => c.kind === "controllerFeeder");
    const feederAwaitingBody =
      feederCorp?.sizing?.gate === "demand" && (feederCorp.sizing.wantedFeeders ?? 0) > 0;
    const spendPathDown = room.feederActive === false && !feederAwaitingBody;
    // RISING is the exemption the owner named: a bank climbing toward a
    // finite, absorbable S* is the damped law converging. A bank FLAT or
    // FALLING at a big surplus is not evidence of convergence (it is equally
    // the stalled-spend-path shape), so it keeps the old watch-level WARN.
    const converging = excess <= idleThreshold || (slope > 0 && projectedExcess < knee && !spendPathDown);
    const runaway = slope > 0 && projectedExcess >= knee;
    rows.push({
      id: "E4",
      name: "idle capital",
      value: excess,
      unit: "energy above the reserve target",
      verdict: converging
        ? "ok"
        : excess > idleThreshold && (runaway || spendPathDown)
        ? "FAIL"
        : excess > idleThreshold
        ? "WARN"
        : "ok",
      detail:
        `storage ${room.storageEnergy} vs reserve ${reserve}${
          typeof core.warchestTarget === "number" ? " (dynamic)" : " (base floor)"
        }, slope ${slope.toFixed(2)}/t over ${dt}t, feederActive ${room.feederActive}${
          feederAwaitingBody ? " (relay between generations - body demanded)" : ""
        }` +
        `; projected equilibrium ${(reserve + projectedExcess).toFixed(0)} (surplus ${projectedExcess.toFixed(0)}` +
        `, knee ${knee}) - ` +
        (converging
          ? excess <= idleThreshold
            ? "at/near target"
            : "CONVERGING toward it (damped draw, healthy - owner 2026-07-29)"
          : spendPathDown
          ? "SPEND PATH DOWN"
          : runaway
          ? "equilibrium past the absorbable knee - income the spend path cannot use"
          : "flat/falling at a big surplus - not convergence evidence; check the spend path")
    });
  }

  // ---- OSC bank/consumer limit cycle: WHICH PHASE is this capture in? ----
  //
  // Confirmed 2026-08-01 across four captures (t72696770→t72703512, 6,742t):
  // the bank and the upgrade fleet oscillate in ANTIPHASE, and the swing is a
  // LIMIT CYCLE, not a transient.
  //
  //   tick        bank    valve  upgAlloc  WORK   score
  //   72696770  149,803   68.20      2.00     2      -
  //   72700221  128,992   54.33     54.71    53   41.51
  //   72701842   55,201   15.00      2.00    68   68.29   <- fleet PEAKS as valve BOTTOMS
  //   72703512   84,511   24.67     25.16    18   13.96
  //
  // Positive feedback drives it: a wide valve builds a big fleet, the big
  // fleet drains the bank past the reserve, `bankSurplusRate` hits 0, the
  // valve slams to STORAGE_UPGRADE_TARGET, and the fleet - which cannot shed
  // faster than a 1,500-tick creep life - keeps burning the bank on the way
  // down. Cycle-average score 41.12 pts/t against an in-arc peak of 68.29:
  // PEAK IS 1.66x THE MEAN.
  //
  // Hence this row. Every score claim in this log is taken over a window
  // SHORTER than the ~9,000-tick period, so it samples a phase - the ledger
  // must say which one, or a trough read looks like a regression and a peak
  // read looks like a win. `standingWork / relayRate` is the single-capture
  // phase indicator: ~1 in phase, >2 the destructive quadrant (a fleet
  // stranded above a shut valve, eating reserve), <0.5 the wasteful quadrant
  // (valve open, fleet not built - the score the colony is not collecting).
  {
    const feeder = corps.find((c: any) => c.kind === "controllerFeeder");
    const relay = feeder?.sizing?.relayRate;
    const work = feeder?.sizing?.standingWork;
    if (typeof relay === "number" && typeof work === "number" && relay > 0) {
      const ratio = work / relay;
      const phase =
        ratio > 2
          ? "STRANDED FLEET above a shut valve (down-stroke: burning reserve, score peaking and about to fall)"
          : ratio < 0.5
          ? "VALVE OPEN, fleet not built (up-stroke: score suppressed, capacity idle)"
          : "in phase (fleet matched to valve)";
      rows.push({
        id: "OSC",
        name: "bank/consumer phase (limit-cycle position)",
        value: +ratio.toFixed(2),
        unit: "standing WORK per e/t of valve",
        // Neither extreme is a defect on its own - it is the SWING that costs.
        // FAIL the destructive quadrant only; WARN the idle one.
        verdict: ratio > 2 ? "FAIL" : ratio < 0.5 ? "WARN" : "ok",
        detail: `${work} WORK standing vs relay valve ${relay.toFixed(2)} e/t - ${phase}; ` +
          `read any score over a <9,000t window as a PHASE SAMPLE, not a rate (peak/mean measured 1.66x)`
      });
    }
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
  // Attribution-aware (t72523980): a hauler bought small for a route the PLANNER
  // sizes small (scavenge / distance-1 short-haul, carryParts < 3) is RIGHT-sized,
  // not a drained-spawn purchase. The plan-blind cost<300 test flagged every
  // scavenge hauler forever (2/2 flagged runts were scavenge-W43N24-30-20, plan
  // carryParts 1.41) - a standing false positive that trains us to ignore E5 and
  // would mask a REAL drained runt. Keep the runt verdict only when the plan
  // wanted a real body (carryParts >= 3) or no plan route vouches for the size.
  const routeCarry = new Map<string, number>();
  for (const h of (flow.haulers ?? []) as any[]) {
    const suf = String(h.sourceId).replace(/^source-|^scavenge-[EW]\d+[NS]\d+-|^bank-/, "").slice(-4);
    routeCarry.set(suf, Math.max(routeCarry.get(suf) ?? 0, h.carryParts));
  }
  const plannedMicroHauler = (corp: string): boolean => {
    const suf = String(corp).replace(/^hauling-[EW]\d+[NS]\d+-hauling-/, "").slice(-4);
    const carry = routeCarry.get(suf);
    return carry !== undefined && carry < 3; // plan owns this route AND sizes it small
  };
  const runts = (agenda.executed ?? []).filter(
    (e: any) =>
      e.cost < 300 &&
      !["reserver", "scout"].includes(e.role) &&
      !(e.role === "hauler" && plannedMicroHauler(e.corp))
  );
  rows.push({
    id: "E5",
    name: "runt purchases",
    value: runts.length,
    unit: "of last " + (agenda.executed ?? []).length + " receipts",
    verdict: runts.length > 1 ? "WARN" : "ok",
    detail: runts.map((e: any) => `${e.role}@${e.cost}`).join(", ") || "none"
  });

  // ---- SCAV scavenge economics (instrument-first for the economic gate) ----
  // Each scavenger's net-energy-per-spawn-part vs the MARGINAL funded source
  // route (the least efficient real route we already pay for = the opportunity
  // cost of a spawn part). The spawn shadow price only BITES when parts bind
  // (partsLedger.dry): with slack, a scavenger spends parts nothing else wants,
  // so a low ratio is free; when dry, a scavenger below the margin is displacing
  // a better use. This is the read that will calibrate the gate's threshold.
  const netPerPart = (h: any): number => {
    const carry = h.carryParts ?? carryPartsFor(h.flowRate, h.distance);
    const net = h.flowRate - haulerOverhead(carry, h.distance);
    return h.spawnParts > 0 ? net / h.spawnParts : 0;
  };
  const scavHaulers = (flow.haulers ?? []).filter((h: any) => String(h.sourceId).startsWith("scavenge-"));
  const realRoutes = (flow.haulers ?? []).filter(
    (h: any) => !String(h.sourceId).startsWith("scavenge-") && !String(h.sourceId).startsWith("bank-")
  );
  const dry = flow.partsLedger?.dry ?? false;
  if (scavHaulers.length > 0) {
    const margin = realRoutes.length > 0 ? Math.min(...realRoutes.map(netPerPart)) : Infinity;
    const scavRatios = scavHaulers.map((h: any) => ({ id: String(h.sourceId).replace(/^scavenge-/, ""), r: netPerPart(h) }));
    const belowMargin = scavRatios.filter((s: { r: number }) => s.r < margin);
    rows.push({
      id: "SCAV",
      name: "scavenge economics (net-e/part vs margin)",
      value: belowMargin.length,
      unit: `of ${scavHaulers.length} scavengers below the funded margin`,
      // Instrument-first: only WARN when spawn parts BIND and a scavenger sits
      // below the marginal funded route - the calibrated displacement signal.
      verdict: dry && belowMargin.length > 0 ? "WARN" : "ok",
      detail:
        `spawn parts ${dry ? "DRY (binding)" : `slack (spent ${(flow.partsLedger?.spent ?? 0).toFixed(3)}/${(flow.partsLedger?.budget ?? 0).toFixed(3)})`}` +
        `; margin ${margin === Infinity ? "n/a" : margin.toFixed(2)} net-e/part; ` +
        scavRatios.map((s: { id: string; r: number }) => `${s.id} ${s.r.toFixed(2)}`).join(", ")
    });
  }

  // ---- LINK link-throughput instrument (spec-26, read-only knowledge) ----
  // ACTUAL e/t the link network carries: hub inflow, controller DELIVERY receipt
  // (what the first spec-26 never measured), the cheap 1-hop direct share, and
  // the 3% tax. Informational until the planner models links; a controller flow
  // with 0% direct share is a visible missed easy-win (always double-hopping).
  const links = core.links ?? [];
  if (links.length > 0) {
    const active = links.filter((l: any) => l.toHubRate + l.toControllerRate > 0.01);
    const missedDirect = active.filter((l: any) => l.toControllerRate > 0.5 && l.directShare < 0.01);
    rows.push({
      id: "LINK",
      name: "link throughput (hub / controller receipt / direct / tax)",
      value: active.length,
      unit: "rooms with a live link network",
      verdict: "ok", // instrument-first: surface numbers, don't gate behavior yet
      detail:
        (active.length === 0
          ? "no link fires in the window"
          : active
              .map(
                (l: any) =>
                  `${l.room} hub ${l.toHubRate.toFixed(1)} ctrl ${l.toControllerRate.toFixed(1)} (direct ${(l.directShare * 100).toFixed(0)}%) tax ${l.taxRate.toFixed(2)} /${l.windowTicks}t`
              )
              .join("; ")) +
        (missedDirect.length > 0
          ? ` | double-hopping to controller in ${missedDirect.map((l: any) => l.room).join(",")} (0% direct - easy win)`
          : "")
    });
  }

  // ---- DEP deposit-side link instrument (spec-26 stage 4, read-only) ----
  // For each REMOTE source, the haul a hauler would save by depositing at a
  // home-room link it passes instead of walking to storage, plus the deposit
  // flow that would pile on each link (throughput headroom). Informational: it
  // sizes the potential lever before the depositPos routing is re-activated.
  const dep = flow.depositSavings;
  if (dep && (dep.candidates ?? []).length > 0) {
    const cands = [...dep.candidates].sort((a: any, b: any) => b.saving - a.saving);
    const totalFlow = cands.reduce((a: number, c: any) => a + c.flowRate, 0);
    const savedPartsProxy = cands.reduce((a: number, c: any) => a + c.saving * c.flowRate, 0);
    rows.push({
      id: "DEP",
      name: "deposit-side link opportunity (remote haul shortened)",
      value: cands.length,
      unit: "remote sources that could deposit at a home link",
      verdict: "ok", // instrument-first: surface the lever, don't route yet
      detail:
        cands
          .slice(0, 6)
          .map((c: any) => `${c.sourceId.slice(-4)} saves ${c.saving} (haul ${c.haulDist}->${c.linkDist}) @${c.flowRate.toFixed(1)}e/t`)
          .join("; ") +
        ` | per-link deposit flow: ${(dep.perLink ?? [])
          .map((l: any) => {
            const ctrl = l.linkId === dep.controllerLinkId;
            const cap = ctrl && dep.controllerCapacity !== undefined ? ` (controller: bank-neutral <=${dep.controllerCapacity.toFixed(0)}e/t)` : "";
            return `${l.linkId.slice(-4)} ${l.depositFlow.toFixed(1)}e/t x${l.sources}${cap}`;
          })
          .join(", ")}` +
        ` | ${totalFlow.toFixed(0)}e/t over ${cands.length} routes, ~${Math.round(savedPartsProxy)} tile*e/t saved`
    });
  }

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

  // ---- S4 idle attribution: WHERE the spawn's idle ticks go ----
  // The S3 stall is a boolean snapshot; this is the windowed breakdown from
  // the v18 spawns[].idle tally (classifySpawnIdle). "spawn capacity but short
  // on haulers" is exactly this read: bank = energy-starved (feed the spawn
  // faster), empty = the plan isn't demanding a body (demand-side gap), hold =
  // a chosen wait, buy = exec latency. Recoverable idle (bank+hold) above the
  // threshold means spawn-time is being left on the table. Absent pre-v18.
  if (spawn && (spawn as any).idle) {
    const idle = (spawn as any).idle as { empty: number; bank: number; buy: number; hold: number };
    const total = idle.empty + idle.bank + idle.buy + idle.hold;
    const win = spawn.windowTicks || 1;
    const recoverable = (idle.bank + idle.hold) / win; // fraction of the window
    const parts = Object.entries(idle)
      .filter(([, v]) => v > 0)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .map(([k, v]) => `${k} ${(((v as number) / Math.max(1, total)) * 100).toFixed(0)}%`)
      .join(" ");
    rows.push({
      id: "S4",
      name: "spawn idle attribution",
      value: +recoverable.toFixed(3),
      unit: "recoverable idle frac",
      verdict: recoverable > 0.15 ? "WARN" : "ok",
      detail: `idle ${((total / win) * 100).toFixed(0)}% of window [${parts}] - bank=energy-starved, empty=no-demand, hold=chosen-wait, buy=latency`
    });
  }

  // ---- H1 hauler execution duty: are fielded haulers working or waiting? ----
  // The (a) vs (c) disambiguator (owner 2026-07-25). Reads the v?/segment-4
  // CarryCorp duty stamp (active vs idle-empty vs idle-loaded, realized). High
  // duty WITH source buffers over container cap => the plan under-asks (carry
  // is inflow-sized, no drain term) - a plan fix. Low duty / high idleSource
  // => execution loss (energy standing, haulers idle/blocked) - a behavior fix.
  // idleSink => sink backpressure (storage/port full). Absent pre-instrument.
  {
    const haulers = corps.filter(c => c.kind === "carry" && c.sizing && c.sizing.duty !== undefined);
    const creeps = haulers.reduce((s, c) => s + (c.creepCount || 0), 0);
    if (haulers.length > 0 && creeps > 0) {
      const wavg = (f: string): number =>
        haulers.reduce((s, c) => s + (c.sizing[f] || 0) * (c.creepCount || 0), 0) / creeps;
      const duty = wavg("duty");
      const idleSource = wavg("idleSourceFrac");
      const idleSink = wavg("idleSinkFrac");
      const idleSinkAtSink = wavg("idleSinkAtSinkFrac");
      const idleSinkEnRoute = Math.max(0, idleSink - idleSinkAtSink);
      // Of the atSink idle: how much had the hub storage with ROOM (=> spatial
      // contention at the deposit, NOT sink saturation). Absent pre-instrument.
      const atSinkStorageRoom = wavg("idleSinkStorageRoomFrac");
      const atSinkContended = idleSinkAtSink > 1e-9 && atSinkStorageRoom >= idleSinkAtSink * 0.5;
      // Buffers over container cap (2000) = energy on the ground.
      const buffers: Record<string, number> = core.sourceBuffers ?? {};
      const overCap = Object.values(buffers).reduce((s, v) => s + Math.max(0, (v as number) - 2000), 0);
      const piled = overCap > 3000;
      // Only a leak worth flagging when energy is actually piling up. Then a
      // LOW duty (or high idleSource) is the execution smoking gun.
      const executionLoss = piled && (duty < 0.75 || idleSource > 0.2);
      rows.push({
        id: "H1",
        name: "hauler execution duty",
        value: +duty.toFixed(3),
        unit: "active frac",
        verdict: executionLoss ? "WARN" : "ok",
        detail:
          `duty ${duty.toFixed(2)} (idleSource ${idleSource.toFixed(2)}, idleSink ${idleSink.toFixed(2)} ` +
          `[atSink ${idleSinkAtSink.toFixed(2)}, enRoute ${idleSinkEnRoute.toFixed(2)}]) over ` +
          `${haulers.length} corps/${creeps} creeps; ground-piled ${Math.round(overCap)}e ` +
          (piled
            ? duty >= 0.75 && idleSource <= 0.2 && idleSink <= 0.2
              ? "- haulers BUSY => plan under-asks (inflow-sized carry, no drain term)"
              : idleSinkEnRoute >= idleSinkAtSink
              ? "- idleSink EN-ROUTE => approach-lane congestion (traffic / standing blocker at the core)"
              : atSinkContended
              ? `- idleSink AT-SINK, storage HAD ROOM (${atSinkStorageRoom.toFixed(2)}) => SPATIAL contention at the deposit (queue / parked mover), not saturation => geometry/deposit-spread fix`
              : "- idleSink AT-SINK, storage FULL => sink saturation (spill the load / open the drain)"
            : "- buffers near cap, no leak")
      });
    }
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
    const sinkAlloc = Math.min(allocOf(base.data.flow), allocOf(flow));
    const prog1 = (bcore.rooms ?? []).reduce((a: number, r: any) => a + (r.rclProgress ?? 0), 0);
    const prog2 = (core.rooms ?? []).reduce((a: number, r: any) => a + (r.rclProgress ?? 0), 0);
    const actual = dt > 0 ? (prog2 - prog1) / dt : 0;
    const stock1 = (bcore.rooms ?? []).reduce((a: number, r: any) => a + (r.controllerStock ?? 0), 0);
    const stock2 = (core.rooms ?? []).reduce((a: number, r: any) => a + (r.controllerStock ?? 0), 0);
    const stocked = stock1 > 500 && stock2 > 500;
    // WARTIME AWARENESS (spec 33, t72599790): while the upgrader fleet is
    // relegated (a build backlog stands and the surplus funds building, not the
    // controller), the controller's real target is the RELEGATED floor
    // (upgrader sizing.allocated ~= the anti-downgrade sip), NOT the controller
    // flow sink - which still reads the save-regime STORAGE_UPGRADE_TARGET (15)
    // because the plan-side cap is a no-op (max(15,2)=15). Measuring the
    // draining incumbents against 15 false-FAILs (0.47x) EVERY cycle of a build
    // campaign, masking any real P7 regression. In wartime the target is the
    // relegated floor: actual OVER it is the expected incumbent drain (ok); a
    // FAIL is only a controller starved BELOW its inviolable floor WITH stock
    // standing (the link broke - a genuine downgrade risk, relegated != off).
    const upg = corps.find((c: any) => c.kind === "upgrade" && c.sizing);
    const wartime = upg?.sizing?.wartime === true;
    const relegatedFloor = Math.max(1, +upg?.sizing?.allocated || 1);
    const alloc = wartime ? relegatedFloor : sinkAlloc;
    const ratio = alloc > 0 ? actual / alloc : 1;
    const verdict = wartime
      ? stocked && ratio < 0.5
        ? "FAIL"
        : "ok"
      : sinkAlloc > 0 && stocked && ratio < 0.5
        ? "FAIL"
        : sinkAlloc > 0 && ratio < 0.75
          ? "WARN"
          : "ok";
    rows.push({
      id: "P7",
      name: "controller delivery vs plan",
      value: +ratio.toFixed(2),
      unit: wartime ? "x RELEGATED floor (wartime)" : "x lower-endpoint plan",
      verdict,
      detail: wartime
        ? `wartime: relegated floor ${alloc.toFixed(1)}, delivering ${actual.toFixed(1)} e/t ` +
          `(incumbents draining to the sip); stock ${stock1}->${stock2} - surplus funds building, not the controller`
        : `actual ${actual.toFixed(1)} e/t vs plan ${sinkAlloc.toFixed(1)} (lower endpoint); ` +
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
      // WITHIN-SITE remote progress via the construction corp's poolWork
      // stamp (false-FAIL measured t72679468: remote count 9->9, receipts
      // flat, poolWork 3826->2252 - 1,574e built into partially-complete
      // sites while P8 said "CREW IDLE"). The stamp sums the pool's REMAINING
      // work ("room:energy,room*:energy"); a FALL is a conservative floor on
      // energy built - placements RAISE poolWork, so the delta only ever
      // undercounts (same direction as the receipts floor). Requires the
      // stamp at BOTH endpoints (v10+); absent on either side -> 0.
      const poolWorkSum = (cap: any): number | null => {
        let sum = 0;
        let seen = false;
        for (const corp of cap?.corps ?? []) {
          const pw = corp?.sizing?.poolWork;
          if (typeof pw !== "string") continue;
          seen = true;
          for (const entry of pw.split(",")) {
            const n = Number(entry.slice(entry.lastIndexOf(":") + 1));
            if (Number.isFinite(n)) sum += n;
          }
        }
        return seen ? sum : null;
      };
      const pool1 = poolWorkSum(base.data.corps);
      const pool2 = poolWorkSum(cap.data.corps);
      const poolBuilt = pool1 !== null && pool2 !== null ? Math.max(0, pool1 - pool2) : 0;
      const flat = standing && !completion && delivered <= 0 && receiptsDelta <= 0 && poolBuilt <= 0;
      rows.push({
        id: "P8",
        name: "build delivery (site progress)",
        value: dt > 0 ? +((Math.max(0, delivered) + receiptsDelta + poolBuilt) / dt).toFixed(2) : 0,
        unit: "e/t built",
        verdict: flat && consAlloc > 5 ? "FAIL" : flat && consAlloc > 0 ? "WARN" : "ok",
        detail: completion
          ? `completion window (sites ${count1}->${count2}, remote ${remotes1}->${remotes2}) - progress delta ambiguous, skipped` +
            (receiptsDelta > 0 ? `; remote roads +${receiptsDelta}e via receipts` : "")
          : standing || receiptsDelta > 0 || poolBuilt > 0
          ? `sites ${count1}->${count2}, remote ${remotes1}->${remotes2}, progress ${prog1}->${prog2}, plan alloc ${consAlloc.toFixed(1)} e/t` +
            (receiptsDelta > 0 ? `, remote roads +${receiptsDelta}e (receipts)` : "") +
            (poolBuilt > 0 ? `, within-site +${poolBuilt}e (poolWork ${pool1}->${pool2})` : "") +
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

  // ---- E6 miner pile gate: haul-deficit visibility (owner 2026-07-29) ----
  // The HarvestCorp buffer gate defers NEW miner bodies while a source mouth
  // holds >= SOURCE_BUFFER_DEFER_THRESHOLD unhauled (segment-4 stamp, v6).
  // The gate is a BACKSTOP against rot, not a fix: a holding gate means the
  // HAUL side is behind (missing drain term / route sizing / churn - the
  // CarryCorp pickup-buffer stamp names which). This line keeps the deferral
  // from MASKING that: chronic gating (both captures) WARNs on the haul
  // side, and a source gone DARK behind a full pile (gated with staffing 0 -
  // income actually stopped) FAILs. No stamped harvest corps => pre-gate
  // capture => no row.
  {
    const stamped = corps.filter((c: any) => c.kind === "harvest" && c.sizing);
    if (stamped.length > 0) {
      const gated = stamped.filter((c: any) => c.sizing.gate === "buffer-full");
      const bGated = new Set(
        (base.data.corps?.corps ?? [])
          .filter((c: any) => c.kind === "harvest" && c.sizing?.gate === "buffer-full")
          .map((c: any) => c.id)
      );
      const chronic = gated.filter((c: any) => bGated.has(c.id));
      const dark = gated.filter((c: any) => (c.sizing.staffing ?? 0) === 0);
      // Delay meter verdicts (v7 stamps, owner 2026-07-29): heldFor is the
      // MEASURED consecutive hold - one source regen cycle of continuous
      // deferral WARNs from a single capture (no second-capture wait), a
      // full miner lifetime FAILs (a whole generation of spawning
      // suppressed behind one pile). Pre-meter stamps (no heldFor) fall
      // back to the two-capture chronic read.
      const lifetimeHeld = gated.filter((c: any) => (c.sizing.heldFor ?? 0) >= CREEP_LIFETIME);
      // The frac trigger needs >=50t of current hold behind it (the
      // two-captures->=50t doctrine): a reset wipes the meter window and 7
      // all-held samples read frac 1.0 on 7 ticks of evidence (measured
      // first contact, t72645498 - real piles, premature verdict).
      const regenHeld = gated.filter(
        (c: any) =>
          (c.sizing.heldFor ?? 0) >= SOURCE_REGEN_TIME ||
          ((c.sizing.heldFrac ?? 0) >= 0.5 && (c.sizing.heldFor ?? 0) >= 50)
      );
      rows.push({
        id: "E6",
        name: "miner pile gate (haul deficit surfaced)",
        value: gated.length,
        unit: `of ${stamped.length} miner ops deferred`,
        verdict:
          dark.length > 0 || lifetimeHeld.length > 0
            ? "FAIL"
            : chronic.length > 0 || regenHeld.length > 0
            ? "WARN"
            : "ok",
        detail:
          gated.length === 0
            ? "no deferrals - source buffers under threshold"
            : gated
                .map(
                  (c: any) =>
                    `${String(c.id).slice(-14)} buffered ${c.sizing.buffered} staffing ${c.sizing.staffing}/${c.sizing.target}` +
                    (c.sizing.heldFor !== undefined
                      ? ` held ${c.sizing.heldFor}t (${((c.sizing.heldFrac ?? 0) * 100).toFixed(0)}% of window)`
                      : "") +
                    (bGated.has(c.id) ? " CHRONIC" : "")
                )
                .join("; ") +
              " => the leak is HAULING (drain term / route sizing / churn - read the carry pickup stamps), not the miner" +
              (dark.length > 0 ? `; ${dark.length} source(s) DARK behind a full pile - income stopped` : "")
      });
    }
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

  // ---- X6 over-built hauler bodies (needs the blackbox spawn log, segment 5) ----
  //
  // The regression pin for the 2026-07-31 route-sizing fix. A hauler body is
  // never worth more CARRY than its WHOLE route can load; past that the parts
  // are dead weight bought out of a saturated spawn's build time. Both sizers
  // used to measure a body against the ROOM's maxCarryPairs (25 at RCL7), so
  // a 7-CARRY route bought 25-CARRY bodies and retired the 8-CARRY incumbent
  // that covered it - measured 0.471 p/t of hauler spawn against a plan of
  // 0.225 with the STANDING fleet on plan (t72695674).
  //
  // Measured against the plan's per-route carryParts, with headroom for the
  // legitimate terms the plan number does not carry: the buffer-DRAIN term
  // (haulCarryNeeded adds staged/1500 on top of sustained inflow) and integer
  // body rounding. OVERBUILD_TOLERANCE is deliberately loose - this row must
  // catch a 3.5x over-buy without false-failing a drain-fed body, because a
  // ledger line that cries wolf gets ignored (the lesson E5's plan-blind
  // cost<300 test already taught).
  {
    const spawnRows = ((cap.data.blackbox?.rows ?? []) as any[]).filter(
      r => r.k === "spawn" && r.d?.role === "hauler" && typeof r.d?.parts === "number"
    );
    // suffix -> {carry, ratio} of the planned route, same id convention the
    // corp ids use (legacyNodeId keys off sourceId.slice(-4)).
    const planRoute = new Map<string, { carry: number; ratio: string }>();
    for (const h of (flow?.haulers ?? []) as any[]) {
      const suf = String(h.sourceId).replace(/^source-|^scavenge-[EW]\d+[NS]\d+-|^bank-/, "").slice(-4);
      const prev = planRoute.get(suf);
      if (!prev || h.carryParts > prev.carry) planRoute.set(suf, { carry: +h.carryParts || 0, ratio: h.ratio ?? "1:1" });
    }
    // The corp's OWN carryNeeded stamp beats the plan number wherever it
    // exists: haulCarryNeeded = sustained inflow PLUS the buffer-drain term, so
    // a route with a standing pile legitimately needs more carry than the plan
    // prices and a plan-only comparator false-fails it (measured while building
    // this row: W44N22-17-6 read 4.0x against a 2.0c plan route while its own
    // stamp said carryNeeded 11 behind a 4,114 pile - not an over-buy at all).
    // `hauling-*` corps stamp it directly; `mining-*` operations expose their
    // haul vector's stamp via innerSizing (segment 4 v12+, 2026-07-31).
    //
    // Read from BOTH ENDPOINTS and keep the MAX (2026-07-31, second cycle):
    // a body is judged against the largest need its route carried during the
    // window, because the plan can re-route a source mid-life. Measured on the
    // first live FAIL this row produced: `mining-W43N24-harvest-cd8d` bought a
    // 22-CARRY hauler at t72701035 against a stamped carryNeeded of 18 (1.2x -
    // correct), and the wartime regime then re-pointed the source at a
    // construction site ONE TILE away, collapsing carryNeeded to 5. Judged on
    // the closing stamp alone that correct body reads 4.4x over. A pin that
    // cries wolf is worse than no pin - it trains us to ignore the line.
    const stampedNeed = new Map<string, number>();
    const noteNeed = (id: string, n: unknown): void => {
      if (typeof n === "number") stampedNeed.set(id, Math.max(stampedNeed.get(id) ?? 0, n));
    };
    for (const capture of [cap, base]) {
      for (const c of (capture?.data?.corps?.corps ?? []) as any[]) {
        noteNeed(c.id, c.sizing?.carryNeeded);
        for (const inner of (c.innerSizing ?? []) as any[]) noteNeed(c.id, inner.sizing?.carryNeeded);
      }
    }
    const OVERBUILD_TOLERANCE = 2.0;
    let overParts = 0;
    let worst = "";
    let worstRatio = 0;
    let judged = 0;
    let stamped = 0;
    for (const r of spawnRows) {
      const suf = String(r.d.corp)
        .replace(/^mining-[EW]\d+[NS]\d+-harvest-|^hauling-[EW]\d+[NS]\d+-hauling-/, "")
        .slice(-4);
      const route = planRoute.get(suf);
      if (!route || route.carry <= 0) continue; // no plan route vouches for a size
      const need = stampedNeed.get(String(r.d.corp)) ?? route.carry;
      if (need <= 0) continue;
      judged += 1;
      stamped += stampedNeed.has(String(r.d.corp)) ? 1 : 0;
      // spawned CARRY back out of the body: 1:1 packs 2 parts per CARRY, the
      // road ratio 2:1 packs 1.5.
      const partsPerCarry = route.ratio === "2:1" ? 1.5 : 2;
      const spawnedCarry = r.d.parts / partsPerCarry;
      // At or below the sizer's own HAULER_MIN_CARRY floor the body size is set
      // by the FLOOR, not by the route, so it cannot be an over-buy however
      // small the route is. Without this the row fails on every micro-route's
      // 1-CARRY body (a 0.1c planned route reads 7.9x) - which is P2's finding,
      // not this row's, and is the false-positive class that trains us to
      // ignore a line.
      if (spawnedCarry <= 3) continue;
      const ceiling = need * OVERBUILD_TOLERANCE;
      if (spawnedCarry <= ceiling) continue;
      overParts += (spawnedCarry - need) * partsPerCarry;
      const ratio = spawnedCarry / need;
      if (ratio > worstRatio) {
        worstRatio = ratio;
        worst = `${r.d.corp} ${spawnedCarry.toFixed(0)}c on a ${need.toFixed(1)}c route (${ratio.toFixed(1)}x)`;
      }
    }
    const allRows = (cap.data.blackbox?.rows ?? []) as any[];
    const window = allRows.length > 1 ? allRows[allRows.length - 1].t - allRows[0].t : 0;
    if (judged > 0 && window > 0) {
      const pt = overParts / window;
      rows.push({
        id: "X6",
        name: "over-built hauler bodies (route-sizing pin)",
        value: +pt.toFixed(3),
        unit:
          `p/t bought above the route (${judged} hauler spawns judged` +
          (stamped * 2 < judged ? `, DRAIN-BLIND on ${judged - stamped} - needs segment 4 v12 stamps)` : `)`),
        // FAIL only on a body more than DOUBLE its whole route - the shape the
        // fix removed. Any excess at all is worth a WARN once it is measurable.
        verdict: worstRatio >= 2.5 ? "FAIL" : pt > 0 ? "WARN" : "ok",
        detail:
          `${stamped}/${judged} judged against the corp's OWN carryNeeded stamp (rest against the plan route, drain-blind) - ` +
          (worstRatio > 0
            ? `worst ${worst}; ${overParts.toFixed(0)} parts over ${window}t`
            : `every hauler body within ${OVERBUILD_TOLERANCE}x its route's need`)
      });
    }
  }

  // ---- X5 rebuild churn (needs the blackbox spawn log, segment 5) ----
  {
    const churn = computeChurn(cap);
    if (churn && churn.totalSpawnEnergy > 0) {
      const homeShare = churn.homeChurn / churn.totalSpawnEnergy;
      // a gap below one creep's ~60t spawn floor cannot be a sequential death -
      // it is a re-order/loop (the stranded-reserver trap, or a post-reset
      // double-order). Flag it regardless of home/remote.
      const loop = churn.worstGap < 60;
      rows.push({
        id: "X5",
        name: "rebuild churn (early-death respawns)",
        value: +(churn.churnEnergy / churn.totalSpawnEnergy).toFixed(2),
        unit: "of spawn spend",
        verdict: homeShare > 0.12 || loop ? "WARN" : "ok",
        detail:
          `${churn.churnEnergy.toFixed(0)}e of ${churn.totalSpawnEnergy}e over ${churn.windowTicks}t ` +
          `(home ${((100 * churn.homeChurn) / churn.totalSpawnEnergy).toFixed(0)}% bot-signal, ` +
          `remote ${((100 * churn.remoteChurn) / churn.totalSpawnEnergy).toFixed(0)}% invader/revoke noise); ` +
          `worst ${churn.worst}` +
          (loop ? " - FAST RESPAWN (<60t = double-order/loop; check vs deploy log + P5/P6)" : "") +
          (homeShare > 0.12 && !loop ? " - HOME churn high (a reset inflates it ~1 window; read deploy log)" : "")
      });
    }
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
