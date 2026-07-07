/**
 * hauling cells (docs/specs/08, avenue: logistics).
 *
 * T0: existence proof of the full income loop - the RCL2 flow economy fields
 * a real hauler and the spawn gets REFILLED after being drained by spawning.
 * The refill check only arms once a flow hauler exists, so a jack-only
 * economy can't satisfy it; per the errata (window #9) plus the measured
 * first-miner-at-138, the window stays at 300.
 *
 * NOTE this cell carries closure state (sawDrainSinceHauler) - cells are
 * constructed once per process, which holds for a grid run; a future
 * rerun-in-process flake policy must rebuild cells (see cells/index.ts).
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(20, 25).source(25, 30).toRoom();

const flowHaulerExists = (s: { memory: any }) =>
  Object.entries(s.memory?.creeps ?? {}).some(
    ([name, mem]: [string, any]) => name.startsWith("hauler-") && mem?.workType === "haul"
  );

export function buildHaulingCells(): GridCell[] {
  let prevSpawnEnergy: number | null = null;

  return [
    {
      id: "haul-t0-first-delivery",
      tier: 0,
      avenue: "logistics",
      window: 300,
      rooms: { home: homeRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("a flow hauler is fielded", flowHaulerExists),
        // A hauler delivery is a bulk single-tick jump in the spawn store
        // (self-regen is +1/tick; jacks have recycled once a flow hauler
        // exists, so no other bulk filler remains).
        eventually("spawn receives a bulk delivery after the hauler exists", (s) => {
          const spawn = s.objects().find((o) => o.type === "spawn");
          const energy = spawn?.store?.energy ?? null;
          const jumped =
            prevSpawnEnergy !== null &&
            energy !== null &&
            energy - prevSpawnEnergy >= 40 &&
            flowHaulerExists(s);
          prevSpawnEnergy = energy;
          return jumped;
        }),
        // The loop must never wedge the colony: some creep is always alive
        // after the opening jack economy stands up.
        always("colony never empties", (s) => s.objects().some((o) => o.type === "creep"), 30),
      ],
    },
  ];
}
