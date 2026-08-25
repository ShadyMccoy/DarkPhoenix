import { UPGRADE_POWER } from "../primitives";
import { upgraderBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface UpgradeHandoff {
  controllerId: string;
  feed: PlaceId;
  bodyBudget: number;
  maxBurn: number;
  commute: number;
  creeps: ViewCreep[];
}

export function quoteUpgrade(h: UpgradeHandoff): Offer | null {
  const steps: Step[] = [];
  let cum = 0;

  for (const c of h.creeps) {
    const burn = Math.min(c.body.work * UPGRADE_POWER, Math.max(h.maxBurn - cum, 0));
    if (burn <= 0) break;
    cum += burn;
    steps.push(liveStep(c, h.commute, { controlPoints: burn }, { energyAt: { [h.feed]: burn } }));
  }

  const body = upgraderBody(h.bodyBudget);
  if (body) {
    const perBody = body.work * UPGRADE_POWER;
    while (cum < h.maxBurn) {
      const burn = Math.min(perBody, h.maxBurn - cum);
      cum += burn;
      steps.push(
        hireStep(
          body,
          h.commute,
          { controlPoints: burn },
          { energyAt: { [h.feed]: burn } },
          `${body.work}W at the controller`
        )
      );
    }
  }

  if (steps.length === 0) return null;
  return { id: `upgrade:${h.controllerId}`, kind: "upgrade", steps };
}
