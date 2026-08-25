import { haulRate } from "../primitives";
import { haulerBodyFor } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface HaulGap {
  from: PlaceId;
  to: PlaceId;
  dist: number;
  flow: number;
  roaded?: boolean;
  linkFed?: boolean;
}

export interface HaulHandoff {
  gap: HaulGap;
  bank: PlaceId;
  bodyBudget: number;
  commute: number;
  creeps: ViewCreep[];
}

export function quoteHaul(h: HaulHandoff): Offer | null {
  const { from, to, dist, flow } = h.gap;
  const steps: Step[] = [];
  let cum = 0;

  for (const c of h.creeps) {
    const rate = haulRate(c.body.carry, dist);
    if (rate <= 0) continue;
    cum += rate;
    steps.push(liveStep(c, h.commute, { energyAt: { [to]: rate } }, { energyAt: { [from]: rate } }));
  }

  while (cum < flow) {
    const body = haulerBodyFor(flow - cum, dist, h.bodyBudget, h.gap.roaded, h.gap.linkFed);
    if (!body) break;
    const perBody = haulRate(body.carry, dist);
    if (perBody <= 0) break;
    cum += perBody;
    steps.push(
      hireStep(
        body,
        h.commute,
        { energyAt: { [to]: perBody } },
        { energyAt: { [from]: perBody } },
        `${body.carry}C over ${dist} tiles`
      )
    );
  }

  if (steps.length === 0) return null;
  return { id: `haul:${from}->${to}`, kind: "haul", steps };
}
