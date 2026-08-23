/**
 * corps/link.ts — transport by wire (REBOOT piece 5, owner 2026-08-18:
 * "the link corp provides hauling, essentially — just like the haul corp
 * does, but at different prices and constraints"). Links are their own
 * KIND, quoting the SAME gaps the haul corp quotes: fixed endpoints,
 * ~800/distance throughput, a 3% tax, zero spawn time — and they require
 * their structures standing.
 *
 * Pricing is piece 5's law made literal. A STANDING pair quotes marginal:
 * the tax and nothing else — so it wins its edge stably in every replan.
 * A CANDIDATE (one or both ends missing) quotes FULL cost: the same tax
 * plus its capex amortized over HORIZON as feeEt, and the raw capex as
 * upfront for solvency and the bank to pay at build time. "Something
 * changes majorly" has this exact arithmetic meaning.
 */
import { HORIZON, LINK_CAPACITY, LINK_COST, LINK_LOSS } from "../primitives";
import { HaulGap } from "./haul";
import { Offer, PlaceId } from "../engine/vocabulary";
import { ViewLink } from "../engine/view";

export interface LinkHandoff {
  gap: HaulGap;
  /** Standing links at the gap's endpoints, if any. */
  atFrom: ViewLink | null;
  atTo: ViewLink | null;
}

export interface TrunkSlice {
  sourceId: string;
  flow: number;
}

export interface TrunkHandoff {
  from: PlaceId;
  to: PlaceId;
  dist: number;
  /** Per-source shares of the pair's capacity — one step each, so every
   * consolidated chain funds and pays for exactly its own share. */
  slices: TrunkSlice[];
  atFrom: ViewLink | null;
  atTo: ViewLink | null;
}

/**
 * The consolidation trunk (owner 2026-08-23: "consolidate multiple haul
 * routes into one link outpost"): ONE standing pair quoted as one step
 * per assigned source, each priced at the tax on its own slice. The
 * offer's target then reads as slices-of-one-pair, and the position book
 * audits the joint at the outpost place.
 */
export function quoteTrunk(h: TrunkHandoff): Offer | null {
  if (!h.atFrom || !h.atTo || h.slices.length === 0) return null;
  const backedBy = `${h.atFrom.id}+${h.atTo.id}`;
  return {
    id: `link:${h.from}->${h.to}`,
    kind: "link",
    steps: h.slices.map(s => ({
      backedBy,
      provides: { energyAt: { [h.to]: s.flow } },
      requires: { energyAt: { [h.from]: s.flow } },
      cost: { upfront: 0, upkeepEt: 0, feeEt: LINK_LOSS * s.flow, spawnTimeEt: 0 },
      note: `slice for ${s.sourceId}: ${s.flow.toFixed(1)} e/t at 3%`
    }))
  };
}

export function quoteLink(h: LinkHandoff): Offer | null {
  const { from, to, dist, flow } = h.gap;
  const throughput = Math.min(LINK_CAPACITY / Math.max(dist, 1), flow);
  if (throughput <= 0) return null;
  const missing = (h.atFrom ? 0 : 1) + (h.atTo ? 0 : 1);
  const capex = missing * LINK_COST;
  const standing = missing === 0;
  return {
    id: `link:${from}->${to}`,
    kind: "link",
    steps: [
      {
        backedBy: standing ? `${h.atFrom?.id ?? ""}+${h.atTo?.id ?? ""}` : undefined,
        provides: { energyAt: { [to]: throughput } },
        requires: { energyAt: { [from]: throughput } },
        cost: {
          upfront: capex,
          upkeepEt: 0,
          feeEt: LINK_LOSS * throughput + capex / HORIZON,
          spawnTimeEt: 0
        },
        note: standing
          ? `standing pair, ${throughput.toFixed(1)} e/t, 3% tax`
          : `build ${missing} link${missing > 1 ? "s" : ""} (${capex}e), then ${throughput.toFixed(1)} e/t at 3%`
      }
    ]
  };
}
