/**
 * corps/spawning.ts — the estate's own refill service (owner ruling
 * 2026-08-23: the tender is the spawn corp's own body, never a haul job).
 * Machine-time capacity is a scalar the broker derives (spawns ×
 * SPAWN_RATE); this file prices the TENDER that carries the funded
 * obligation from the bank into the spawn and extensions.
 */
import { haulRate } from "../primitives";
import { tenderBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

/** The estate's own corp id — the tender fleet's employer. */
export const ESTATE_CORP = "spawning:estate";

export interface TenderHandoff {
  bank: PlaceId;
  /** Route cost from the bank tile across the spawn estate — ~1 under the
   * founding kernel, real once extensions spread. */
  estateRadius: number;
  bodyBudget: number;
  /** Ceiling on the obligation the schedule must be able to carry — the
   * broker's bound (total source income plus the live fleet's bills). */
  obligationEt: number;
  creeps: ViewCreep[];
}

/** Floor on the quoted schedule; the obligation ceiling sizes the rest.
 * A CONSTANT schedule was the finding: intake capped at 4 bodies while
 * the heartbeat scales with the fleet — the schedule is a sizing
 * decision (law 5), never a const. Hard cap keeps a silly world from
 * quoting an army; beyond it `tender short` prints. */
const TENDER_SCHEDULE_FLOOR = 4;
const TENDER_SCHEDULE_CAP = 12;

export function quoteTender(h: TenderHandoff): Offer | null {
  const steps: Step[] = [];
  for (const c of h.creeps) {
    steps.push(liveStep(c, 0, {}, {}, `alive, ${haulRate(c.body.carry, h.estateRadius).toFixed(1)} e/t intake`));
  }
  const body = tenderBody(h.bodyBudget);
  if (body) {
    const perBody = haulRate(body.carry, h.estateRadius);
    const wanted =
      perBody > 0
        ? Math.min(TENDER_SCHEDULE_CAP, Math.max(TENDER_SCHEDULE_FLOOR, Math.ceil(h.obligationEt / perBody)))
        : TENDER_SCHEDULE_FLOOR;
    for (let i = steps.length; i < wanted; i++) {
      steps.push(hireStep(body, 0, {}, {}, `${body.carry}C over the estate`));
    }
  }
  if (steps.length === 0) return null;
  return { id: ESTATE_CORP, kind: "spawning", steps };
}

/** Per-step intake capacity (e/t into structures) for the market. The
 * body rides the step whether backed or bought (the 2026-08-24 second
 * landing) — the creep re-join this function used to do is gone. */
export function tenderCapacities(offer: Offer, estateRadius: number): number[] {
  return offer.steps.map(s => (s.body ? haulRate(s.body.carry, estateRadius) : 0));
}
