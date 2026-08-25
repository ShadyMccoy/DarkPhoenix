import { bodyCost, spawnTimeEt, upkeepEt } from "../primitives";
import { BodyShape } from "../sizing";
import { Flows, Step } from "../engine/vocabulary";
import { ViewCreep } from "../engine/view";

export function liveStep(c: ViewCreep, commute: number, provides: Flows, requires: Flows, note?: string): Step {
  return {
    backedBy: c.id,
    body: c.body,
    commute,
    provides,
    requires,
    cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
    note: note ?? `alive ttl=${c.ttl}`
  };
}

export function hireStep(body: BodyShape, commute: number, provides: Flows, requires: Flows, note: string): Step {
  return {
    body,
    commute,
    provides,
    requires,
    cost: { upfront: bodyCost(body), upkeepEt: upkeepEt(body, commute), spawnTimeEt: spawnTimeEt(body, commute) },
    note
  };
}
