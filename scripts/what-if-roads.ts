/**
 * what-if-roads - the counterfactual planning report (owner 2026-07-20: "I
 * want to see what the planning report would look like ASSUMING we did have
 * roads").
 *
 * Reconstructs the latest capture's colony as a 1-D ColonyProblem (spawn at
 * the origin, every candidate source at its published distance, sinks at
 * their hauler-edge offsets), then solves it TWICE with the real evaluator:
 * baseline vs every mined source marked `paved` (the 2:1 road fleet: 1.5
 * parts/CARRY instead of 2). The diff is the roads dividend in the plan's
 * own terms - funded sources, routed e/t, parts ledger, consumer residual.
 *
 * The reconstruction is deliberately 1-D (distances are what the planner
 * prices; geometry beyond them is irrelevant to the parts ledger), and the
 * report prints both solves so approximation errors cancel in the diff.
 */

import * as fs from "fs";
import * as path from "path";
import { ColonyProblem, PlannerSink, PlannerSource, planColony } from "../src/economy/CorpPlanner";
import { Position } from "../src/types/Position";

const FIXTURES = path.join(__dirname, "..", "test", "fixtures", "telemetry");

function latestCapture(): any {
  const files = fs
    .readdirSync(FIXTURES)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(FIXTURES, f), "utf8")))
    .filter(d => d?.data?.flow?.candidates)
    .sort((a, b) => a.tick - b.tick);
  return files[files.length - 1];
}

const at = (x: number): Position => ({ x, y: 0, roomName: "W" });
const dist = (a: Position, b: Position): number => Math.abs(a.x - b.x);

function reconstruct(cap: any, paveEverything: boolean): ColonyProblem {
  const flow = cap.data.flow;
  // Non-intel candidates are today's real mining world; intel candidates are
  // prospects - include them too, so the what-if shows NEW sources roads
  // could afford, marked (intel) in the report.
  const sources: PlannerSource[] = flow.candidates.map((c: any) => ({
    id: c.sourceId,
    nodeId: c.sourceId,
    pos: at(c.distance),
    rate: c.rate,
    maxMiners: 1,
    ...(paveEverything ? { paved: true } : {})
  }));
  // The hub/bank source: rate = the capture's total bank outflow (what the
  // consumers actually drew this solve).
  const bankOut = (flow.haulers ?? [])
    .filter((h: any) => String(h.sourceId).startsWith("bank-"))
    .reduce((s: number, h: any) => s + (h.flowRate ?? 0), 0);
  sources.push({ id: "bank-W", nodeId: "bank", pos: at(1), rate: bankOut, maxMiners: 0, transient: true });

  // Sinks at their hauler-edge offsets (bank->spawn 1, bank->ctrl ~5); values
  // and capacities verbatim from the capture (demand == capacity).
  const sinks: PlannerSink[] = flow.sinks.map((s: any) => ({
    id: s.id,
    kind: s.type,
    pos: at(s.type === "spawn" ? 0 : s.type === "storage" ? 1 : s.type === "controller" ? 5 : 4),
    value: s.priority,
    capacity: s.demand,
    ...(s.type === "controller" ? { reserve: 2 } : {})
  }));

  return {
    spawns: [{ id: "spawn-1", pos: at(0) }],
    sources,
    sinks,
    infraPartsPerTick: flow.partsLedger?.infra ?? 0,
    dist
  };
}

function report(label: string, plan: ReturnType<typeof planColony>): void {
  const funded = plan.miners.length;
  const routed = plan.haulers
    .filter(h => !h.sourceId.startsWith("bank-"))
    .reduce((s, h) => s + h.flowRate, 0);
  const fundedRate = plan.miners.reduce((s, m) => s + m.rate, 0);
  const haulParts = plan.haulers.reduce((s, h) => s + h.spawnParts, 0);
  const verdictCounts = new Map<string, number>();
  for (const v of plan.sourceVerdicts) verdictCounts.set(v.verdict, (verdictCounts.get(v.verdict) ?? 0) + 1);
  const ctrl = plan.sinks.find(s => s.kind === "controller");
  const stor = plan.sinks.find(s => s.kind === "storage");
  console.log(`${label}`);
  console.log(
    `  funded ${funded} src / ${fundedRate} e/t   routed ${routed.toFixed(1)} e/t   ` +
      `verdicts ${[...verdictCounts].map(([k, n]) => `${k}:${n}`).join(" ")}`
  );
  console.log(
    `  parts: haul ${haulParts.toFixed(4)}/t  budget ${plan.partsLedger.budget.toFixed(4)}  ` +
      `ctrl alloc ${ctrl?.allocated.toFixed(1)}  storage alloc ${stor?.allocated.toFixed(1)}  ` +
      `value ${plan.valueDelivered.toFixed(0)}`
  );
}

const cap = latestCapture();
console.log(`WHAT-IF ROADS  (reconstructed from capture t${cap.tick})\n`);
report("TODAY (unpaved):", planColony(reconstruct(cap, false)));
console.log("");
report("ASSUMING ROADS (every route paved, 2:1 fleets):", planColony(reconstruct(cap, true)));
console.log(
  "\nnote: intel-prefixed sources are unowned prospects - a paved verdict flip" +
    "\non one of those is income roads would UNLOCK, not just cheapen."
);
