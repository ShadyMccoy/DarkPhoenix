/**
 * @fileoverview Shared census/body measurement lenses for the telemetry writers.
 *
 * Charter: the census-entry shape the orchestrator is handed
 * (`CorpCensusEntry`), the small corp lenses over it (creep count, room name),
 * and the ACTUAL-body aggregation over `Game.creeps` that the core (segment 0)
 * and corps (segment 4) writers both consume from ONE pass. Measurement only -
 * no RawMemory writes, no segment shapes; those live in the per-segment
 * writer modules.
 *
 * Layer: telemetry instrument (Game-coupled reader; writes nothing).
 *
 * @module telemetry/bodyCensus
 */

import { Corp } from "../corps/Corp";

/**
 * One corp in the complete census (structurally compatible with
 * CommissionHost.CorpCensusEntry - the caller passes that array here). Kept
 * local so telemetry does not depend on the execution layer.
 */
export interface CorpCensusEntry {
  corpId: string;
  kind: string;
  corp: Corp;
}

/** Live creep count for any corp that exposes the accessor. */
export function corpCreepCount(corp: Corp): number {
  const c = corp as unknown as { getCreepCount?: () => number };
  if (typeof c.getCreepCount === "function") return c.getCreepCount();
  return 0;
}

/** Room name for a corp, derived from its nodeId prefix. */
export function corpRoomName(corp: Corp): string {
  return corp.nodeId.split("-")[0] || "unknown";
}

/**
 * A measured body: total part count plus a per-type breakdown (only non-zero
 * types present). Keys are the raw Screeps part types ("work", "carry", ...).
 */
export interface BodyAggregate {
  total: number;
  byPart: { [part: string]: number };
}

/** Fresh, empty aggregate. */
export function emptyBody(): BodyAggregate {
  return { total: 0, byPart: {} };
}

/**
 * Aggregate ACTUAL body parts from every live creep (`Creep.body`), grouped by
 * the corp that owns it (`memory.corpId`). This is measured ground truth - NOT
 * reconstructed from planner harvest rates (the flow segment's `workParts` is
 * the PLAN side; this is the ACTUAL side) - so a dashboard can sit the planner's
 * committed parts next to the parts actually walking around.
 *
 * One pass yields both views: `perCorp` (keyed by corpId, for the corps
 * segment) and `colony` (every creep, orphans included, for the core segment) -
 * a creep we are paying for counts colony-wide even when no live corp claims it.
 */
export function aggregateActualBodies(): { perCorp: Map<string, BodyAggregate>; colony: BodyAggregate } {
  const perCorp = new Map<string, BodyAggregate>();
  const colony = emptyBody();

  for (const name in Game.creeps) {
    const creep = Game.creeps[name];
    const body = creep.body ?? []; // spawning/mocked creeps may lack a body
    if (body.length === 0) continue;

    const corpId = creep.memory?.corpId;
    let bucket: BodyAggregate | undefined;
    if (corpId) {
      bucket = perCorp.get(corpId);
      if (!bucket) {
        bucket = emptyBody();
        perCorp.set(corpId, bucket);
      }
    }

    for (const part of body) {
      const t = part.type;
      colony.total++;
      colony.byPart[t] = (colony.byPart[t] || 0) + 1;
      if (bucket) {
        bucket.total++;
        bucket.byPart[t] = (bucket.byPart[t] || 0) + 1;
      }
    }
  }

  return { perCorp, colony };
}
