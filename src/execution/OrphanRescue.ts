/**
 * @fileoverview OrphanRescue - the safety net for live creeps whose corp is gone.
 *
 * A creep only ever acts if some live corp claims it: every corp finds its
 * workers by scanning Game.creeps for `creep.memory.corpId === this.id`. There is
 * no fallback. So the instant a creep outlives its owning corp - and corps are
 * demobilized routinely, e.g. when a flow re-solve drops a source's commission
 * (materializeCommissions deletes the corp while its already-spawned miner and
 * haulers live on with the now-dead corpId) - that creep is never iterated again.
 * It gets no move, no harvest, no recycle: it freezes on its tile and decays over
 * its whole ~1500-tick life. That is the "creeps just standing around until they
 * die" bug.
 *
 * This pass runs every tick AFTER all corps have run (so it sees the live corp
 * set for this tick) and rescues any creep no live corp claimed:
 *   1. RE-ADOPT it into a live corp that legitimately owns the same work - the
 *      harvest corp for the source it sits on, the carry corp for its assigned
 *      source, or a same-room corp of its role. This recovers creeps stranded by
 *      a corp-id change while the underlying job still exists.
 *   2. Otherwise RECYCLE it: once it has been orphaned past a grace window (which
 *      tolerates the one-or-few-tick commission churn around a re-solve, and the
 *      post-global-reset window before the first solve repopulates commissions),
 *      walk it to the nearest spawn and recycle it so its body energy returns to
 *      the colony instead of decaying to nothing.
 *
 * @module execution/OrphanRescue
 */

import { Corp } from "../corps/Corp";
import { CorpKind, listCorpKinds } from "../economy/CorpKind";
import { CorpRegistry } from "./CorpRunner";
import { allCommissionedCorps, commissionedCorpsOfKind } from "./CommissionHost";
import { driveRecycle } from "../corps/recycle";

/**
 * Ticks a creep may stay orphaned before it is recycled. Long enough to ride out
 * the commission churn around a flow re-solve (FULL_SOLVE_INTERVAL = 50, see CpuGovernor) without
 * killing a creep whose corp is about to reappear, short enough that a genuinely
 * abandoned creep stops wasting its life and returns its energy soon.
 */
export const ORPHAN_GRACE_TICKS = 25;

/** The next move for an orphaned creep, decided purely so it is unit-testable. */
export type OrphanAction = "none" | "readopt" | "wait" | "recycle";

/**
 * Decide what to do with a creep this tick, given whether a live corp already
 * claims it, whether a re-adoption target exists, and how long it has been
 * orphaned. Pure.
 *
 * - claimed                      -> "none"    (a live corp runs it; nothing to do)
 * - orphaned + re-adopt target   -> "readopt" (hand it to that corp)
 * - orphaned, within grace       -> "wait"    (its corp may reappear next solve)
 * - orphaned, past grace         -> "recycle" (return its body energy)
 */
export function orphanAction(
  claimed: boolean,
  hasReadoptTarget: boolean,
  orphanedSince: number | undefined,
  now: number,
  grace: number = ORPHAN_GRACE_TICKS
): OrphanAction {
  if (claimed) return "none";
  if (hasReadoptTarget) return "readopt";
  const since = orphanedSince ?? now;
  return now - since >= grace ? "recycle" : "wait";
}

/**
 * Every live corp id this tick: the whole commission-store census plus the two
 * legacy-registry corps (bootstrap, spawning). Registry-derived - a newly
 * registered kind's corps are live by construction, never by remembering to
 * extend a list here (the pre-spec-17 hand-maintained 11-kind list is gone).
 */
function liveCorpIds(registry: CorpRegistry): Set<string> {
  const ids = new Set<string>();
  for (const entry of allCommissionedCorps()) ids.add(entry.corp.id);
  for (const room in registry.bootstrapCorps) ids.add(registry.bootstrapCorps[room].id);
  for (const spawnId in registry.spawningCorps) ids.add(registry.spawningCorps[spawnId].id);
  return ids;
}

/**
 * The registered kinds that may re-adopt an orphan of the given workType, in
 * kind execution order. Derived from each kind's roles declaration
 * (RoleSpec.readopt gates kinds that stamp a workType but cede its rescue,
 * e.g. construction's tankers belong to the tender kind). Exported for the
 * registration-only conformance test.
 */
export function readoptKindsFor(workType: string): CorpKind[] {
  const kinds: CorpKind[] = [];
  for (const kind of listCorpKinds()) {
    for (const role in kind.roles) {
      const spec = kind.roles[role];
      if (spec.workType === workType && spec.readopt !== false) {
        kinds.push(kind);
        break;
      }
    }
  }
  return kinds;
}

/**
 * Find a live corp that legitimately owns this creep's work. Returns its id
 * (to stamp onto the creep), or null when no live corp covers the job - in
 * which case the creep is recycled instead of re-adopted.
 *
 * Ownership is declared by the kinds: a kind with claimsOrphan applies its own
 * rule (harvest: the source under the creep's feet; carry: the corp routing
 * its assigned source); the default is any same-room corp of a kind that
 * declared the creep's workType.
 */
function readoptTarget(creep: Creep): string | null {
  const workType = creep.memory.workType;
  if (!workType) return null;

  for (const kind of readoptKindsFor(workType)) {
    const corps = commissionedCorpsOfKind<Corp>(kind.kind);
    if (kind.claimsOrphan) {
      const claimed = (kind.claimsOrphan as (c: Creep, cs: { [id: string]: Corp }) => string | null)(creep, corps);
      if (claimed) return claimed;
      continue;
    }
    for (const id in corps) {
      if (corps[id].getPosition().roomName === creep.pos.roomName) return corps[id].id;
    }
  }
  return null;
}

/** The nearest spawn to recycle an abandoned creep at: same room first, else any. */
function nearestSpawn(creep: Creep): StructureSpawn | null {
  const inRoom = creep.room.find(FIND_MY_SPAWNS);
  if (inRoom.length > 0) {
    return inRoom.reduce((a, b) => (creep.pos.getRangeTo(a) <= creep.pos.getRangeTo(b) ? a : b));
  }
  const all = Object.values(Game.spawns);
  return all.length > 0 ? all[0] : null;
}

/**
 * Rescue every live creep no corp claimed this tick: re-adopt it into a live corp
 * for the same work, or recycle it once it has been orphaned past the grace
 * window. Call once per tick AFTER all corps have run.
 */
export function rescueOrphans(registry: CorpRegistry): void {
  const live = liveCorpIds(registry);
  const now = Game.time;

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    if (creep.spawning) continue;
    const corpId = creep.memory.corpId;
    if (!corpId) continue; // unmanaged by design (e.g. nothing assigned it yet)

    const claimed = live.has(corpId);
    const target = claimed ? null : readoptTarget(creep);
    const action = orphanAction(claimed, target !== null, creep.memory.orphanedSince, now);

    switch (action) {
      case "none":
        if (creep.memory.orphanedSince !== undefined) delete creep.memory.orphanedSince;
        break;
      case "readopt":
        creep.memory.corpId = target as string;
        delete creep.memory.orphanedSince;
        delete creep.memory.recycling;
        break;
      case "wait":
        if (creep.memory.orphanedSince === undefined) creep.memory.orphanedSince = now;
        break;
      case "recycle": {
        const spawn = nearestSpawn(creep);
        if (spawn) driveRecycle(creep, spawn);
        break;
      }
    }
  }
}
