/**
 * plan.ts — the pure planner: `World in, Plan out`, no game globals, no
 * Memory, no side effects. The Plan is LITERAL — jobs with targets and body
 * shapes, nothing the executors must re-derive or second-guess (REBOOT.md:
 * "executors take orders"). Every economic decision lives here; if an
 * executor seems to need one, the planner is missing a field.
 *
 * v2 vocabulary so far: one job kind, `work` — the generalist workman that
 * mines its source and delivers on the sink ladder's top rungs (spawn
 * refill, then controller). M2 splits mining from hauling; the *shape* of
 * the plan (jobs + expected rate) is the part meant to last.
 */
import {
  SOURCE_RATE,
  WorkmanShape,
  bodyCost,
  workmanBody,
  workmanCycleRate,
  workmenPerSource
} from "./primitives";
import { World, WorldRoom } from "./world";

export interface Job {
  /** Deterministic id — `work:{sourceId}` — stable across replans so creeps
   * keep their assignment when nothing real changed. */
  id: string;
  kind: "work";
  room: string;
  sourceId: string;
  /** Bodies wanted on this job, spawn pipe included in the census. */
  target: number;
  body: WorkmanShape;
  /** Higher first. The sink ladder is inside the runner's delivery order;
   * priority here only sequences spawn purchases between jobs. */
  priority: number;
  /** The cycle model's delivered e/t for this job at full staffing —
   * the F1 line's plan side, capped by the source. */
  expectedRate: number;
}

export interface Plan {
  tick: number;
  jobs: Job[];
  /** Sum of job expectedRate — what the planner claims the colony mines. */
  expectedMined: number;
}

/**
 * Ramp cap: at most this many workmen per source, whatever the saturation
 * math wants. Measured in the M1 mockup (diag 2026-08-18): an open room
 * offers 8 spots/source and duty-corrected saturation wants 12 one-WORK
 * bodies — a 4,000e fleet the colony funds by starving every other sink
 * for 1,000+ ticks. Production-first is doctrine, but a ramp that long
 * defers the ENTIRE residual past the milestone. Three units/source keeps
 * the ramp under ~450t at 300 capacity; M2's static-miner split retires
 * this cap along with the workman itself.
 */
const RAMP_CAP = 3;

/**
 * Body budget for a room. Normal law: size to `energyCapacityAvailable` —
 * bodies scale with the room. Survival law (v1 spec-01, the runt lesson): a
 * room with NO live workman must buy what it can afford RIGHT NOW, not
 * queue an ideal body it can never fill toward.
 */
function roomBudget(room: WorldRoom, world: World): number {
  const alive = world.creeps.some(c => c.room === room.name && c.job !== null && !c.spawning);
  return alive ? room.energyCapacityAvailable : room.energyAvailable;
}

export function buildPlan(world: World): Plan {
  const jobs: Job[] = [];

  for (const room of world.rooms) {
    if (room.spawns.length === 0) continue;
    const body = workmanBody(roomBudget(room, world));
    if (!body) continue; // below the survival floor: nothing to order yet

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
        // Nearer sources first: cheaper cycles pay back sooner.
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

/** Census over the snapshot: bodies per job id, spawn pipe included. The ONE
 * subtraction the spawn side uses — there is no second demand lens. */
export function jobCensus(world: World): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of world.creeps) {
    if (!c.job) continue;
    counts.set(c.job, (counts.get(c.job) ?? 0) + 1);
  }
  return counts;
}

/** True when the cached plan no longer matches the world it priced: room
 * set changed, a survival-regime flip, or the cadence expired. */
export function planStale(plan: Plan, world: World, interval: number): boolean {
  if (world.tick - plan.tick >= interval) return true;
  const knownRooms = new Set(plan.jobs.map(j => j.room));
  for (const room of world.rooms) {
    if (room.spawns.length > 0 && !knownRooms.has(room.name) && room.sources.length > 0) return true;
  }
  // Survival flip: a job's body has become unaffordable with nobody alive to
  // refill toward it — replan so the survival law resizes the order.
  for (const job of plan.jobs) {
    const room = world.rooms.find(r => r.name === job.room);
    if (!room) return true;
    const alive = world.creeps.some(c => c.room === room.name && c.job !== null && !c.spawning);
    if (!alive && bodyCost(job.body) > room.energyAvailable) return true;
  }
  return false;
}
