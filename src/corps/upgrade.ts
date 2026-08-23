/**
 * corps/upgrade.ts — the terminal converter: energy into control points,
 * 1:1 below RCL8 (progress == energy). Value is realized HERE and only
 * here (owner pin: production has no standalone worth). The body parks at
 * the bank branch and self-feeds — the founding kernel co-locates the two.
 */
import { UPGRADE_POWER, bodyCost, spawnTimeEt, upkeepEt } from "../primitives";
import { upgraderBody } from "../sizing";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface UpgradeHandoff {
  controllerId: string;
  /** Where its energy must arrive — the controller-side feed point. */
  feed: PlaceId;
  bodyBudget: number;
  /** Ceiling on useful burn — the world cannot upgrade more than it mines,
   * so the broker passes total source rate; the schedule ends there. */
  maxBurn: number;
  creeps: ViewCreep[];
}

export function quoteUpgrade(h: UpgradeHandoff): Offer | null {
  const steps: Step[] = [];
  let cum = 0;

  for (const c of h.creeps) {
    const burn = Math.min(c.body.work * UPGRADE_POWER, Math.max(h.maxBurn - cum, 0));
    if (burn <= 0) break;
    cum += burn;
    steps.push({
      backedBy: c.id,
      provides: { controlPoints: burn },
      requires: { energyAt: { [h.feed]: burn } },
      cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
      note: `alive ttl=${c.ttl}`
    });
  }

  const body = upgraderBody(h.bodyBudget);
  if (body) {
    const perBody = body.work * UPGRADE_POWER;
    while (cum < h.maxBurn) {
      const burn = Math.min(perBody, h.maxBurn - cum);
      cum += burn;
      steps.push({
        buys: body,
        provides: { controlPoints: burn },
        requires: { energyAt: { [h.feed]: burn } },
        cost: { upfront: bodyCost(body), upkeepEt: upkeepEt(body), spawnTimeEt: spawnTimeEt(body) },
        note: `${body.work}W at the controller`
      });
    }
  }

  if (steps.length === 0) return null;
  return { id: `upgrade:${h.controllerId}`, kind: "upgrade", steps };
}
