/**
 * corps/link.ts — transport by wire (REBOOT piece 5, owner 2026-08-18:
 * "the link corp provides hauling, essentially — just like the haul corp
 * does, but at different prices and constraints"). Links are their own
 * KIND, quoting the SAME gaps the haul corp quotes: fixed endpoints,
 * ~800/distance throughput, a 3% tax, zero spawn time — and they require
 * their structures standing.
 *
 * Pricing is piece 5's law made literal, AMENDED by Addendum 4 (ratified
 * 2026-08-24): a wire's marginal price is the tax PLUS its port anatomy —
 * the service the volley machine cannot run without. A STANDING pair
 * quotes that marginal and wins its edge stably; a CANDIDATE (one or
 * both ends missing) quotes FULL cost: the same, plus capex amortized
 * over HORIZON as feeEt and the raw capex as upfront. "Something changes
 * majorly" keeps its exact arithmetic meaning.
 *
 * The anatomy (v1 specs 26/45/54/56, quoted in REBOOT Addendum 4): a
 * haul-fed port is one machine — container (mouth), tender (throat),
 * link (pipe) — owned by this corp, because v1's standalone tender corp
 * lasted one commit and its ownerless buffer never drained. The THROAT
 * is a real body on the trunk's offer (step 0, zero capacity: it funds
 * with the first funded slice and charges once). The HUB-side service
 * (v1's per-sender shuttle) and the standing container's holding ride as
 * operating fees — fee-form until Tier 2's succession vocabulary turns
 * them into hires too (recorded; the porttender wedge, a body charged
 * but never spawned, is what that conversion must close).
 */
import {
  CONTAINER_HOLD_ET,
  HORIZON,
  LINK_CAPACITY,
  LINK_COST,
  LINK_LOSS,
  bodyCost,
  chebyshev,
  haulRate,
  spawnTimeEt,
  upkeepEt
} from "../primitives";
import { haulerBodyFor, hubServiceBody, portTenderBody } from "../sizing";
import { HaulGap } from "./haul";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep, ViewLink, ViewWireOption } from "../engine/view";

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
  /** Per-source WIRE shares of the pair's ration — one step each, so
   * every consolidated chain funds and pays for exactly its own share. */
  slices: TrunkSlice[];
  /** Per-source shares the ration cannot carry (Addendum 5, owner
   * 2026-08-24: "they could still bring all 30 to the outpost and the
   * link can hire a hauler for the excess") — the trunk's own OVERFLOW
   * haulers walk these from the port to the bank. Nobody sheds to a
   * direct route; the excess is a rate, not a member. */
  overflow: TrunkSlice[];
  /** WALKING route cost from the outpost to the bank — what the
   * overflow bodies pay (the wire's Chebyshev range prices only the
   * ration). */
  distToBank: number;
  /** The overflow corridor is paved — bodies run the roaded gait. */
  roaded: boolean;
  bodyBudget: number;
  /** The LEGAL closest pair (linkPair's choice) — the trunk never wires
   * across a room border, whatever assembled first at the bank. */
  atFrom: ViewLink | null;
  atTo: ViewLink | null;
  /** A buffer container stands at the outpost — the port's MOUTH (spec
   * 56's one range-2 lens, assembled as one flag). Its holding cost
   * rides the trunk's fee only while it stands. */
  container: boolean;
  /** Handed assets: the corp's own service creeps — the throat and its
   * overflow haulers. */
  creeps: ViewCreep[];
}

export interface TrunkQuote {
  offer: Offer;
  /** Stage options per member source — the throat (zero capacity), the
   * member's wire share, its overflow bodies — as indices into the
   * offer's steps. ONE source of truth for which steps serve which
   * member's chain; a broker-side re-derivation of the layout would be
   * a second lens on this offer's shape. */
  memberSteps: Record<string, { step: number; capacity: number }[]>;
}

/**
 * The consolidation trunk (owner 2026-08-23: "consolidate multiple haul
 * routes into one link outpost"): ONE standing pair quoted as its THROAT
 * (step 0 — the port tender, this corp's own body), one WIRE step per
 * assigned source priced at the tax on its share, and — when the ration
 * binds — the corp's own OVERFLOW haulers walking the excess to the
 * bank (Addendum 5: the excess is a rate, not a member; nobody sheds).
 * The position book audits the joint at the outpost place either way:
 * collectors deliver everything there, and the trunk moves everything
 * out, by wire at the tax or by body at the walk. Every member chain
 * references step 0 at zero capacity, so the throat funds with
 * whichever member funds first and the market charges it once.
 */
export function quoteTrunk(h: TrunkHandoff): TrunkQuote | null {
  if (!h.atFrom || !h.atTo || h.slices.length + h.overflow.length === 0) return null;
  const backedBy = `${h.atFrom.id}+${h.atTo.id}`;
  const wireFlow = h.slices.reduce((a, s) => a + s.flow, 0);
  // The throat serves the WIRE: it tops the link with what fires; the
  // overflow bypasses the pipe entirely (container -> body -> bank).
  const tender = portTenderBody(wireFlow);
  const serviceFee = upkeepEt(hubServiceBody()) + (h.container ? CONTAINER_HOLD_ET : 0);
  // Handed assets: the throat re-hands by SHAPE (exact tender shape
  // first, then any parked work-less 1-MOVE body); every other creep is
  // an overflow hauler, assigned to shares in id order — the excess is
  // fungible, so which hauler serves which member's share is
  // bookkeeping, deterministic within a replan.
  const byId = [...h.creeps].sort((a, b) => (a.id < b.id ? -1 : 1));
  const throatLive =
    byId.find(c => c.body.work === tender.work && c.body.carry === tender.carry && c.body.move === tender.move) ??
    byId.find(c => c.body.work === 0 && c.body.move === 1);
  const haulers = byId.filter(c => c !== throatLive);
  // Every trunk body COMMUTES the corridor (Addendum 6, corrected: a
  // hauler's posting is its PICKUP — "the haulers should start at the
  // source"): the throat walks out once and parks; the overflow haulers
  // start at the port and pay the same walk as a time-to-live penalty.
  const throat: Step = throatLive
    ? {
        backedBy: throatLive.id,
        body: throatLive.body,
        commute: h.distToBank,
        provides: {},
        requires: {},
        cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0, feeEt: serviceFee },
        note: `throat alive ttl=${throatLive.ttl}; hub service${h.container ? " + buffer hold" : ""} as fees`
      }
    : {
        body: tender,
        commute: h.distToBank,
        provides: {},
        requires: {},
        cost: {
          upfront: bodyCost(tender),
          upkeepEt: upkeepEt(tender, h.distToBank),
          spawnTimeEt: spawnTimeEt(tender, h.distToBank),
          feeEt: serviceFee
        },
        note: `throat ${tender.carry}C parked at the port; hub service${h.container ? " + buffer hold" : ""} as fees`
      };
  const steps: Step[] = [throat];
  const memberSteps: TrunkQuote["memberSteps"] = {};
  const memberOf = (sourceId: string): { step: number; capacity: number }[] =>
    memberSteps[sourceId] ?? (memberSteps[sourceId] = [{ step: 0, capacity: 0 }]);
  for (const s of h.slices) {
    memberOf(s.sourceId).push({ step: steps.length, capacity: s.flow });
    steps.push({
      backedBy,
      provides: { energyAt: { [h.to]: s.flow } },
      requires: { energyAt: { [h.from]: s.flow } },
      cost: { upfront: 0, upkeepEt: 0, feeEt: LINK_LOSS * s.flow, spawnTimeEt: 0 },
      note: `slice for ${s.sourceId}: ${s.flow.toFixed(1)} e/t at 3%`
    });
  }
  // Overflow bodies: live haulers first, then marginal bodies sized to
  // the share still uncovered (#148's law at the quote, like haul's own
  // loop). NOT link-fed: they load at the port's buffer and unload at
  // the bank, which has no landing quantum.
  let nextHauler = 0;
  for (const s of h.overflow) {
    let cum = 0;
    while (cum < s.flow - 1e-9) {
      const live = haulers[nextHauler];
      if (live) {
        nextHauler += 1;
        const liveRate = haulRate(live.body.carry, h.distToBank);
        if (liveRate <= 0) continue;
        cum += liveRate;
        memberOf(s.sourceId).push({ step: steps.length, capacity: liveRate });
        steps.push({
          backedBy: live.id,
          body: live.body,
          commute: h.distToBank,
          provides: { energyAt: { [h.to]: liveRate } },
          requires: { energyAt: { [h.from]: liveRate } },
          cost: { upfront: 0, upkeepEt: 0, spawnTimeEt: 0 },
          note: `overflow alive ttl=${live.ttl}`
        });
        continue;
      }
      const body = haulerBodyFor(s.flow - cum, h.distToBank, h.bodyBudget, h.roaded);
      if (!body) break;
      const rate = haulRate(body.carry, h.distToBank);
      if (rate <= 0) break;
      cum += rate;
      memberOf(s.sourceId).push({ step: steps.length, capacity: rate });
      steps.push({
        body,
        commute: h.distToBank,
        provides: { energyAt: { [h.to]: rate } },
        requires: { energyAt: { [h.from]: rate } },
        cost: {
          upfront: bodyCost(body),
          upkeepEt: upkeepEt(body, h.distToBank),
          spawnTimeEt: spawnTimeEt(body, h.distToBank)
        },
        note: `overflow ${body.carry}C over ${h.distToBank} tiles for ${s.sourceId}`
      });
    }
  }
  return { offer: { id: `link:${h.from}->${h.to}`, kind: "link", steps }, memberSteps };
}

export function quoteLink(h: LinkHandoff): Offer | null {
  const { from, to, flow } = h.gap;
  // The hub-side service, per sender (v1's concurrency law): every wire
  // employs one shuttle's worth at the bank. A direct mouth wire is
  // MINER-fed, so it carries no throat and no container — Addendum 4's
  // trigger rule: the full anatomy is for haul-fed ports only.
  const hubFee = upkeepEt(hubServiceBody());

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
          cost: { upfront: 0, upkeepEt: 0, feeEt: LINK_LOSS * throughput + hubFee, spawnTimeEt: 0 },
          note: `standing pair, range ${range}, ${throughput.toFixed(1)} e/t, 3% tax + hub service`
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
          feeEt: LINK_LOSS * candThroughput + capex / HORIZON + hubFee,
          spawnTimeEt: 0
        },
        note:
          `build ${missing} link${missing > 1 ? "s" : ""} (${capex}e) at range ${candRange}, ` +
          `then ${candThroughput.toFixed(1)} e/t at 3% + hub service`
      }
    ]
  };
}
