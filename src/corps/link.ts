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
import { HORIZON, LINK_CAPACITY, LINK_COST, LINK_LOSS, chebyshev } from "../primitives";
import { HaulGap } from "./haul";
import { Offer, PlaceId } from "../engine/vocabulary";
import { ViewLink, ViewWireOption } from "../engine/view";

export interface LinkHandoff {
  gap: HaulGap;
  /** Standing links at the gap's endpoints, if any. */
  atFrom: ViewLink | null;
  atTo: ViewLink | null;
  /** The placement search's priced option for this edge — the candidate
   * path. Absent = no legal wire exists (a room border, no free tiles). */
  wire?: ViewWireOption | null;
}

export interface TrunkSlice {
  sourceId: string;
  flow: number;
}

export interface TrunkHandoff {
  from: PlaceId;
  to: PlaceId;
  /** Per-source shares of the pair's capacity — one step each, so every
   * consolidated chain funds and pays for exactly its own share. */
  slices: TrunkSlice[];
  /** The LEGAL closest pair (linkPair's choice) — the trunk never wires
   * across a room border, whatever assembled first at the bank. */
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
  const { from, to, flow } = h.gap;

  // A STANDING pair: range from the actual tiles (Chebyshev — the wire
  // fires through walls), legal only within one room (owner 2026-08-24).
  if (h.atFrom && h.atTo) {
    if (h.atFrom.room !== h.atTo.room) return null;
    const range = Math.max(chebyshev(h.atFrom, h.atTo), 1);
    const throughput = Math.min(LINK_CAPACITY / range, flow);
    if (throughput <= 0) return null;
    return {
      id: `link:${from}->${to}`,
      kind: "link",
      steps: [
        {
          backedBy: `${h.atFrom.id}+${h.atTo.id}`,
          provides: { energyAt: { [to]: throughput } },
          requires: { energyAt: { [from]: throughput } },
          cost: { upfront: 0, upkeepEt: 0, feeEt: LINK_LOSS * throughput, spawnTimeEt: 0 },
          note: `standing pair, range ${range}, ${throughput.toFixed(1)} e/t, 3% tax`
        }
      ]
    };
  }

  // A CANDIDATE: priced from the placement search's station pair. No
  // legal option, no quote — the edge stays on bodies.
  if (!h.wire) return null;
  const candRange = Math.max(h.wire.range, 1);
  const candThroughput = Math.min(LINK_CAPACITY / candRange, flow);
  if (candThroughput <= 0) return null;
  const missing = (h.wire.missingMouth ? 1 : 0) + (h.wire.missingHub ? 1 : 0);
  if (missing === 0) return null;
  const capex = missing * LINK_COST;
  return {
    id: `link:${from}->${to}`,
    kind: "link",
    steps: [
      {
        provides: { energyAt: { [to]: candThroughput } },
        requires: { energyAt: { [from]: candThroughput } },
        cost: {
          upfront: capex,
          upkeepEt: 0,
          feeEt: LINK_LOSS * candThroughput + capex / HORIZON,
          spawnTimeEt: 0
        },
        note:
          `build ${missing} link${missing > 1 ? "s" : ""} (${capex}e) at range ${candRange}, ` +
          `then ${candThroughput.toFixed(1)} e/t at 3%`
      }
    ]
  };
}
