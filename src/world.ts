/**
 * world.ts — THE snapshot. The only module in v2 that reads `Game.*`.
 *
 * Everything the planner and the executors know about the game arrives
 * through the `World` value built here once per tick. There is deliberately
 * no second lens: if a fact isn't in `World`, the consumer that wants it
 * adds it HERE, and every other consumer sees the same derivation (v1's
 * two-lens drift died of exactly this — REBOOT.md disease #1).
 *
 * The spawn pipe is a first-class fact: `Game.creeps` includes spawning
 * creeps, and each carries its job assignment from birth, so any census
 * over `World.creeps` counts in-flight bodies by construction (v1's last
 * live bug class, t72811290).
 */
import { SOURCE_RATE } from "./primitives";

export interface WorldSource {
  id: string;
  x: number;
  y: number;
  energy: number;
  /** Walkable tiles adjacent to the source (terrain-only, cached per global). */
  spots: number;
  /** Chebyshev range to the room's first spawn — the planner's distance
   * estimate until real paths earn their place (the F1 line measures the gap). */
  distToSpawn: number;
}

export interface WorldSpawn {
  id: string;
  name: string;
  x: number;
  y: number;
  energy: number;
  energyCapacity: number;
  /** Job id of the body being built, or null when idle. */
  spawningJob: string | null;
}

export interface RefillTarget {
  id: string;
  x: number;
  y: number;
  free: number;
}

export interface WorldRoom {
  name: string;
  rcl: number;
  rclProgress: number;
  rclProgressTotal: number;
  energyAvailable: number;
  energyCapacityAvailable: number;
  controllerId: string | null;
  controllerX: number;
  controllerY: number;
  spawns: WorldSpawn[];
  sources: WorldSource[];
  /** Spawns + extensions with free energy capacity — the heartbeat's targets. */
  refills: RefillTarget[];
  /** Ceiling on what this room's sources can yield. */
  sourceRateCap: number;
}

export interface WorldCreep {
  name: string;
  room: string;
  x: number;
  y: number;
  job: string | null;
  work: number;
  energy: number;
  free: number;
  spawning: boolean;
  ttl: number;
}

export interface World {
  tick: number;
  rooms: WorldRoom[];
  creeps: WorldCreep[];
}

/** Terrain-derived standing room per source: immutable, so cached per global. */
const spotsCache = new Map<string, number>();

function sourceSpots(source: Source): number {
  const cached = spotsCache.get(source.id);
  if (cached !== undefined) return cached;
  const terrain = Game.map.getRoomTerrain(source.room.name);
  let n = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = source.pos.x + dx;
      const y = source.pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) n++;
    }
  }
  spotsCache.set(source.id, n);
  return n;
}

export function snapshot(): World {
  const rooms: WorldRoom[] = [];
  for (const name of Object.keys(Game.rooms)) {
    const room = Game.rooms[name];
    const controller = room.controller;
    if (!controller || !controller.my) continue;

    const spawns = room.find(FIND_MY_SPAWNS).map(s => ({
      id: s.id as string,
      name: s.name,
      x: s.pos.x,
      y: s.pos.y,
      energy: s.store[RESOURCE_ENERGY],
      energyCapacity: s.store.getCapacity(RESOURCE_ENERGY),
      spawningJob: s.spawning ? Memory.creeps?.[s.spawning.name]?.job ?? null : null
    }));

    const anchor = spawns[0];
    const sources = room.find(FIND_SOURCES).map(src => ({
      id: src.id as string,
      x: src.pos.x,
      y: src.pos.y,
      energy: src.energy,
      spots: sourceSpots(src),
      distToSpawn: anchor
        ? Math.max(Math.abs(src.pos.x - anchor.x), Math.abs(src.pos.y - anchor.y))
        : 25
    }));

    const refills: RefillTarget[] = [];
    for (const s of room.find(FIND_MY_STRUCTURES)) {
      if (s.structureType !== STRUCTURE_SPAWN && s.structureType !== STRUCTURE_EXTENSION) continue;
      const store = (s as StructureSpawn | StructureExtension).store;
      const free = store.getFreeCapacity(RESOURCE_ENERGY);
      if (free > 0) refills.push({ id: s.id as string, x: s.pos.x, y: s.pos.y, free });
    }

    rooms.push({
      name,
      rcl: controller.level,
      rclProgress: controller.progress,
      rclProgressTotal: controller.progressTotal,
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable,
      controllerId: controller.id as string,
      controllerX: controller.pos.x,
      controllerY: controller.pos.y,
      spawns,
      sources,
      refills,
      sourceRateCap: sources.length * SOURCE_RATE
    });
  }

  const creeps: WorldCreep[] = [];
  for (const name of Object.keys(Game.creeps)) {
    const c = Game.creeps[name];
    creeps.push({
      name,
      room: c.room.name,
      x: c.pos.x,
      y: c.pos.y,
      job: c.memory.job ?? null,
      work: c.getActiveBodyparts(WORK),
      energy: c.store[RESOURCE_ENERGY],
      free: c.store.getFreeCapacity(RESOURCE_ENERGY),
      spawning: c.spawning,
      ttl: c.ticksToLive ?? 0
    });
  }

  return { tick: Game.time, rooms, creeps };
}
