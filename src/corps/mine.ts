/**
 * corps/mine.ts — static mining: WORK sits at the source and drains the
 * source. Provides energy AT THE MOUTH; getting it to the bank is the
 * transport market's business (positions, not hauler requests — piece 1).
 * Quote side only until the cutover brings the runner and the harvest
 * chokepoint here.
 */
import { HARVEST_POWER, SOURCE_RATE } from "../primitives";
import { minerBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface MineHandoff {
  /** The source's id doubles as its place: mined energy provides here. */
  sourceId: string;
  spots: number;
  bank: PlaceId;
  bodyBudget: number;
  /** Posting walk to the mouth — miners park, so their whole bill
   * prorates over the effective life (Addendum 6). */
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
