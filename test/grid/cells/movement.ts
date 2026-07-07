/**
 * movement cells (docs/specs/08, avenue: movement).
 *
 * T0: existence proof that travelTo delivers a miner to THE harvest tile and
 * it holds. The expected tile is hand-derived from bestAdjacentTile's
 * tie-break (errata wrong-behavior #3): first tile at minimal Chebyshev
 * distance to the spawn in dx,dy = -1..1 iteration order with strict '<'
 * (src/corps/nodeEnergy.ts:115-127). For source (30,25) vs spawn (25,25) the
 * ties at distance 4 resolve to the first candidate, (29,24) - NOT the
 * straight-line (29,25). If the cell geometry changes, recompute by hand.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(30, 25).toRoom();

/** bestAdjacentTile(source(30,25), spawn(25,25)) per the tie-break above. */
const SPOT = { x: 29, y: 24 };

export const movementCells: GridCell[] = [
  {
    id: "move-reach-harvest-spot",
    tier: 0,
    avenue: "movement",
    window: 70,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "m1",
        x: 27,
        y: 25,
        body: ["work", "work", "move"],
        memory: { workType: "harvest", corpId: "staged-move", assignedSourceId: "$id(home,source,30,25)" },
      },
      // Jack suppressor: workType 'haul' with NO corpId - BootstrapCorp counts
      // it as a hauler so no jack ever contests the harvest spot, and
      // OrphanRescue provably never touches it (churn-canary-untouched).
      { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
    ],
    assertions: [
      eventually("adopted by the mining corp", (s) => {
        const corpId = s.memory?.creeps?.m1?.corpId;
        return typeof corpId === "string" && corpId.startsWith("mining-");
      }),
      eventually("seated on the designated harvest tile", (s) => {
        const c = s.creep("m1");
        return !!c && c.x === SPOT.x && c.y === SPOT.y;
      }),
      // Once seated it must hold the tile (minerApproach 'stay'); grace covers
      // adoption (~11 measured) plus the 2-tile walk.
      always(
        "holds the harvest tile once seated",
        (s) => {
          const c = s.creep("m1");
          return !!c && c.x === SPOT.x && c.y === SPOT.y;
        },
        30
      ),
      // 2 WORK = 4/tick from ~tick 15; well under 2900 by mid-window. A miner
      // that reached the tile but idles (no harvest intents) never satisfies.
      eventually("harvesting drains the source", (s) => {
        const src = s.objects().find((o) => o.type === "source" && o.x === 30 && o.y === 25);
        return !!src && src.energy <= 2900;
      }),
    ],
  },
];
