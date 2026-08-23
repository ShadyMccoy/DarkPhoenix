/**
 * corps/spawning.ts — the spawn estate prices TWO services (owner ruling
 * 2026-08-23: the tender is the spawn corp's own body, never a haul job):
 *
 * 1. Machine time — 1/3 part/tick per standing spawn, backed by the
 *    structure (a standing asset quotes free — piece 5).
 * 2. Refill intake — TENDER bodies that carry the funded obligation from
 *    the bank into the spawn and extensions. Hauling is inter-corp
 *    logistics; filling the estate is this corp's own operation.
 *
 * The ENERGY of bodies rides on each buyer's step as its parts bill, so
 * nothing double-counts; the tender moves those bills and its own cost is
 * one more line of the obligation paid first — the heartbeat, priced.
 */
import { SPAWN_RATE, bodyCost, haulRate, spawnTimeEt, upkeepEt } from "../primitives";
import { tenderBody } from "../sizing";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

/** The estate's own corp id — the tender fleet's employer. */
export const ESTATE_CORP = "spawning:estate";

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
  return { id: "spawning:capacity", kind: "spawning", steps };
}

export interface TenderHandoff {
  bank: PlaceId;
  /** Route cost from the bank tile across the spawn estate — ~1 under the
   * founding kernel, real once extensions spread. */
  estateRadius: number;
  bodyBudget: number;
  creeps: ViewCreep[];
}

/** Enough schedule to cover any plausible obligation; unfunded tail steps
 * simply never fund. */
const TENDER_SCHEDULE = 4;

export function quoteTender(h: TenderHandoff): Offer | null {
  const steps: Step[] = [];
  for (const c of h.creeps) {
    steps.push({
      backedBy: c.id,
      provides: {},
      requires: {},
      cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
      note: `alive, ${haulRate(c.body.carry, h.estateRadius).toFixed(1)} e/t intake`
    });
  }
  const body = tenderBody(h.bodyBudget);
  if (body) {
    for (let i = steps.length; i < TENDER_SCHEDULE; i++) {
      steps.push({
        buys: body,
        provides: {},
        requires: {},
        cost: { upfront: bodyCost(body), upkeepEt: upkeepEt(body), spawnTimeEt: spawnTimeEt(body) },
        note: `${body.carry}C over the estate`
      });
    }
  }
  if (steps.length === 0) return null;
  return { id: ESTATE_CORP, kind: "spawning", steps };
}

/** Per-step intake capacity (e/t into structures) for the market. */
export function tenderCapacities(offer: Offer, estateRadius: number, creeps: ViewCreep[]): number[] {
  return offer.steps.map(s => {
    if (s.backedBy) {
      const c = creeps.find(k => k.id === s.backedBy);
      return c ? haulRate(c.body.carry, estateRadius) : 0;
    }
    return s.buys ? haulRate(s.buys.carry, estateRadius) : 0;
  });
}
