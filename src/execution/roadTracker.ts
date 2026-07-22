/**
 * roadTracker - the live sweep that feeds economy/roadScoring.
 *
 * Every tick it looks at each of our creeps, and when a creep MOVED ONTO an
 * unpaved plain/swamp tile while carrying fatigue-generating parts, it credits
 * that tile the fatigue a road there would have saved (economy/roadScoring's
 * stepScore). The scores accumulate in `RoomMemory.roadScores` and decay on a
 * cadence, so the map tracks the colony's RECENT traffic rather than its whole
 * history.
 *
 * WHY "moved onto". Fatigue is charged for the tile a creep steps INTO, so the
 * creep's CURRENT tile is the one whose terrain cost it move-fatigue this tick -
 * that is the tile a road would have helped. A creep that held its position paid
 * no move-fatigue, so it scores nothing.
 *
 * WHY a heap map for last positions. We detect "moved" by comparing this tick's
 * tile to last tick's. Storing that in creep Memory would serialize a field for
 * every creep every tick; instead we keep it in a module-level (heap) Map that
 * survives between ticks and is simply empty after a global reset - costing at
 * most one missed step per reset, never a Memory write. Dead creeps are pruned
 * from it lazily.
 *
 * This is a DURABLE statistical accumulator, not a position-keyed trigger - the
 * playbook's trap (a signal that flaps on a creep death or lost vision) does not
 * apply: no single step changes a decision, and the score survives the creep
 * that produced it.
 */

import "../types/Memory"; // RoomMemory.roadScores augmentation
import {
  RoadScoreMap,
  countFatigueParts,
  decayScores,
  packTile,
  recordStep,
  stepScore,
  topScoredTiles,
  unpackTile
} from "../economy/roadScoring";

/** Last tile each creep occupied, packed as "roomName:packedIndex". Heap-only. */
const lastTile = new Map<string, string>();

/** Multiply scores by this each decay pass - a lane unused for one interval halves. */
export const ROAD_SCORE_DECAY_FACTOR = 0.5;
/** Ticks between decay passes. */
export const ROAD_SCORE_DECAY_INTERVAL = 3000;
/** Cap on stored tiles per room after a decay pass (keeps Memory bounded). */
export const ROAD_SCORE_MAX_TILES = 200;

/** Does an unpaved-tile check need to fire? True unless the tile already has a road (built or under construction). */
function tileIsPaved(room: Room, x: number, y: number): boolean {
  for (const s of room.lookForAt(LOOK_STRUCTURES, x, y)) {
    if (s.structureType === STRUCTURE_ROAD) return true;
  }
  for (const s of room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y)) {
    if (s.structureType === STRUCTURE_ROAD) return true;
  }
  return false;
}

/** Credit the tile a creep just moved onto, if a road there would have helped. */
function scoreCreepStep(creep: Creep): void {
  const room = creep.room;
  if (!room) return;
  const { x, y } = creep.pos;
  // Border/exit tiles are never paved and carry cross-room traffic we can't act
  // on with a single road tile - skip them.
  if (x <= 0 || x >= 49 || y <= 0 || y >= 49) return;

  const fatigueParts = countFatigueParts(creep.body, creep.store.getUsedCapacity() ?? 0);
  if (fatigueParts <= 0) return;

  const terrain = room.getTerrain().get(x, y);
  const inc = stepScore(terrain, fatigueParts);
  if (inc <= 0) return;

  if (tileIsPaved(room, x, y)) return;

  const mem = room.memory as RoomMemory;
  const store = (mem.roadScores = mem.roadScores ?? { scores: {}, updated: Game.time });
  recordStep(store.scores as RoadScoreMap, x, y, inc);
  store.updated = Game.time;
}

/**
 * One tick of road-usage tracking. Sweeps our creeps, credits each moved-onto
 * unpaved tile, and runs a decay pass on the decay cadence. Cheap: one terrain
 * read + at most two lookFor per MOVED creep, nothing for stationary ones.
 */
export function trackRoadUsage(time: number = Game.time): void {
  const seen = new Set<string>();
  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    seen.add(name);
    if (!creep.my) continue;

    const key = `${creep.pos.roomName}:${packTile(creep.pos.x, creep.pos.y)}`;
    const prev = lastTile.get(name);
    lastTile.set(name, key);
    // First sighting (or a stationary tick) is not a scorable step.
    if (prev === undefined || prev === key) continue;

    scoreCreepStep(creep);
  }

  // Prune heap entries for creeps that died (bounded work; the set is small).
  if (lastTile.size > seen.size) {
    for (const name of lastTile.keys()) {
      if (!seen.has(name)) lastTile.delete(name);
    }
  }

  if (time % ROAD_SCORE_DECAY_INTERVAL === 0) decayAllRooms();
}

/** Decay every room's score map and trim it to the top ROAD_SCORE_MAX_TILES. */
function decayAllRooms(): void {
  const rooms = Memory.rooms;
  if (!rooms) return;
  for (const roomName in rooms) {
    const store = rooms[roomName].roadScores;
    if (!store) continue;
    decayScores(store.scores as RoadScoreMap, ROAD_SCORE_DECAY_FACTOR);
    trimToTop(store.scores as RoadScoreMap, ROAD_SCORE_MAX_TILES);
  }
}

/** Keep only the highest-scoring `max` tiles of a map (mutates). */
function trimToTop(map: RoadScoreMap, max: number): void {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  const survivors = new Set(topScoredTiles(map, { limit: max }).map(t => packTile(t.x, t.y)));
  for (const key of keys) {
    if (!survivors.has(Number(key))) delete map[Number(key)];
  }
}

/**
 * Ranked road candidates from a room's accumulated scores: the highest-scoring
 * unpaved tiles, most-worth-paving first. The bridge from measurement to
 * placement - a builder can walk this list and pave (subject to its own
 * economics/cooldown gates). Returns [] when the room has no scores yet.
 */
export function roadCandidateTiles(
  roomName: string,
  opts: { min?: number; limit?: number } = {}
): { x: number; y: number; score: number }[] {
  const store = Memory.rooms?.[roomName]?.roadScores;
  if (!store) return [];
  return topScoredTiles(store.scores as RoadScoreMap, opts);
}

/**
 * Console readout (global.roadHeatmap): logs the top tiles and, when the room is
 * visible, paints a RoomVisual heat circle on each (radius/opacity by score).
 */
export function renderRoadScores(roomName: string, top = 20): string {
  const tiles = roadCandidateTiles(roomName, { limit: top });
  if (tiles.length === 0) return `[roadScores] ${roomName}: no data`;
  const max = tiles[0].score;
  const room = Game.rooms[roomName];
  const vis = room?.visual;
  const lines = [`[roadScores] ${roomName}: top ${tiles.length} of ${Object.keys(Memory.rooms?.[roomName]?.roadScores?.scores ?? {}).length}`];
  for (const t of tiles) {
    lines.push(`  (${t.x},${t.y}) ${Math.round(t.score)}`);
    if (vis) {
      const heat = t.score / max;
      vis.circle(t.x, t.y, {
        radius: 0.15 + 0.35 * heat,
        fill: "#ffaa00",
        opacity: 0.2 + 0.6 * heat
      });
    }
  }
  return lines.join("\n");
}

/** Test-only: clear the heap-cached last-position map between cases. */
export function _resetRoadTracker(): void {
  lastTile.clear();
}

/** Re-export for callers that want the packed helpers alongside the tracker. */
export { packTile, unpackTile };
