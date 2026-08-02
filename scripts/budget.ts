/**
 * budget - solve the PLAN offline, in milliseconds, from a capture.
 *
 * Owner 2026-08-02: *"the plan and the budget is really just a static
 * calculation based off of some node and corp data. I feel like we should be
 * able to eat on that one a lot quicker."*
 *
 * Exactly right, and the whole reason this program has been slow. `planColony`
 * is PURE - given a ColonyProblem it returns a plan with no Game, no server, no
 * ticks. Everything we have been waiting on prod for (deploy, wait 1500 ticks,
 * recapture) was only ever needed for the ACTUAL side. The BUDGET side is a
 * function call.
 *
 * This reconstructs the latest capture as a ColonyProblem and re-solves it with
 * the real evaluator, so a planner change can be priced before it is shipped.
 * `what-if-roads` proved the pattern (owner, 2026-07-20); this generalises it
 * and adds the thing that makes it trustworthy.
 *
 * THE FIDELITY CHECK IS THE POINT. A reconstruction that does not reproduce the
 * captured plan cannot price a change to it - the diff would be measuring the
 * reconstruction, not the change. So every run first re-solves the capture AS
 * CAPTURED and reports how closely it lands; only then does a what-if mean
 * anything. The reconstruction is deliberately 1-D (distance is what the
 * planner prices; geometry beyond it never enters the parts ledger), and the
 * check is what tells you whether that approximation held.
 *
 * Usage:
 *   npm run budget                    # latest capture: fidelity + budget
 *   npm run budget -- --tick 72722670 # a specific capture
 *   npm run budget -- --what-if paved # A/B a knob against the baseline
 *   npm run budget -- --what-if no-link-tax
 *   npm run budget -- --what-if no-invader-tax
 *
 * @module scripts/budget
 */

import * as fs from "fs";
import * as path from "path";
import { ColonyProblem, PlannerSink, PlannerSource, planColony } from "../src/economy/CorpPlanner";
import { LINK_TRANSFER_LOSS } from "../src/economy/primitives";
import { Position } from "../src/types/Position";

const FIXTURES = path.join(__dirname, "..", "test", "fixtures", "telemetry");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function captures(): any[] {
  return fs
    .readdirSync(FIXTURES)
    .filter(f => /^shard1-t\d+\.json$/.test(f))
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8")))
    .filter(d => d?.data?.flow?.candidates)
    .sort((a, b) => a.tick - b.tick);
}

/** 1-D world: a source sits at its captured distance from the spawn. */
const at = (x: number): Position => ({ x, y: 0, roomName: "W" });
const dist = (a: Position, b: Position): number => Math.abs(a.x - b.x);

export interface WhatIf {
  /** Every route paved (2:1 fleets: 1.5 parts/CARRY instead of 2). */
  paved?: boolean;
  /** Drop the link transfer tax - what the plan believed before 2026-08-01. */
  noLinkTax?: boolean;
  /** Drop the invader tax. */
  noInvaderTax?: boolean;
}

/**
 * Rebuild the capture as a ColonyProblem.
 *
 * Sources come from `candidates` (the planner's OWN per-source pricing record),
 * so rate/distance/tax are the exact numbers the captured decision read rather
 * than a re-derivation. Link service is read from `sources[].linkServed` (flow
 * v14) - the flag exists precisely so this does not have to infer it.
 */
export function reconstruct(cap: any, what: WhatIf = {}): ColonyProblem {
  const flow = cap.data.flow;
  const linkServed = new Set(
    ((flow.sources ?? []) as any[]).filter(s => s.linkServed).map(s => String(s.id))
  );

  const sources: PlannerSource[] = (flow.candidates as any[]).map(c => {
    const isLink = linkServed.has(String(c.sourceId));
    // The captured `tax` is the SUM of the invader and link terms. Setting
    // haulPos below makes the planner re-charge the link term itself, so the
    // link share must come out before the remainder is handed back as
    // invaderTax - otherwise a link-served source is taxed twice (caught by the
    // fidelity check: cd90 read tax 0.60 offline against 0.30 captured).
    const linkShare = isLink ? c.rate * LINK_TRANSFER_LOSS : 0;
    const perEnergy = c.rate > 0 ? Math.max(0, c.tax - linkShare) / c.rate : 0;
    return {
      id: c.sourceId,
      nodeId: c.sourceId,
      pos: at(c.distance),
      rate: c.rate,
      maxMiners: 1,
      // A link-served source hauls from the core link, not from itself - the
      // haul-of-zero the plan prices, and the flag the link tax keys off.
      ...(isLink && !what.noLinkTax ? { haulPos: at(1) } : {}),
      ...(what.paved ? { paved: true } : {}),
      ...(perEnergy > 0 && !what.noInvaderTax ? { invaderTax: perEnergy } : {})
    } as PlannerSource;
  });

  const bankOut = ((flow.haulers ?? []) as any[])
    .filter(h => String(h.sourceId).startsWith("bank-"))
    .reduce((s, h) => s + (h.flowRate ?? 0), 0);
  if (bankOut > 0) {
    sources.push({ id: "bank-W", nodeId: "bank", pos: at(1), rate: bankOut, maxMiners: 0, transient: true } as PlannerSource);
  }

  const sinks: PlannerSink[] = (flow.sinks as any[]).map(s => ({
    id: s.id,
    kind: s.type,
    pos: at(s.type === "spawn" ? 0 : s.type === "storage" ? 1 : s.type === "controller" ? 5 : 4),
    value: s.priority,
    capacity: s.demand,
    ...(s.type === "controller" ? { reserve: 2 } : {})
  })) as PlannerSink[];

  // SPAWN COUNT IS NOT COSMETIC: the parts ledger's capacity is per-spawn, so
  // assuming one spawn on a two-spawn colony HALVES the build budget and the
  // fill stops funding sources part-way. That is exactly what the fidelity
  // check caught on first run (6 funded of 10, budget 0.134 vs the captured
  // 0.412) - and it is a defect `what-if-roads` has carried since July, where
  // no such check existed to reveal it.
  const spawnCount = Math.max(1, ((flow.sinks ?? []) as any[]).filter(s => s.type === "spawn").length);
  const spawns = Array.from({ length: spawnCount }, (_v, i) => ({ id: `spawn-${i}`, pos: at(0) }));

  return {
    spawns,
    sources,
    sinks,
    infraPartsPerTick: flow.partsLedger?.infra ?? 0,
    infraEnergyPerTick: flow.summary?.fleetCharge?.infra ?? 0,
    dist
  };
}

interface Solved {
  funded: number;
  fundedRate: number;
  routed: number;
  overhead: number;
  controller: number;
  storage: number;
  haulParts: number;
  budget: number;
  spent: number;
}

function summarise(plan: ReturnType<typeof planColony>): Solved {
  const real = plan.haulers.filter(h => !h.sourceId.startsWith("bank-"));
  return {
    funded: plan.miners.length,
    fundedRate: plan.miners.reduce((s, m) => s + m.rate, 0),
    routed: real.reduce((s, h) => s + h.flowRate, 0),
    overhead: plan.totalOverhead,
    controller: plan.sinks.find(s => s.kind === "controller")?.allocated ?? 0,
    storage: plan.sinks.find(s => s.kind === "storage")?.allocated ?? 0,
    haulParts: plan.haulers.reduce((s, h) => s + h.spawnParts, 0),
    budget: plan.partsLedger.budget,
    spent: plan.partsLedger.spent
  };
}

/** What the CAPTURE itself recorded, for the fidelity comparison. */
function captured(cap: any): { funded: number; overhead: number; controller: number } {
  const flow = cap.data.flow;
  return {
    funded: (flow.candidates as any[]).filter(c => c.verdict === "funded").length,
    overhead: flow.summary?.totalOverhead ?? 0,
    controller: (flow.sinks as any[])
      .filter(s => s.type === "controller")
      .reduce((n, s) => n + (s.allocated ?? 0), 0)
  };
}

function pct(a: number, b: number): string {
  if (Math.abs(b) < 1e-9) return a === 0 ? "  0.0%" : "   n/a";
  return `${(((a - b) / b) * 100).toFixed(1).padStart(6)}%`;
}

function main(): void {
  const all = captures();
  if (all.length === 0) {
    console.log("no captures with a flow segment in test/fixtures/telemetry");
    return;
  }
  const wanted = arg("tick");
  const cap = wanted ? all.find(c => String(c.tick) === wanted) ?? all[all.length - 1] : all[all.length - 1];

  const t0 = process.hrtime.bigint();
  const base = summarise(planColony(reconstruct(cap)));
  const solveMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const real = captured(cap);

  console.log(`PLAN BUDGET  (re-solved OFFLINE from capture t${cap.tick})\n`);

  // ---- fidelity: does the reconstruction reproduce the captured plan? ----
  // PRICING fidelity and ADMISSION fidelity are different claims and must be
  // reported separately: the per-source pricing can be bit-exact (it is) while
  // the budget ceiling that decides how many get funded still differs. Blending
  // them into one verdict would hide the good half and misattribute the bad.
  const capV = new Map((cap.data.flow.candidates as any[]).map(c => [c.sourceId, c]));
  let priced = 0;
  let exact = 0;
  for (const v of planColony(reconstruct(cap)).sourceVerdicts) {
    const c: any = capV.get(v.sourceId);
    if (!c) continue;
    priced += 1;
    if (Math.abs(v.net - c.net) < 0.005 && Math.abs(v.parts - c.parts) < 5e-4) exact += 1;
  }

  console.log("  FIDELITY OF THE RECONSTRUCTION  (a what-if is only as good as this)");
  console.log(
    `    per-source PRICING       ${exact}/${priced} exact (net + parts, to 4dp)` +
      `${exact === priced ? "  <- the planner's own arithmetic, reproduced" : ""}`
  );
  console.log(`    ${"".padEnd(24)}${"OFFLINE".padStart(10)}${"CAPTURED".padStart(11)}${"DELTA".padStart(9)}`);
  console.log(`    ${"funded sources".padEnd(24)}${String(base.funded).padStart(10)}${String(real.funded).padStart(11)}${pct(base.funded, real.funded).padStart(9)}`);
  console.log(`    ${"totalOverhead e/t".padEnd(24)}${base.overhead.toFixed(2).padStart(10)}${real.overhead.toFixed(2).padStart(11)}${pct(base.overhead, real.overhead).padStart(9)}`);
  console.log(`    ${"controller alloc e/t".padEnd(24)}${base.controller.toFixed(2).padStart(10)}${real.controller.toFixed(2).padStart(11)}${pct(base.controller, real.controller).padStart(9)}`);
  const admissionOff = Math.abs(base.funded - real.funded) / Math.max(1, real.funded);
  if (exact === priced && admissionOff > 0.05) {
    console.log(
      "    => PRICING is exact, ADMISSION is not: the budget ceiling funds a different\n" +
        "       number of sources than the live fill did. What-ifs that move a PRICE are\n" +
        "       sound; ones that hinge on how many sources get admitted are not yet."
    );
  } else if (admissionOff <= 0.05) {
    console.log("    => the reconstruction TRACKS the live plan; what-ifs below are meaningful.");
  } else {
    console.log(
      "    => RECONSTRUCTION DIVERGES. Treat every what-if below as suspect - the diff\n" +
        "       would be measuring the approximation, not the change."
    );
  }

  console.log(`\n  THE BUDGET (plan side, solved in ${solveMs.toFixed(1)} ms - no server, no ticks)`);
  console.log(`    funded            ${base.funded} sources / ${base.fundedRate.toFixed(0)} e/t gross`);
  console.log(`    routed            ${base.routed.toFixed(2)} e/t`);
  console.log(`    fleet overhead    ${base.overhead.toFixed(2)} e/t`);
  console.log(`    controller        ${base.controller.toFixed(2)} e/t   <- THE CONTROLLER BUDGET`);
  console.log(`    to storage/bank   ${base.storage.toFixed(2)} e/t`);
  console.log(`    spawn parts       ${base.spent.toFixed(4)} of ${base.budget.toFixed(4)} /t`);

  const knob = arg("what-if");
  if (knob) {
    const map: Record<string, WhatIf> = {
      paved: { paved: true },
      "no-link-tax": { noLinkTax: true },
      "no-invader-tax": { noInvaderTax: true }
    };
    const what = map[knob];
    if (!what) {
      console.log(`\n  unknown --what-if "${knob}" (have: ${Object.keys(map).join(", ")})`);
      return;
    }
    const alt = summarise(planColony(reconstruct(cap, what)));
    console.log(`\n  WHAT-IF: ${knob}`);
    console.log(`    ${"".padEnd(20)}${"BASE".padStart(10)}${"WHAT-IF".padStart(10)}${"DELTA".padStart(10)}`);
    const row = (label: string, a: number, b: number, dp = 2): void =>
      console.log(
        `    ${label.padEnd(20)}${a.toFixed(dp).padStart(10)}${b.toFixed(dp).padStart(10)}${`${b - a >= 0 ? "+" : ""}${(b - a).toFixed(dp)}`.padStart(10)}`
      );
    row("funded sources", base.funded, alt.funded, 0);
    row("routed e/t", base.routed, alt.routed);
    row("fleet overhead", base.overhead, alt.overhead);
    row("controller e/t", base.controller, alt.controller);
    row("spawn parts /t", base.spent, alt.spent, 4);
    console.log("    Both sides are solved from the SAME reconstruction, so its\n    approximation errors cancel in the delta.");
  }
}

if (require.main === module) main();
