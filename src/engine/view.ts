/**
 * view.ts — the EconomyView: the planner-assembled, plain-data picture the
 * broker builds handoffs from. Synthetic in the lab and the unit suites,
 * assembled from the World snapshot at bot cutover — the same type either
 * way (owner 2026-08-22: "either our fake synthetic world or in the real
 * world"). Corps never see this; they see only their handoffs.
 */
import { BodyShape } from "../sizing";
import { PlaceId } from "./vocabulary";

export interface ViewSource {
  id: string;
  /** The mouth's place id — where mined energy lands before transport. */
  mouth: PlaceId;
  spots: number;
  /** Route cost to the bank tile, in tiles. Chebyshev estimate until step
   * 2's world assembly lands real paths; the F1 line measures the gap. */
  distToBank: number;
}

/** A living creep as a handed asset: the planner re-hands it to the corp
 * named in its memory, and the corp quotes it as a backed step. */
export interface ViewCreep {
  id: string;
  corp: string;
  body: BodyShape;
  ttl: number;
}

export interface EconomyView {
  tick: number;
  /** The designated bank tile (the founding kernel: co-located with the
   * first spawn, between production and the controller). */
  bank: PlaceId;
  /** Spendable energy on hand right now — what ramp solvency checks. */
  bankStock: number;
  /** Body budget: the spawn estate's capacity, relayed by the broker as a
   * term of the spawning contract. */
  bodyBudget: number;
  spawnIds: string[];
  /** Route cost from the bank tile across the spawn estate — the tender's
   * shuttle distance. ~1 under the founding kernel; real once extensions
   * spread. */
  estateRadius: number;
  sources: ViewSource[];
  controller: { id: string; distFromBank: number } | null;
  creeps: ViewCreep[];
}
