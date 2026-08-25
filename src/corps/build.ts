import { BUILD_POWER, PROJECT_RATE_WINDOW } from "../primitives";
import { builderBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface BuildHandoff {
  siteId: string;
  at: PlaceId;
  total: number;
  remaining: number;
  bodyBudget: number;
  commute: number;
  creeps: ViewCreep[];
}

export function quoteBuild(h: BuildHandoff): Offer | null {
  if (h.remaining <= 0) return null;
  const cap = h.total / PROJECT_RATE_WINDOW;
  const steps: Step[] = [];
  let cum = 0;

  for (const c of h.creeps) {
    const burn = Math.min(c.body.work * BUILD_POWER, Math.max(cap - cum, 0));
    if (burn <= 0) break;
    cum += burn;
    steps.push(liveStep(c, h.commute, { progress: burn }, { energyAt: { [h.at]: burn } }));
  }

  const body = builderBody(h.bodyBudget);
  if (body) {
    const perBody = body.work * BUILD_POWER;
    while (cum < cap - 1e-9) {
      const burn = Math.min(perBody, cap - cum);
      cum += burn;
      steps.push(
        hireStep(body, h.commute, { progress: burn }, { energyAt: { [h.at]: burn } }, `${body.work}W at the site`)
      );
    }
  }

  if (steps.length === 0) return null;
  return { id: `build:${h.siteId}`, kind: "build", steps };
}
