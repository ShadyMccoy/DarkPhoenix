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
