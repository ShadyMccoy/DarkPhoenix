import { HARVEST_POWER, SOURCE_RATE } from "../primitives";
import { minerBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface MineHandoff {
  sourceId: string;
  spots: number;
  bank: PlaceId;
  bodyBudget: number;
  commute: number;
  creeps: ViewCreep[];
}

export function quoteMine(h: MineHandoff): Offer | null {
  const steps: Step[] = [];
  let cum = 0;

  for (const c of h.creeps) {
    const rate = Math.min(c.body.work * HARVEST_POWER, SOURCE_RATE - cum);
    if (rate <= 0) break;
    cum += rate;
    steps.push(liveStep(c, h.commute, { energyAt: { [h.sourceId]: rate } }, {}));
  }

  const body = minerBody(h.bodyBudget);
  if (body) {
    while (steps.length < h.spots && cum < SOURCE_RATE) {
      const rate = Math.min(body.work * HARVEST_POWER, SOURCE_RATE - cum);
      cum += rate;
      steps.push(hireStep(body, h.commute, { energyAt: { [h.sourceId]: rate } }, {}, `${body.work}W at the source`));
    }
  }

  if (steps.length === 0) return null;
  return { id: `mine:${h.sourceId}`, kind: "mine", steps };
}
