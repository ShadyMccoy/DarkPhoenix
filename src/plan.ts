import { SOURCE_RATE, WorkmanShape, bodyCost, workmanCycleRate, workmenPerSource } from "./primitives";
import { workmanBody } from "./sizing";
import { World, WorldRoom } from "./world";

export interface Job {
  id: string;
  kind: "work";
  room: string;
  sourceId: string;
  target: number;
  body: WorkmanShape;
  priority: number;
  expectedRate: number;
}

export interface Plan {
  tick: number;
  jobs: Job[];
  expectedMined: number;
}

const RAMP_CAP = 3;

function roomBudget(room: WorldRoom, world: World): number {
  const alive = world.creeps.some(c => c.room === room.name && c.job !== null && !c.spawning);
  return alive ? room.energyCapacityAvailable : room.energyAvailable;
}

export function buildPlan(world: World): Plan {
  const jobs: Job[] = [];

  for (const room of world.rooms) {
    if (room.spawns.length === 0) continue;
    const body = workmanBody(roomBudget(room, world));
    if (!body) continue;

    for (const source of room.sources) {
      const target = Math.min(RAMP_CAP, workmenPerSource(body, source.distToSpawn, source.spots));
      const perBody = workmanCycleRate(body, source.distToSpawn);
      jobs.push({
        id: `work:${source.id}`,
        kind: "work",
        room: room.name,
        sourceId: source.id,
        target,
        body,
        priority: 100 - source.distToSpawn,
        expectedRate: Math.min(target * perBody, SOURCE_RATE)
      });
    }
  }

  return {
    tick: world.tick,
    jobs,
    expectedMined: jobs.reduce((sum, j) => sum + j.expectedRate, 0)
  };
}

export function jobCensus(world: World): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of world.creeps) {
    if (!c.job) continue;
    counts.set(c.job, (counts.get(c.job) ?? 0) + 1);
  }
  return counts;
}

export function planStale(plan: Plan, world: World, interval: number): boolean {
  if (world.tick - plan.tick >= interval) return true;
  const knownRooms = new Set(plan.jobs.map(j => j.room));
  for (const room of world.rooms) {
    if (room.spawns.length > 0 && !knownRooms.has(room.name) && room.sources.length > 0) return true;
  }
  for (const job of plan.jobs) {
    const room = world.rooms.find(r => r.name === job.room);
    if (!room) return true;
    const alive = world.creeps.some(c => c.room === room.name && c.job !== null && !c.spawning);
    if (!alive && bodyCost(job.body) > room.energyAvailable) return true;
  }
  return false;
}
