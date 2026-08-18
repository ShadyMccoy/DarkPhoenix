/**
 * execute.ts — order-takers. Runners decide ACTIONS from the snapshot and
 * the plan; nothing here makes an economic decision (that's plan.ts) and
 * nothing here derives world facts (that's world.ts). Game handles are
 * resolved only at the action edge — to move, harvest, transfer, spawn —
 * and creep memory is written only at the two sanctioned points: job
 * assignment and the workman's one hysteresis bit.
 */
import { bodyCost, bodyList } from "./primitives";
import { Job, Plan, jobCensus } from "./plan";
import { World, WorldCreep, WorldRoom } from "./world";
import { recordSpawnSpend } from "./ledger";

function range(ax: number, ay: number, bx: number, by: number): number {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/**
 * Give every unassigned (or orphaned by a replan) creep a job: most
 * understaffed first. Runs on the same census the spawn side uses — one
 * demand lens, by law.
 */
export function assignJobs(world: World, plan: Plan): void {
  const jobsById = new Map(plan.jobs.map(j => [j.id, j]));
  const census = jobCensus(world);

  for (const c of world.creeps) {
    if (c.job && jobsById.has(c.job)) continue;
    let best: Job | null = null;
    let bestGap = -Infinity;
    for (const job of plan.jobs) {
      const gap = job.target - (census.get(job.id) ?? 0);
      if (gap > bestGap || (gap === bestGap && best && job.priority > best.priority)) {
        best = job;
        bestGap = gap;
      }
    }
    if (!best) continue;
    const live = Game.creeps[c.name];
    if (!live) continue;
    live.memory.job = best.id;
    c.job = best.id;
    census.set(best.id, (census.get(best.id) ?? 0) + 1);
  }
}

/**
 * The workman: harvest until full, deliver until empty. Delivery follows
 * the sink ladder's top rungs — spawn/extension refill is the heartbeat
 * and ALWAYS outranks the controller; the controller burns the residual.
 */
function runWorkman(c: WorldCreep, job: Job, room: WorldRoom): void {
  const creep = Game.creeps[c.name];
  if (!creep || c.spawning) return;

  if (creep.memory.d && c.energy === 0) creep.memory.d = false;
  if (!creep.memory.d && c.free === 0) creep.memory.d = true;

  if (!creep.memory.d) {
    const source = Game.getObjectById(job.sourceId as Id<Source>);
    if (!source) return;
    if (range(c.x, c.y, source.pos.x, source.pos.y) > 1) {
      creep.moveTo(source, { reusePath: 10 });
    } else {
      creep.harvest(source);
    }
    return;
  }

  let target = null as { id: string; x: number; y: number } | null;
  let bestDist = Infinity;
  for (const refill of room.refills) {
    const d = range(c.x, c.y, refill.x, refill.y);
    if (d < bestDist) {
      target = refill;
      bestDist = d;
    }
  }

  if (target) {
    const struct = Game.getObjectById(target.id as Id<StructureSpawn | StructureExtension>);
    if (!struct) return;
    if (bestDist > 1) {
      creep.moveTo(struct, { reusePath: 10 });
    } else {
      creep.transfer(struct, RESOURCE_ENERGY);
    }
    return;
  }

  if (!room.controllerId) return;
  const controller = Game.getObjectById(room.controllerId as Id<StructureController>);
  if (!controller) return;
  if (range(c.x, c.y, room.controllerX, room.controllerY) > 3) {
    creep.moveTo(controller, { reusePath: 10 });
  } else {
    creep.upgradeController(controller);
  }
}

export function runCreeps(world: World, plan: Plan): void {
  const jobsById = new Map(plan.jobs.map(j => [j.id, j]));
  const roomsByName = new Map(world.rooms.map(r => [r.name, r]));
  for (const c of world.creeps) {
    if (!c.job) continue;
    const job = jobsById.get(c.job);
    if (!job) continue;
    const room = roomsByName.get(job.room) ?? roomsByName.get(c.room);
    if (!room) continue;
    runWorkman(c, job, room);
  }
}

/**
 * The spawn side of the ONE subtraction: demand = target − census (spawn
 * pipe included, because World.creeps includes spawning bodies and this
 * tick's purchases are added to the census as they are made). Purchases go
 * most-understaffed-first, priority as tiebreak.
 */
export function runSpawns(world: World, plan: Plan): void {
  const census = jobCensus(world);

  for (const room of world.rooms) {
    let energyLeft = room.energyAvailable;
    for (const spawn of room.spawns) {
      if (spawn.spawningJob !== null) continue;
      const handle = Game.spawns[spawn.name];
      if (!handle || handle.spawning) continue;

      let best: Job | null = null;
      let bestGap = 0;
      for (const job of plan.jobs) {
        if (job.room !== room.name) continue;
        const gap = job.target - (census.get(job.id) ?? 0);
        if (gap > bestGap || (gap === bestGap && gap > 0 && best && job.priority > best.priority)) {
          best = job;
          bestGap = gap;
        }
      }
      if (!best || bestGap <= 0) continue;

      const cost = bodyCost(best.body);
      if (cost > energyLeft) continue;

      const name = `w${world.tick}-${spawn.name}`;
      const result = handle.spawnCreep(bodyList(best.body) as BodyPartConstant[], name, {
        memory: { job: best.id }
      });
      if (result === OK) {
        census.set(best.id, (census.get(best.id) ?? 0) + 1);
        energyLeft -= cost;
        recordSpawnSpend(cost);
      }
    }
  }
}
