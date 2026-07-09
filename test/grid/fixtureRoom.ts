/**
 * fixtureRoom - captured REAL game-world rooms as grid cell rooms.
 *
 * Fixtures come from `npm run capture:rooms` (test/fixtures/real-rooms/):
 * ASCII terrain + scenery objects, loadLayout-compatible. This helper adapts
 * one to the GridCell.rooms contract (a `(roomName) => ScenarioRoom` factory,
 * name remapped by the packer).
 *
 * SEALING (the isolation rule, spec 08): grid worlds pad neighbours with
 * all-plain terrain, and real rooms have OPEN borders - an escaping scout
 * walks pad-to-pad until it touches a terrain-less room and wedges the engine
 * processor ("Cannot read properties of undefined (reading 'terrain')",
 * measured in sim-real-rooms before it switched to wall pads). So by default
 * the fixture's border rows/cols are overwritten with wall. Pass
 * `sealed: false` only when the cell provides real sealed neighbour rooms
 * with aligned gaps (the T5 multi-room pattern).
 */
import { readFileSync } from "fs";
import * as path from "path";
import { ScenarioObject, ScenarioRoom } from "../integration/scenario/RoomBuilder";

const FIXTURE_DIR = path.resolve("test", "fixtures", "real-rooms");

export interface RealRoomFixture {
  room: string;
  shard: string;
  terrain: string[];
  objects: ScenarioObject[];
}

/** Load a fixture by file stem, e.g. "shard3-W1N6". Throws if absent. */
export function loadFixture(name: string): RealRoomFixture {
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  return JSON.parse(readFileSync(file).toString()) as RealRoomFixture;
}

/** Overwrite the border ring with wall so nothing can leave the room. */
function sealBorders(terrain: string[]): string[] {
  const wallRow = "#".repeat(50);
  return terrain.map((row, y) => (y === 0 || y === 49 ? wallRow : `#${row.slice(1, 49)}#`));
}

/**
 * A GridCell.rooms factory for a captured real room.
 * Usage: `rooms: { home: fixtureRoom("shard3-W1N6") }`.
 */
export function fixtureRoom(name: string, opts: { sealed?: boolean } = {}): (roomName: string) => ScenarioRoom {
  const fx = loadFixture(name);
  const terrain = opts.sealed === false ? fx.terrain : sealBorders(fx.terrain);
  return (roomName: string) => ({ room: roomName, terrain, objects: fx.objects });
}
