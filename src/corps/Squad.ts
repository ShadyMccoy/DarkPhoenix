/**
 * @fileoverview Squad - a group of one-or-more creeps doing one job for a corp.
 *
 * Operations should think in squads, not individual creeps. A squad owns its
 * members, knows how many it wants (the target size), produces the spawn demand
 * needed to reach that size, runs per-member behavior, and recycles undersized
 * runts once the room is maxed. The exact creep count is the squad's concern -
 * an operation says "I want this much work done, here is the body" and the squad
 * decides whether that means one big creep or three small ones.
 *
 * Membership is keyed on (corpId, workType): the same pair the spawn executor
 * stamps onto a creep's memory when it is born, so a squad re-discovers its
 * members for free after a global reset - no roster to persist.
 *
 * The class is deliberately thin and stateless: every method reads live game
 * state, so there is nothing to serialize and nothing to drift out of sync.
 *
 * @module corps/Squad
 */

import { SpawnDemand } from "../spawn/SpawnScheduler";
import { SpawnRole } from "../spawn/SpawnScheduler";
import { pickRuntToRecycle, spawnIdleAndMaxed, driveRecycle } from "./recycle";

/**
 * Static identity and spawn shape of a squad. Fixed for the squad's lifetime.
 */
export interface SquadConfig {
  /** Corp that owns the squad's creeps (matched against creep.memory.corpId). */
  corpId: string;
  /** Job key, matched against creep.memory.workType (e.g. "build", "tank"). */
  workType: string;
  /** Spawn role; tells the executor which body builder to use. */
  role: SpawnRole;
  /** Base marginal value of adding a member, for the scheduler's priority sort. */
  value: number;
  /** True if a member increases energy delivery (miner/hauler-like work). */
  producesIncome: boolean;
  /** True if the colony's economy stalls while this squad has zero members. */
  blockingWhenEmpty: boolean;
  /**
   * The body part that defines a member's usefulness - WORK for builders/miners,
   * CARRY for haulers/tankers. Used to recognise an undersized runt to recycle.
   */
  usefulPart: BodyPartConstant;
}

/**
 * What the squad should look like this tick, computed by the owning corp from
 * live state (energy available, work backlog, etc.). The squad does not decide
 * these numbers - it decides what to do about them.
 */
export interface SquadPlan {
  /** How many members we want. The squad spawns toward this, one creep at a time. */
  target: number;
  /** Ideal body cost for a member given current demand. */
  desiredCost: number;
  /** Smallest body cost still worth spawning ("small now, scale later"). */
  minCost: number;
  /** Opaque body-size hint passed through to the executor (e.g. desired WORK). */
  bodyParam: number;
  /**
   * Total useful parts (of usefulPart) the squad should field across all members,
   * and the most a single member can have. Together these let a maxed room retire
   * a sub-max runt so its replacement spawns full size. Omit to disable recycling.
   */
  partsNeeded?: number;
  maxPartsPerMember?: number;
}

/**
 * A Squad abstracts "how many creeps" away from an operation. See file header.
 */
export class Squad {
  constructor(private readonly config: SquadConfig) {}

  /**
   * Live, ready-to-work members (born and not mid-spawn). This is what `run`
   * iterates; spawning creeps cannot act yet so they are excluded here.
   */
  members(): Creep[] {
    const out: Creep[] = [];
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.corpId === this.config.corpId &&
        creep.memory.workType === this.config.workType &&
        !creep.spawning
      ) {
        out.push(creep);
      }
    }
    return out;
  }

  /**
   * Member count INCLUDING creeps still spawning. Spawn-demand gating uses this
   * so a creep already in the spawn queue is not double-ordered.
   */
  count(): number {
    let n = 0;
    for (const name in Game.creeps) {
      const creep = Game.creeps[name];
      if (
        creep.memory.corpId === this.config.corpId &&
        creep.memory.workType === this.config.workType
      ) {
        n++;
      }
    }
    return n;
  }

  /**
   * Run per-member behavior. A member flagged for recycling walks itself to the
   * spawn instead; everyone else runs `active`. The caller supplies the spawn so
   * recycling members have somewhere to go.
   */
  run(active: (creep: Creep) => void, spawn: StructureSpawn): void {
    for (const creep of this.members()) {
      if (creep.memory.recycling) {
        driveRecycle(creep, spawn);
      } else {
        active(creep);
      }
    }
  }

  /**
   * Declare spawn demand to grow the squad toward `plan.target`. Emits at most one
   * request: the scheduler fills the squad incrementally, one creep per spawn, and
   * the demand reappears next tick until the target is met. Returns nothing when
   * the squad is already at target or the room cannot afford even the floor body.
   */
  spawnDemand(plan: SquadPlan): SpawnDemand[] {
    if (plan.target <= 0) return [];
    const current = this.count();
    if (current >= plan.target) return [];
    if (plan.minCost <= 0) return [];

    return [
      {
        buyerCorpId: this.config.corpId,
        role: this.config.role,
        value: this.config.value,
        blocking: this.config.blockingWhenEmpty && current === 0,
        producesIncome: this.config.producesIncome,
        desiredCost: plan.desiredCost,
        minCost: plan.minCost,
        since: 0,
        bodyParam: plan.bodyParam,
      },
    ];
  }

  /**
   * Flag one undersized member for recycling when - and only when - the room is
   * maxed out and the spawn would otherwise idle (so the energy and the spawn tick
   * are free). The retired creep's corp then respawns it at the size the room can
   * now build. At most one member recycles at a time; in a constrained room the
   * gate never opens, so a working creep is never disrupted to chase a body we
   * cannot afford. A no-op unless the plan supplies recycling bounds.
   */
  flagRuntForRecycling(room: Room, spawn: StructureSpawn, plan: SquadPlan): void {
    if (plan.partsNeeded === undefined || plan.maxPartsPerMember === undefined) return;
    if (!spawnIdleAndMaxed(room, spawn)) return;

    const members = this.members();
    if (members.some((c) => c.memory.recycling)) return; // one at a time

    const idx = pickRuntToRecycle(
      members.map((c) => c.getActiveBodyparts(this.config.usefulPart)),
      plan.partsNeeded,
      plan.maxPartsPerMember
    );
    if (idx !== null) members[idx].memory.recycling = true;
  }
}

/**
 * Split a fixed total of useful body parts into the FEWEST creeps that can field
 * it (pure, so it is unit-testable in isolation). The ideal is one creep holding
 * the whole total; we are forced to split into smaller ones only when a single
 * creep cannot be built that big - `maxPartsPerMember` is the largest body the
 * room's current extension capacity affords. Either way the squad fields the same
 * total parts. Capped at `maxMembers`; beyond that the squad is simply
 * capacity-limited and fields less than the ideal total.
 *
 * @returns the member count and the parts each member should carry (near-equal).
 */
export function splitIntoMembers(
  totalParts: number,
  maxPartsPerMember: number,
  maxMembers: number
): { count: number; partsPerMember: number } {
  if (totalParts <= 0 || maxMembers <= 0) return { count: 0, partsPerMember: 0 };
  // Unknown cap (room cannot build even one part): ask for a single creep and let
  // the body builder shrink it to whatever fits.
  if (maxPartsPerMember <= 0) return { count: 1, partsPerMember: totalParts };

  const count = Math.max(1, Math.min(maxMembers, Math.ceil(totalParts / maxPartsPerMember)));
  // Spread the total evenly, but never ask for a body bigger than the room can build.
  const partsPerMember = Math.min(maxPartsPerMember, Math.ceil(totalParts / count));
  return { count, partsPerMember };
}
