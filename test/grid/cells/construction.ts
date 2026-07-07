/**
 * construction cells (docs/specs/08, avenue: construction).
 *
 * T0: at RCL2 (container rungs gated to RCL3+) the ConstructionCorp's
 * first-ever placement is an extension, its tile satisfies every
 * findGridPosition predicate, and the one-site-at-a-time policy holds.
 * The room is all-plain inside the border, so the >=3-walkable-neighbours
 * rule reduces to staying inside the 2..47 interior - asserted directly.
 */

import { GridCell, always, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const SOURCE = { x: 25, y: 32 };
const SPAWN = { x: 25, y: 25 };
const CONTROLLER = { x: 25, y: 10 };

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(CONTROLLER.x, CONTROLLER.y).source(SOURCE.x, SOURCE.y).toRoom();

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

const sites = (s: { objects(h?: string): any[] }) =>
  s.objects().filter((o: any) => o.type === "constructionSite");

/** Every findGridPosition predicate, checked from outside the bot. */
const obeysGridRules = (site: { x: number; y: number }): boolean =>
  (site.x + site.y) % 2 === 0 && // checkerboard
  cheb(site, SOURCE) >= 2 &&
  cheb(site, SOURCE) <= 6 && // clusters near the source
  cheb(site, SPAWN) > 1 && // clear of the spawn ring
  cheb(site, CONTROLLER) > 2 && // clear of the controller camp
  site.x >= 2 &&
  site.x <= 47 &&
  site.y >= 2 &&
  site.y <= 47; // interior (plain room => >=3 walkable neighbours)

// ---------------------------------------------------------------------------
// T1 rung-order cells share this geometry: spawn (25,25), controller (25,10),
// source (25,40). The source's harvest spot (= container placement tile and
// the drop-pile tile) is bestAdjacentTile(source, spawn) = (24,39); the core
// depot tile is bestAdjacentTile(spawn, spawn) = (24,24). Piles are injected
// via the stage() raw-db hook (probe-verified: they persist and decay
// ceil(amount/1000)=1 per tick).
// ---------------------------------------------------------------------------
const rungRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(25, 40).toRoom();

const HARVEST_SPOT = { x: 24, y: 39 };
const DEPOT_TILE = { x: 24, y: 24 };

const quiet = (): Array<{ name: string; x: number; y: number; body: string[]; memory?: any }> => [
  { name: "decoy", x: 20, y: 20, body: ["carry", "move"], memory: { workType: "haul" } },
  { name: "filler1", x: 19, y: 20, body: ["move"] },
  { name: "filler2", x: 19, y: 21, body: ["move"] },
];

const containerSiteAt = (s: { objects(h?: string): any[] }, pos: { x: number; y: number }) =>
  s
    .objects()
    .some((o: any) => o.type === "constructionSite" && o.structureType === "container" && o.x === pos.x && o.y === pos.y);

export function buildConstructionT1Cells(): GridCell[] {
  let srcContainerSeen = false;

  return [
    {
      // Rung 1 outranks everything: a >= 200 pile at the source is the demand
      // signal, and the container lands ON the miner's harvest tile - the
      // pile/container/pickup convergence.
      id: "cons-src-container-on-pile",
      tier: 1,
      avenue: "construction",
      window: 60,
      rooms: { home: rungRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      creeps: quiet(),
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "energy",
          room: ctx.room(),
          x: HARVEST_SPOT.x,
          y: HARVEST_SPOT.y,
          energy: 400,
          resourceType: "energy",
        });
      },
      assertions: [
        eventually("container site lands exactly on the harvest tile", (s) => {
          if (containerSiteAt(s, HARVEST_SPOT)) srcContainerSeen = true;
          return srcContainerSeen;
        }),
        always("no other site is placed before the source container", (s) => {
          if (srcContainerSeen) return true;
          return sites(s).every(
            (o: any) => o.structureType === "container" && o.x === HARVEST_SPOT.x && o.y === HARVEST_SPOT.y
          );
        }),
      ],
    },

    {
      // The same room with a sub-threshold pile (150, decaying): rung 1 must
      // NOT fire; the core depot beside the spawn is the correct first site.
      id: "cons-depot-when-pile-thin",
      tier: 1,
      avenue: "construction",
      window: 60,
      rooms: { home: rungRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      creeps: quiet(),
      async stage(ctx) {
        await ctx.db["rooms.objects"].insert({
          type: "energy",
          room: ctx.room(),
          x: HARVEST_SPOT.x,
          y: HARVEST_SPOT.y,
          energy: 150,
          resourceType: "energy",
        });
      },
      assertions: [
        eventually("depot container site lands beside the spawn", (s) => containerSiteAt(s, DEPOT_TILE)),
        always("no container site ever appears at the source", (s) =>
          !s
            .objects()
            .some(
              (o: any) =>
                o.type === "constructionSite" &&
                o.structureType === "container" &&
                Math.max(Math.abs(o.x - 25), Math.abs(o.y - 40)) <= 1
            )
        ),
      ],
    },
  ];
}

export const constructionCells: GridCell[] = [
  {
    id: "cons-ext-first-site-checkerboard",
    tier: 0,
    avenue: "construction",
    window: 100,
    rooms: { home: homeRoom },
    bot: { x: SPAWN.x, y: SPAWN.y },
    controller: { level: 2 },
    assertions: [
      eventually("an extension construction site is placed", (s) =>
        sites(s).some((o: any) => o.structureType === "extension")
      ),
      always("only extensions are ever placed at RCL2", (s) =>
        sites(s).every((o: any) => o.structureType === "extension")
      ),
      always("every placed site obeys the grid rules", (s) => sites(s).every(obeysGridRules)),
      always("never more than one site at a time", (s) => sites(s).length <= 1),
    ],
  },
];
