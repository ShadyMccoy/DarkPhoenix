/**
 * corps/haul.ts — transport by body. Quotes AGAINST A GAP the planner
 * publishes after netting positions (round two of clearing): no corp ever
 * asks for a hauler; the haul kind offers to cover + / − gaps at its own
 * price — per-tile bodies, spawnTime consumption (piece 1's boundary).
 * The link kind will compete on these same edges in phase 2.
 */
import { bodyCost, haulRate, spawnTimeEt, upkeepEt } from "../primitives";
import { haulerBody } from "../sizing";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface HaulGap {
  from: PlaceId;
  to: PlaceId;
  /** One-way route cost in tiles. */
  dist: number;
  /** e/t the gap needs moved. */
  flow: number;
}

export interface HaulHandoff {
  gap: HaulGap;
  bank: PlaceId;
  bodyBudget: number;
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
    steps.push({
      backedBy: c.id,
      provides: { energyAt: { [to]: rate } },
      requires: { energyAt: { [from]: rate } },
      cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
      note: `alive ttl=${c.ttl}`
    });
  }

  const body = haulerBody(h.bodyBudget);
  if (body) {
    const perBody = haulRate(body.carry, dist);
    while (cum < flow && perBody > 0) {
      cum += perBody;
      steps.push({
        buys: body,
        provides: { energyAt: { [to]: perBody } },
        requires: { energyAt: { [from]: perBody } },
        cost: { upfront: bodyCost(body), upkeepEt: upkeepEt(body), spawnTimeEt: spawnTimeEt(body) },
        note: `${body.carry}C over ${dist} tiles`
      });
    }
  }

  if (steps.length === 0) return null;
  return { id: `haul:${from}->${to}`, kind: "haul", steps };
}
