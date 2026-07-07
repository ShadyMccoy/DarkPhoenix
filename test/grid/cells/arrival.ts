/**
 * arrival cells (docs/specs/08, avenue: work-transition).
 *
 * T0 FLAGSHIP: the zombie-miner cell. A miner already standing on
 * sourceHarvestSpot must harvest as soon as its corp claims it - the exact
 * signature of the repo's oldest open flake ("mining corp at 0/10 actual",
 * docs/specs/00-corp-framework.md:248, 01-rcl5-cold-start-stall.md:37) is a
 * miner AT its post producing NOTHING. Staging the moment directly turns an
 * alternating integration flake into a deterministic 60-tick verdict.
 *
 * Expected tile: bestAdjacentTile(source(25,30), spawn(25,25)) resolves ties
 * (distance 4) to the first candidate in dx,dy=-1..1 order -> (24,29), not
 * the straight-line (25,29) (errata wrong-behavior #3).
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(18, 20).source(25, 30).toRoom();

/** bestAdjacentTile(source(25,30), spawn(25,25)) per the tie-break above. */
const SPOT = { x: 24, y: 29 };

export const arrivalCells: GridCell[] = [
  {
    id: "arrive-miner-on-spot-harvests",
    tier: 0,
    avenue: "work-transition",
    window: 60,
    rooms: { home: homeRoom },
    bot: { x: 25, y: 25 },
    controller: { level: 2 },
    creeps: [
      {
        name: "m1",
        x: SPOT.x,
        y: SPOT.y,
        body: ["work", "work", "work", "work", "work", "move"],
        memory: { workType: "harvest", corpId: "stale-mining", assignedSourceId: "$id(home,source,25,30)" },
      },
      // Jack suppressor (see spawn-exec.ts): keeps the source drain attributable.
      { name: "decoy", x: 20, y: 22, body: ["carry", "move"], memory: { workType: "haul" } },
    ],
    assertions: [
      eventually("adopted by the source's mining corp", (s) => {
        const corpId = s.memory?.creeps?.m1?.corpId;
        return typeof corpId === "string" && corpId.startsWith("mining-");
      }),
      // Staged ON the spot: frozen pre-adoption, approach 'stay' after. Any
      // move at any tick is a failure.
      always("never leaves the harvest tile", (s) => {
        const c = s.creep("m1");
        return !!c && c.x === SPOT.x && c.y === SPOT.y;
      }),
      // The zombie discriminator: 5 WORK = 10/tick from adoption (~11 measured)
      // drains 150 by ~tick 27. A zombie miner leaves the source near-full until
      // the organically-spawned second miner (2W, ~4/tick, fielded much later)
      // could touch it - which cannot reach -150 by tick 35.
      eventually("harvests promptly after adoption (anti-zombie)", (s) => {
        if (s.tick > 35) return false;
        const src = s.objects().find((o) => o.type === "source" && o.x === 25 && o.y === 30);
        return !!src && src.energy <= 2850;
      }),
      // Corroboration via the bot's own accounting: the 25-tick corpVariance
      // snapshot must show the mining corp producing (zombie signature: 0).
      eventually("corpVariance shows mining actual > 0", (s) => {
        const rows = s.memory?.corpVariance;
        return Array.isArray(rows) && rows.some((r: any) => r.type === "mining" && r.actual > 0);
      }),
    ],
  },
];
