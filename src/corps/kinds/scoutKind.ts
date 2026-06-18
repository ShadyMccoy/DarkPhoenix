/**
 * @fileoverview scoutKind - ScoutCorp as a registered CorpKind: the first real
 * port onto the corp framework (docs/specs/00-corp-framework.md).
 *
 * Auxiliary shape: scouting is off the income budget (a tightly gated luxury -
 * RCL >= 2, MAX_SCOUTS, cooldown, stale-room check - all enforced at runtime by
 * the corp itself, where Game state lives). The proposal trigger is simply "a
 * room with a spawn exists": a scout corp with zero creeps costs nothing, and
 * commissioning it unconditionally keeps propose() pure.
 *
 * NOT yet registered by the live loop - rung 5 (the runtime host that replaces
 * runScoutCorps) is the next strangler cut. Until then this module is exercised
 * by the rung 1-4 tests only and changes no live behavior.
 *
 * @module corps/kinds/scoutKind
 */

import { Commission, corpIdFor } from "../../economy/Commission";
import { CorpKind } from "../../economy/CorpKind";
import { ColonyProblem } from "../../economy/CorpPlanner";
import { SerializedCorp } from "../Corp";
import { ScoutCorp, SerializedScoutCorp } from "../ScoutCorp";
import { SpawningCorp } from "../SpawningCorp";

/** The scout commission's binding: which room, served by which spawn. */
export interface ScoutAssignment {
  roomName: string;
  spawnId: string;
}

/**
 * Spawn access is the one live dependency run() has. The integration host
 * injects the real lookup (registry.spawningCorps); tests inject stubs; the
 * default of "no spawning corp" degrades to work-only, never throws.
 */
let resolveSpawningCorp: (spawnId: string) => SpawningCorp | undefined = () => undefined;

export function setSpawningCorpResolver(fn: (spawnId: string) => SpawningCorp | undefined): void {
  resolveSpawningCorp = fn;
}

export const scoutKind: CorpKind<ScoutCorp> = {
  kind: "scout",
  runOrder: 40,

  propose(problem: ColonyProblem): Commission[] {
    // One scout corp per room that has a spawn (first spawn is home).
    const homeSpawnByRoom = new Map<string, string>();
    for (const s of problem.spawns) {
      if (!homeSpawnByRoom.has(s.pos.roomName)) {
        homeSpawnByRoom.set(s.pos.roomName, s.id);
      }
    }
    return [...homeSpawnByRoom].map(([roomName, spawnId]) => ({
      corpId: corpIdFor("scout", roomName),
      kind: "scout",
      shape: "auxiliary",
      // Off-budget: the runtime gates make scout spawn-time negligible, and
      // intel value is realized on visit (recordRevenue), not plannable.
      consumes: { spawnPartsPerTick: 0 },
      produces: { valuePerTick: 0 },
      assignment: { roomName, spawnId } as ScoutAssignment
    }));
  },

  materialize(c: Commission, existing: ScoutCorp | undefined): ScoutCorp {
    if (existing) return existing;
    const a = c.assignment as ScoutAssignment;
    // Legacy nodeId convention (`${roomName}-scout`) gives the same runtime
    // corp id the old plumbing generated, so live creeps' memory.corpId still
    // resolves across the migration.
    return new ScoutCorp(`${a.roomName}-scout`, a.spawnId);
  },

  run(corp: ScoutCorp, tick: number): void {
    corp.work(tick);
    const spawning = resolveSpawningCorp(corp.getSpawnId());
    if (spawning) {
      corp.requestSpawnsIfNeeded(spawning, tick);
    }
  },

  serializeCorp(corp: ScoutCorp): SerializedScoutCorp {
    return corp.serialize();
  },

  deserializeCorp(data: SerializedCorp): ScoutCorp {
    const d = data as SerializedScoutCorp;
    const corp = new ScoutCorp(d.nodeId, d.spawnId, d.id);
    corp.deserialize(d);
    return corp;
  },

  body(): BodyPartConstant[] {
    return [MOVE]; // a scout is one MOVE part, always
  }
};
