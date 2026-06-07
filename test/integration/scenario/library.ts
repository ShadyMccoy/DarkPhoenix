/**
 * library - named, reusable scenarios for economy iteration.
 *
 * Each factory returns a {@link Scenario} built from {@link RoomBuilder}, so the
 * layout reads as the thing it is. Keep these minimal and composable; capture
 * richer mid-game states with exportSnapshot instead of hand-building them.
 */

import { RoomBuilder } from "./RoomBuilder";
import { Scenario } from "./Scenario";

const SPAWN = { x: 25, y: 25 };

/**
 * A single open room with one source at the given depth, a central spawn and a
 * controller near the top. `sourceY` controls how far the source is from the
 * spawn - the classic near/far mining comparison.
 */
export function singleSource(opts: { room?: string; sourceY?: number } = {}): Scenario {
  const room = opts.room ?? "W0N0";
  const sourceY = opts.sourceY ?? 30;
  const builder = new RoomBuilder(room)
    .border()
    .controller(25, 10)
    .source(25, sourceY);
  return {
    name: `single-source-y${sourceY}`,
    description: `Open room, one source at y=${sourceY}, spawn at centre.`,
    rooms: [builder.toRoom()],
    bot: { room, ...SPAWN },
  };
}

/**
 * The "three useless nodes" room: three chambers split by walls and joined by a
 * 2-tile corridor, with the source, spawn and controller each isolated in their
 * own chamber. Only viable if energy is hauled across node boundaries.
 */
export function threeChamber(opts: { room?: string } = {}): Scenario {
  const room = opts.room ?? "W0N0";
  const builder = new RoomBuilder(room)
    .border()
    .vWall(16, { gap: [24, 25] })
    .vWall(17, { gap: [24, 25] })
    .vWall(32, { gap: [24, 25] })
    .vWall(33, { gap: [24, 25] })
    .source(8, 25) // west chamber
    .controller(41, 25); // east chamber
  return {
    name: "three-chamber",
    description: "Source | spawn | controller, each isolated in its own chamber.",
    rooms: [builder.toRoom()],
    bot: { room, ...SPAWN }, // spawn lands in the centre chamber
  };
}
