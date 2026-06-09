/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * plan-budget - run the planner on mocked nodes and print the part budget.
 *
 * No simulation: the number/size of creeps is a function of the planning engine,
 * so we just feed it mock sources/sinks and read off what it commissions.
 */
import { planEconomy, PlannerInput, PlannerSink, PlannerSource, CorpSpec } from "../src/flow/EconomyPlanner";
import { Position } from "../src/types/Position";

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}
const dist = (a: Position, b: Position): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A room with `n` sources, one spawn, one controller (far), one build site. */
function room(n: number): PlannerInput {
  const sources: PlannerSource[] =
    n === 1
      ? [{ id: "source-A", supply: 10, pos: at(25, 30) }]
      : [
          { id: "source-A", supply: 10, pos: at(15, 30) },
          { id: "source-B", supply: 10, pos: at(35, 30) },
        ];
  const sinks: PlannerSink[] = [
    { id: "spawn-S", kind: "spawn", value: 100, capacity: 0, pos: at(25, 25) },
    { id: "construction-X", kind: "construction", value: 70, capacity: 5, pos: at(25, 30) },
    { id: "controller-C", kind: "controller", value: 50, capacity: 1000, reserve: 2, pos: at(25, 10) },
  ];
  return { sources, sinks, spawnId: "S", dist };
}

/** Body parts a corp spec turns into (WORK/CARRY + the MOVE to go with them). */
function partsOf(c: CorpSpec): { work: number; carry: number; move: number } {
  if (c.kind === "mine") return { work: c.work, carry: 0, move: Math.ceil(c.work / 2) };
  if (c.kind === "haul") return { work: 0, carry: c.carry, move: c.carry };
  // build/upgrade: WORK + 1 CARRY to hold energy + MOVE per ~2 parts
  return { work: c.work, carry: 1, move: Math.ceil((c.work + 1) / 2) };
}

const SPAWN_PARTS_PER_LIFETIME = 1500 / 3; // 500

for (const n of [1, 2]) {
  const plan = planEconomy(room(n));
  console.log(`\n=== ${n} source(s) ===  overhead=${plan.overhead.toFixed(2)} unrouted=${plan.unrouted.toFixed(2)}`);
  let work = 0, carry = 0, move = 0;
  for (const c of plan.corps) {
    const p = partsOf(c);
    work += p.work; carry += p.carry; move += p.move;
    const size = c.kind === "haul" ? `${(c as any).carry}C` : `${(c as any).work}W`;
    const to = c.kind === "haul" ? ` ${c.fromId.slice(-1)}->${c.toId.replace(/-.*/, "")}` : "";
    console.log(`  ${c.kind.padEnd(8)} ${size}${to}`);
  }
  const total = work + carry + move;
  console.log(`  -> WORK ${work}, CARRY ${carry}, MOVE ${move} = ${total} body parts`);
  console.log(`  -> spawn can sustain ~${SPAWN_PARTS_PER_LIFETIME} parts; this budget uses ${((total / SPAWN_PARTS_PER_LIFETIME) * 100).toFixed(0)}%`);
}
