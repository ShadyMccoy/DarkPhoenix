/**
 * corps/haul.ts — transport by body. Quotes AGAINST A GAP the planner
 * publishes after netting positions (round two of clearing): no corp ever
 * asks for a hauler; the haul kind offers to cover + / − gaps at its own
 * price — per-tile bodies, spawnTime consumption (piece 1's boundary).
 * The link kind will compete on these same edges in phase 2.
 */
import { bodyCost, haulRate, spawnTimeEt, upkeepEt } from "../primitives";
import { haulerBodyFor } from "../sizing";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface HaulGap {
  from: PlaceId;
  to: PlaceId;
  /** One-way route cost in tiles. */
  dist: number;
  /** e/t the gap needs moved. */
  flow: number;
  /** A paved route: bodies run 2C:1M — the roaded reprice (Tier 1.4). */
  roaded?: boolean;
  /** The gap unloads into a LINK PORT (a collector leg), so bodies cap
   * at the landing quantum — Addendum 4's anatomy at the haul quote. */
  linkFed?: boolean;
}

export interface HaulHandoff {
  gap: HaulGap;
  bank: PlaceId;
  bodyBudget: number;
  /** Posting walk to the ROUTE — zero when an endpoint is the bank (the
   * first empty leg is a cycle); a collector leg pays the walk out
   * (Addendum 6). */
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
    steps.push({
      backedBy: c.id,
      body: c.body,
      commute: h.commute,
      provides: { energyAt: { [to]: rate } },
      requires: { energyAt: { [from]: rate } },
      cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
      note: `alive ttl=${c.ttl}`
    });
  }

  // Each marginal body is sized to the flow still uncovered (#148's law
  // at the quote): the fleet's last body shrinks to the remainder, so no
  // edge carries idle CARRY it must bill for.
  while (cum < flow) {
    const body = haulerBodyFor(flow - cum, dist, h.bodyBudget, h.gap.roaded, h.gap.linkFed);
    if (!body) break;
    const perBody = haulRate(body.carry, dist);
    if (perBody <= 0) break;
    cum += perBody;
    steps.push({
      body,
      commute: h.commute,
      provides: { energyAt: { [to]: perBody } },
      requires: { energyAt: { [from]: perBody } },
      cost: {
        upfront: bodyCost(body),
        upkeepEt: upkeepEt(body, h.commute),
        spawnTimeEt: spawnTimeEt(body, h.commute)
      },
      note: `${body.carry}C over ${dist} tiles`
    });
  }

  if (steps.length === 0) return null;
  return { id: `haul:${from}->${to}`, kind: "haul", steps };
}
