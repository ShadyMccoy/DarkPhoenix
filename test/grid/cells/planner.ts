/**
 * planner cells (docs/specs/08, avenue: planning-economy).
 *
 * T0: existence proof that one spawn + one near source yields a published
 * plan - Memory.economyPlan (flowAdapter.publishRoster) with exactly one
 * 'mine' corp for THAT source and at least one 'haul' route - and the spawn
 * acts on it. Guards the "spawn resource not claimed by any node -> 'No spawn
 * sinks' -> zero miners forever" class of failure (attachOwnedSpawnsToNodes).
 */

import { GridCell, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(25, 30).toRoom();

const planCorps = (s: { memory: any }): any[] => s.memory?.economyPlan?.corps ?? [];

export function buildPlannerT1Cells(): GridCell[] {
  let progressSnapshot: number | null = null;

  return [
    {
      // A realistic-distance source closes the whole loop, and the controller
      // allocation is exactly the ANTI_DOWNGRADE_RESERVE floor of 2: the
      // spawn sink (demand 10) legitimately soaks the rest of a 10 e/t supply.
      id: "plan-t1-single-source-loop",
      tier: 1,
      avenue: "planning-economy",
      // 700, twice-measured: at d=22 the cold loop is BRUTALLY slow - the
      // miner only works the source at ~261 (bank regen-bound under the jack
      // economy), so hauler ~300, first upgrader ~400+. This cell is the
      // spec-01 dead window quantified at realistic distance; tightening the
      // window is a job for a bot improvement, not the assertion.
      window: 700,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 47).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("plan: one mine corp, upgrade work exactly the reserve floor", (s) => {
          const corps = planCorps(s);
          const mines = corps.filter((c) => c.kind === "mine");
          const upgrade = corps.find((c) => c.kind === "upgrade");
          return mines.length === 1 && !!upgrade && upgrade.work === 2;
        }),
        eventually("plan routes both circuits (spawn and controller hauls)", (s) => {
          const hauls = planCorps(s).filter((c) => c.kind === "haul");
          const toCtrl = hauls.some((c) => String(c.toId ?? "").startsWith("controller-"));
          const toSpawn = hauls.some((c) => String(c.toId ?? "").startsWith("spawn-"));
          return toCtrl && toSpawn;
        }),
        eventually("a flow miner works the far source", (s) => {
          const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 47);
          if (!src || src.energy >= src.energyCapacity) return false;
          return s.objects().some(
            (o) =>
              o.type === "creep" &&
              typeof o.name === "string" &&
              o.name.startsWith("miner-") &&
              Math.max(Math.abs(o.x - 25), Math.abs(o.y - 47)) <= 1
          );
        }),
        // The delivered trickle physically reaches the controller: progress
        // rises in the back half of the window (upgraders only stand up after
        // the full mine -> haul loop exists - measured ~350+ here). The plan
        // allocates the controller only its 2 e/t reserve floor, so a +20
        // delta is >= 10 ticks of sustained flow-fed upgrading.
        eventually("controller progresses in the back half", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          if (!ctrl) return false;
          if (s.tick < 400) return false;
          if (progressSnapshot === null) {
            progressSnapshot = ctrl.progress ?? 0;
            return false;
          }
          return (ctrl.progress ?? 0) >= progressSnapshot + 20;
        }),
      ],
    },
  ];
}

export const plannerCells: GridCell[] = [
  {
    id: "plan-t0-single-source-commissioned",
    tier: 0,
    avenue: "planning-economy",
    window: 90,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    assertions: [
      eventually("plan mines exactly this source (one mine corp)", (s) => {
        const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 30);
        if (!src) return false;
        const mines = planCorps(s).filter((c) => c.kind === "mine");
        return mines.length === 1 && mines[0].sourceId === `source-${src._id}`;
      }),
      eventually("plan routes at least one haul", (s) => planCorps(s).some((c) => c.kind === "haul")),
      eventually("the spawn acts on the plan", (s) => {
        const spawn = s.objects().find((o) => o.type === "spawn");
        if (spawn?.spawning) return true;
        return Object.values(s.memory?.creeps ?? {}).some((mem: any) => mem?.workType === "harvest");
      }),
    ],
  },
];
