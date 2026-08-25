import { spawnTimeEt, upkeepEt } from "../primitives";
import { BodyShape } from "../sizing";

export type PlaceId = string;

export interface Flows {
  energyAt?: Record<PlaceId, number>;
  spawnTime?: number;
  controlPoints?: number;
  progress?: number;
}

export function addFlows(into: Flows, from: Flows, scale = 1): void {
  if (from.spawnTime) into.spawnTime = (into.spawnTime ?? 0) + from.spawnTime * scale;
  if (from.controlPoints) into.controlPoints = (into.controlPoints ?? 0) + from.controlPoints * scale;
  if (from.progress) into.progress = (into.progress ?? 0) + from.progress * scale;
  for (const place of Object.keys(from.energyAt ?? {})) {
    const at = into.energyAt ?? (into.energyAt = {});
    at[place] = (at[place] ?? 0) + (from.energyAt as Record<PlaceId, number>)[place] * scale;
  }
}

export interface StepCost {
  upfront: number;
  upkeepEt: number;
  feeEt?: number;
  spawnTimeEt: number;
}

export interface Step {
  body?: BodyShape;
  commute?: number;
  backedBy?: string;
  provides: Flows;
  requires: Flows;
  cost: StepCost;
  note?: string;
}

export function stepBillEt(s: Step): number {
  let bill = s.cost.upkeepEt + (s.cost.feeEt ?? 0);
  if (s.backedBy && s.body) bill += upkeepEt(s.body, s.commute ?? 0);
  return bill;
}

export function stepMachineEt(s: Step): number {
  let machine = s.cost.spawnTimeEt;
  if (s.backedBy && s.body) machine += spawnTimeEt(s.body, s.commute ?? 0);
  return machine;
}

export type CorpKindName = "workman" | "mine" | "haul" | "link" | "upgrade" | "spawning" | "build";

export type StructureKind = "link" | "extension" | "container" | "storage" | "road";

export interface Approval {
  structure: StructureKind;
  edge?: { from: PlaceId; to: PlaceId };
  at: PlaceId;
  capex: number;
  detail: string;
}

export interface Offer {
  id: string;
  kind: CorpKindName;
  steps: Step[];
}

export interface CorpPnl {
  grossEt: number;
  costEt: number;
  netEt: number;
}

export interface CorpInstance {
  id: string;
  kind: CorpKindName;
  staff: { body: BodyShape; live: string | null }[];
  target: number;
  backed: number;
  chain: string | null;
  pnl: CorpPnl;
  inputs: Flows;
  outputs: Flows;
}

export type FrontierReason =
  | "net<0"
  | "spawn capacity"
  | "energy residual"
  | "ramp insolvent"
  | "source saturated"
  | "outcompeted"
  | "awaiting stock"
  | "tender short"
  | "link budget"
  | "capex unreachable";

export interface FrontierLine {
  offerId: string;
  reason: FrontierReason;
  detail: string;
}

export interface PositionRow {
  place: PlaceId;
  supplyEt: number;
  demandEt: number;
  netEt: number;
}

export interface EnginePlan {
  tick: number;
  corps: CorpInstance[];
  frontier: FrontierLine[];
  approvals: Approval[];
  positions: PositionRow[];
  violations: string[];
  expected: {
    minedEt: number;
    deliveredEt: number;
    refillEt: number;
    feesEt: number;
    upgradeEt: number;
    buildEt: number;
    warchestEt: number;
    holdingEt: number;
    standingEt: number;
    standingUpgradeEt: number;
    standingBuildEt: number;
    standingRefillEt: number;
    standingFeesEt: number;
  };
}
