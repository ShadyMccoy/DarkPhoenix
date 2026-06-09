/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-corp-value - price corps by the chains they would find.
 *
 * No simulation: a corp's worth is a function of the planning engine, so we feed
 * mock sources/sinks to the CorpValuator and read off the marginal economy each
 * candidate unlocks. The headline is the spawn corp - on its own it mints
 * nothing, but it is worth the whole roster of miners/haulers/upgraders it
 * staffs.
 */
import { Position } from "../src/types/Position";
import { PlannerInput, PlannerSink, PlannerSource, CorpSpec } from "../src/flow/EconomyPlanner";
import {
  valuateSpawnCorp,
  valuateSourceCorp,
  valuateSinkCorp,
  CorpValuation,
} from "../src/planning/CorpValuator";

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}
const dist = (a: Position, b: Position): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A room with `n` sources, one spawn, one controller, one construction site. */
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

function describeCorp(c: CorpSpec): string {
  if (c.kind === "mine") return `mine ${c.work}W @ ${c.sourceId}`;
  if (c.kind === "haul") return `haul ${c.carry}C ${c.fromId}->${c.toId.replace(/-.*/, "")}`;
  if (c.kind === "build") return `build ${c.work}W @ ${c.sinkId}`;
  return `upgrade ${c.work}W @ ${c.sinkId}`;
}

function report(label: string, v: CorpValuation): void {
  console.log(`\n=== ${label} ===`);
  console.log(`  marginalValue=${v.marginalValue.toFixed(2)}  marginalThroughput=${v.marginalThroughput.toFixed(2)} e/tick`);
  console.log(`  chain it finds (${v.enabledCorps.length} corps):`);
  for (const c of v.enabledCorps) console.log(`    - ${describeCorp(c)}`);
}

// 1. The value of a spawn corp: the whole economy it stands up.
report("spawn corp, 1 source", valuateSpawnCorp(room(1)));
report("spawn corp, 2 sources", valuateSpawnCorp(room(2)));

// 2. The marginal value of adding a second source to a one-source economy.
const base = room(1);
report(
  "+source-B onto a 1-source economy",
  valuateSourceCorp({ id: "source-B", supply: 10, pos: at(35, 30) }, base)
);

// 3. The marginal value of opening a new construction project.
report(
  "+construction-Y onto the 1-source economy",
  valuateSinkCorp({ id: "construction-Y", kind: "construction", value: 80, capacity: 4, pos: at(20, 28) }, base)
);
