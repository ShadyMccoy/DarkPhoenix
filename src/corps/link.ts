import {
  CONTAINER_COST,
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
import { hireStep, liveStep } from "./steps";
import { HaulGap } from "./haul";
import { ChainCandidate, StageOption } from "../engine/market";
import { Offer, PlaceId, Step } from "../engine/vocabulary";
import { ViewCreep, ViewLink, ViewOutpost, ViewWireOption } from "../engine/view";

export interface LinkHandoff {
  gap: HaulGap;
  atFrom: ViewLink | null;
  atTo: ViewLink | null;
  wire?: ViewWireOption | null;
}

export interface TrunkSlice {
  sourceId: string;
  flow: number;
}

export interface TrunkHandoff {
  from: PlaceId;
  to: PlaceId;
  slices: TrunkSlice[];
  overflow: TrunkSlice[];
  distToBank: number;
  roaded: boolean;
  bodyBudget: number;
  atFrom: ViewLink | null;
  atTo: ViewLink | null;
  container: boolean;
  creeps: ViewCreep[];
}

export interface TrunkQuote {
  offer: Offer;
  memberSteps: Record<string, { step: number; capacity: number }[]>;
}

export function quoteTrunk(h: TrunkHandoff): TrunkQuote | null {
  if (!h.atFrom || !h.atTo || h.slices.length + h.overflow.length === 0) return null;
  const backedBy = `${h.atFrom.id}+${h.atTo.id}`;
  const wireFlow = h.slices.reduce((a, s) => a + s.flow, 0);
  const tender = portTenderBody(wireFlow);
  const serviceFee = upkeepEt(hubServiceBody()) + (h.container ? CONTAINER_HOLD_ET : 0);
  const byId = [...h.creeps].sort((a, b) => (a.id < b.id ? -1 : 1));
  const throatLive =
    byId.find(c => c.body.work === tender.work && c.body.carry === tender.carry && c.body.move === tender.move) ??
    byId.find(c => c.body.work === 0 && c.body.move === 1);
  const haulers = byId.filter(c => c !== throatLive);
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
        steps.push(
          liveStep(
            live,
            h.distToBank,
            { energyAt: { [h.to]: liveRate } },
            { energyAt: { [h.from]: liveRate } },
            `overflow alive ttl=${live.ttl}`
          )
        );
        continue;
      }
      const body = haulerBodyFor(s.flow - cum, h.distToBank, h.bodyBudget, h.roaded);
      if (!body) break;
      const rate = haulRate(body.carry, h.distToBank);
      if (rate <= 0) break;
      cum += rate;
      memberOf(s.sourceId).push({ step: steps.length, capacity: rate });
      steps.push(
        hireStep(
          body,
          h.distToBank,
          { energyAt: { [h.to]: rate } },
          { energyAt: { [h.from]: rate } },
          `overflow ${body.carry}C over ${h.distToBank} tiles for ${s.sourceId}`
        )
      );
    }
  }
  return { offer: { id: `link:${h.from}->${h.to}`, kind: "link", steps }, memberSteps };
}

export function quoteLink(h: LinkHandoff): Offer | null {
  const { from, to, flow } = h.gap;
  const hubFee = upkeepEt(hubServiceBody());

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

export function stationAnatomyEt(flow: number): number {
  return upkeepEt(portTenderBody(flow)) + upkeepEt(hubServiceBody()) + CONTAINER_HOLD_ET + CONTAINER_COST / HORIZON;
}

export interface TrunkMember {
  srcId: string;
  mineOptions: StageOption[];
  supply: number;
  distToBank: number;
}

export interface TrunkBroker {
  bank: PlaceId;
  outposts: ViewOutpost[];
  bodyBudget: number;
  haulUnit(dist: number): number;
  book(gap: HaulGap, commute: number): StageOption[];
  pair(from: PlaceId, to: PlaceId): { atFrom: ViewLink; atTo: ViewLink } | null;
  roaded(from: PlaceId, to: PlaceId): boolean;
  creeps(corpId: string): ViewCreep[];
}

export interface TrunkPlanResult {
  viaSeated: Set<string>;
  chains: ChainCandidate[];
  commutes: Map<string, number>;
  buffers: Map<string, PlaceId>;
}

interface TrunkPlan {
  place: PlaceId;
  pair: { atFrom: ViewLink; atTo: ViewLink };
  slices: TrunkSlice[];
  overflow: TrunkSlice[];
  distToBank: number;
  remaining: number;
}

export function planTrunks(b: TrunkBroker, members: TrunkMember[]): TrunkPlanResult {
  const trunks = new Map<PlaceId, TrunkPlan>();
  const trunkFor = (place: PlaceId): TrunkPlan | null => {
    const pair = b.pair(place, b.bank);
    const op = b.outposts.find(o => o.place === place);
    if (!pair || !op) return null;
    const range = Math.max(chebyshev(pair.atFrom, pair.atTo), 1);
    return { place, pair, slices: [], overflow: [], distToBank: op.distToBank, remaining: LINK_CAPACITY / range };
  };

  interface ViaOption {
    outpostPlace: PlaceId;
    dSrc: number;
    saving: number;
  }
  interface ViaCandidate {
    srcId: string;
    mineOptions: StageOption[];
    supply: number;
    directDist: number;
    options: ViaOption[];
  }
  const viaCandidates: ViaCandidate[] = [];
  for (const m of members) {
    const directUnit = b.haulUnit(m.distToBank);
    const directWire = b.pair(m.srcId, b.bank);
    const options: ViaOption[] = [];
    for (const op of directWire ? [] : b.outposts) {
      const dSrc = op.distToSource[m.srcId];
      if (dSrc === undefined) continue;
      if (!trunks.has(op.place)) {
        const t = trunkFor(op.place);
        if (t) trunks.set(op.place, t);
      }
      if (!trunks.has(op.place)) continue;
      const saving = directUnit - (b.haulUnit(dSrc) + LINK_LOSS);
      if (saving > 1e-9) options.push({ outpostPlace: op.place, dSrc, saving });
    }
    if (options.length > 0) {
      options.sort((x, y) => y.saving - x.saving || (x.outpostPlace < y.outpostPlace ? -1 : 1));
      viaCandidates.push({
        srcId: m.srcId,
        mineOptions: m.mineOptions,
        supply: m.supply,
        directDist: m.distToBank,
        options
      });
    }
  }

  viaCandidates.sort(
    (a, c) => c.options[0].saving * c.supply - a.options[0].saving * a.supply || (a.srcId < c.srcId ? -1 : 1)
  );
  const viaSeated = new Set<string>();
  interface PendingVia {
    srcId: string;
    mineOptions: StageOption[];
    collector: StageOption[];
    outpostPlace: PlaceId;
  }
  const pendingVia: PendingVia[] = [];
  for (const c of viaCandidates) {
    const directUnit = b.haulUnit(c.directDist);
    for (const o of c.options) {
      const t = trunks.get(o.outpostPlace);
      if (!t) continue;
      const wireShare = Math.min(c.supply, Math.max(t.remaining, 0));
      const spill = c.supply - wireShare;
      const gain = wireShare * o.saving + spill * (directUnit - b.haulUnit(o.dSrc) - b.haulUnit(t.distToBank));
      if (gain <= 1e-9) continue;
      const collector = b.book(
        { from: c.srcId, to: o.outpostPlace, dist: o.dSrc, flow: c.supply, linkFed: true },
        c.directDist
      );
      if (collector.length === 0) continue;
      viaSeated.add(c.srcId);
      pendingVia.push({ srcId: c.srcId, mineOptions: c.mineOptions, collector, outpostPlace: o.outpostPlace });
      if (wireShare > 1e-9) t.slices.push({ sourceId: c.srcId, flow: wireShare });
      if (spill > 1e-9) t.overflow.push({ sourceId: c.srcId, flow: spill });
      t.remaining -= wireShare;
      break;
    }
  }

  const chains: ChainCandidate[] = [];
  const commutes = new Map<string, number>();
  const buffers = new Map<string, PlaceId>();
  for (const t of trunks.values()) {
    const id = `link:${t.place}->${b.bank}`;
    commutes.set(id, t.distToBank);
    const hasContainer = b.outposts.find(o => o.place === t.place)?.hasContainer ?? false;
    const q = quoteTrunk({
      from: t.place,
      to: b.bank,
      slices: t.slices,
      overflow: t.overflow,
      distToBank: t.distToBank,
      roaded: b.roaded(t.place, b.bank),
      bodyBudget: b.bodyBudget,
      atFrom: t.pair.atFrom,
      atTo: t.pair.atTo,
      container: hasContainer,
      creeps: b.creeps(id)
    });
    if (!q) continue;
    if (!hasContainer) buffers.set(id, t.place);
    for (const v of pendingVia) {
      if (v.outpostPlace !== t.place) continue;
      const member = q.memberSteps[v.srcId];
      if (!member) continue;
      chains.push({
        id: `chain:${v.srcId}:via`,
        sourceId: v.srcId,
        stages: [
          { options: v.mineOptions },
          { options: v.collector },
          { options: member.map(m => ({ offer: q.offer, step: m.step, capacity: m.capacity })) }
        ]
      });
    }
  }
  return { viaSeated, chains, commutes, buffers };
}
