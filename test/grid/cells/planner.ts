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
