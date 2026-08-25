import { haulRate } from "../primitives";
import { tenderBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export const ESTATE_CORP = "spawning:estate";

export interface TenderHandoff {
  bank: PlaceId;
  estateRadius: number;
  bodyBudget: number;
  obligationEt: number;
  creeps: ViewCreep[];
}

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

export function tenderCapacities(offer: Offer, estateRadius: number): number[] {
  return offer.steps.map(s => (s.body ? haulRate(s.body.carry, estateRadius) : 0));
}
