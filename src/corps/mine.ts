/**
 * corps/mine.ts — static mining: WORK sits at the mouth and drains the
 * source. Provides energy AT THE MOUTH; getting it to the bank is the
 * transport market's business (positions, not hauler requests — piece 1).
 * Quote side only until the cutover brings the runner and the harvest
 * chokepoint here.
 */
import { HARVEST_POWER, SOURCE_RATE, bodyCost, spawnTimeEt, upkeepEt } from "../primitives";
import { minerBody } from "../sizing";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface MineHandoff {
  sourceId: string;
  mouth: PlaceId;
  spots: number;
  bank: PlaceId;
  bodyBudget: number;
  creeps: ViewCreep[];
}

export function quoteMine(h: MineHandoff): Offer | null {
  const steps: Step[] = [];
  let cum = 0;

  for (const c of h.creeps) {
    const rate = Math.min(c.body.work * HARVEST_POWER, SOURCE_RATE - cum);
    if (rate <= 0) break;
    cum += rate;
    steps.push({
      backedBy: c.id,
      provides: { energyAt: { [h.mouth]: rate } },
      requires: {},
      cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
      note: `alive ttl=${c.ttl}`
    });
  }

  const body = minerBody(h.bodyBudget);
  if (body) {
    while (steps.length < h.spots && cum < SOURCE_RATE) {
      const rate = Math.min(body.work * HARVEST_POWER, SOURCE_RATE - cum);
      cum += rate;
      steps.push({
        buys: body,
        provides: { energyAt: { [h.mouth]: rate } },
        requires: {},
        cost: { upfront: bodyCost(body), upkeepEt: upkeepEt(body), spawnTimeEt: spawnTimeEt(body) },
        note: `${body.work}W at the mouth`
      });
    }
  }

  if (steps.length === 0) return null;
  return { id: `mine:${h.sourceId}`, kind: "mine", steps };
}
