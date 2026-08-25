/**
 * corps/build.ts — construction: the missing verb (roadmap Tier 1.1). The
 * build corp converts energy AT A SITE into progress — the flow whose
 * accumulated stock is a standing asset. It quotes against sites the same
 * way mine quotes against sources; the site's supply line is the transport
 * market's business, and the burn is a CAPITAL sink: it draws the stock
 * the approval reserved, never the residual (piece 9).
 *
 * Known mis-pricing, recorded (Tier-1 findings): builder upkeep amortizes
 * over CREEP_LIFE like every body, but a project employs its fleet only
 * remaining/burn ticks — a 300-tick project charges ~1/5 of the body it
 * consumes. The believer's cash pays full price at hire, so the books stay
 * honest; only the plan's P&L column flatters bursty construction. The
 * clean fix is a labor pool (build borrowing the upgrade fleet) or
 * project-window amortization — an owner conversation, not a patch.
 */
import { BUILD_POWER, PROJECT_RATE_WINDOW } from "../primitives";
import { builderBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface BuildHandoff {
  siteId: string;
  /** The site's place: burn requires energy HERE; transport covers it. */
  at: PlaceId;
  /** Full project capex — the rate base, constant over the project. */
  total: number;
  remaining: number;
  bodyBudget: number;
  /** Posting walk to the site (Addendum 6). */
  commute: number;
  creeps: ViewCreep[];
}

export function quoteBuild(h: BuildHandoff): Offer | null {
  if (h.remaining <= 0) return null;
  // The planned burn rate: the WHOLE project over one regen period —
  // constant, from `total`, never from `remaining`: a rate proportional
  // to the shrinking remainder decays geometrically and the site never
  // finishes (the believer's Zeno site, session finding 2026-08-23). A
  // steady-state ledger cannot price completion time (finding); this
  // window keeps fleets small, constant, and projects one window long.
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
