/* diag: reproduce the #19-batch spawn-starvation - is the bank drawn to fill
 * the spawn deficit? Live t72428914: spawn alloc 75, controller 13, 7 mined
 * sources @ ~[1,4,10,11,15,36,40], bank 444k (home), 0 bank haulers, spawn
 * starved. Run the REAL planner on that shape and print the bank draw + the
 * per-sink source breakdown. Compare bank-last (part-1) vs nearest-first. */
import { planColony, ColonyProblem, PlannerSource, PlannerSink, PlannerSpawn } from "../src/economy/CorpPlanner";
import { Position } from "../src/types/Position";

const ROOM = "W0N0";
const at = (x: number): Position => ({ x, y: 0, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const spawn = (id: string, x: number): PlannerSpawn => ({ id, pos: at(x) });
const source = (id: string, x: number, rate = 10): PlannerSource => ({ id, nodeId: `n-${id}`, pos: at(x), rate, maxMiners: 1 });
const stock = (id: string, x: number, rate: number): PlannerSource => ({ id, nodeId: `n-${id}`, pos: at(x), rate, maxMiners: 0, transient: true });
const sink = (id: string, kind: PlannerSink["kind"], x: number, value: number, capacity: number): PlannerSink => ({ id, kind, pos: at(x), value, capacity });

const problem: ColonyProblem = {
  dist: manhattan,
  spawns: [spawn("S", 0)],
  // 7 mined sources at live-ish distances + a huge home bank (444k surplus, drawn up to the 100 cap)
  sources: [
    source("m1", 1), source("m2", 4), source("m3", 10), source("m4", 11),
    source("m5", 15), source("m6", 36), source("m7", 40),
    // the DROPPED energy of the un-hauled miners, re-counted as scavenge supply
    // (live t72428914: 5 scavenge haulers alongside the 7 mined sources). If the
    // plan counts BOTH the miner's rate AND its drop, apparent supply inflates
    // and the bank draw is suppressed - a plan execution can't deliver.
    stock("scavenge-m4", 11, 10), stock("scavenge-m5", 15, 10),
    stock("scavenge-m6", 36, 10), stock("scavenge-m7", 40, 10),
    stock("bank-home", 2, 100)
  ],
  // spawn wants 75 (highest value), controller wants ~13 (surplus upgrade)
  sinks: [sink("spawn-S", "spawn", 0, 100, 75), sink("ctrl", "controller", 6, 50, 13)],
  infraPartsPerTick: 0.105
};

const plan = planColony(problem);
const budget = 1 / 3 - plan.miners.reduce((s, m) => s + 8 / (1500 - m.distance), 0) - 0.105;
console.log("miners funded:", plan.miners.map(m => m.sourceId).join(",") || "none");
console.log("verdicts:", plan.sourceVerdicts.map(v => `${v.sourceId}:${v.verdict}`).join(" "));
console.log("partsBudget ~", budget.toFixed(4), "(1/3 - minerLoad - infra)");
for (const s of plan.sinks) {
  const bank = s.sources.find(x => x.sourceId === "bank-home")?.amount ?? 0;
  const mined = s.sources.filter(x => x.sourceId.startsWith("m")).reduce((a, x) => a + x.amount, 0);
  console.log(`sink ${s.sinkId.padEnd(10)} demand=${s.demand} allocated=${s.allocated.toFixed(1)} | mined=${mined.toFixed(1)} bank=${bank.toFixed(1)} partsLeft=${(s.partsLeft ?? -1).toFixed(4)}`);
}
const bankTotal = plan.sinks.reduce((sum, k) => sum + (k.sources.find(x => x.sourceId === "bank-home")?.amount ?? 0), 0);
const spawnSink = plan.sinks.find(s => s.sinkId === "spawn-S")!;
console.log(`\nBANK DRAWN TOTAL: ${bankTotal.toFixed(2)} e/t   SPAWN FILLED: ${spawnSink.allocated.toFixed(1)}/${spawnSink.demand}`);
console.log(bankTotal < 1 && spawnSink.allocated < spawnSink.demand - 1 ? ">>> REPRODUCED: spawn under-filled AND bank not drawn" : ">>> not reproduced (bank drawn or spawn full)");
