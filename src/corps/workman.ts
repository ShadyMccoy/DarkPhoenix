/**
 * corps/workman.ts — the fused converter and the engine's root: one body
 * that mines, walks, and delivers to the bank. It always quotes; it wins
 * only worlds where nothing else is solvent (the bootstrap) and is
 * outcompeted the moment specialist chains fund — piece 6's no-mode
 * cascade. The runner stays in execute.ts until the cutover.
 */
import { SOURCE_RATE, workmanCycleRate } from "../primitives";
import { workmanBody } from "../sizing";
import { hireStep, liveStep } from "./steps";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export interface WorkmanHandoff {
  sourceId: string;
  spots: number;
  bank: PlaceId;
  distToBank: number;
  bodyBudget: number;
  creeps: ViewCreep[];
}

export function quoteWorkman(h: WorkmanHandoff): Offer | null {
  const steps: Step[] = [];
  let cum = 0;

  for (const c of h.creeps) {
    const rate = Math.min(workmanCycleRate(c.body, h.distToBank), SOURCE_RATE - cum);
    if (rate <= 0) break;
    cum += rate;
    steps.push(liveStep(c, h.distToBank, { energyAt: { [h.bank]: rate } }, {}));
  }

  const body = workmanBody(h.bodyBudget);
  if (body) {
    const perBody = workmanCycleRate(body, h.distToBank);
    while (steps.length < h.spots && cum < SOURCE_RATE) {
      const rate = Math.min(perBody, SOURCE_RATE - cum);
      cum += rate;
      steps.push(
        hireStep(body, h.distToBank, { energyAt: { [h.bank]: rate } }, {}, `cycle over ${h.distToBank} tiles`)
      );
    }
  }

  if (steps.length === 0) return null;
  return { id: `workman:${h.sourceId}`, kind: "workman", steps };
}
