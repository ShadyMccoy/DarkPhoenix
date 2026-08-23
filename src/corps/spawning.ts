/**
 * corps/spawning.ts — the spawn estate sells pure machine time: 1/3
 * part/tick per standing spawn, backed by the structure (a standing asset
 * quotes free — piece 5). The ENERGY of bodies rides on each buyer's step
 * as its parts bill, so nothing double-counts, and the tender heartbeat is
 * the identity Σ funded upkeepEt. Its own P&L instance (utilization
 * pricing) arrives with its milestone, per piece 3.
 */
import { SPAWN_RATE } from "../primitives";
import { Offer, Step } from "../engine/vocabulary";

export interface SpawningHandoff {
  spawnIds: string[];
}

export function quoteSpawning(h: SpawningHandoff): Offer | null {
  if (h.spawnIds.length === 0) return null;
  const steps: Step[] = h.spawnIds.map(id => ({
    backedBy: id,
    provides: { spawnTime: SPAWN_RATE },
    requires: {},
    cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
    note: "standing spawn"
  }));
  return { id: "spawning:estate", kind: "spawning", steps };
}
