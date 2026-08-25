import {
  CONTAINER_COST,
  EXTENSION_CAPACITY,
  EXTENSION_COST,
  HORIZON,
  LINK_CAPACITY,
  LINK_COST,
  LINK_LOSS,
  ROAD_COST_PER_TILE,
  ROAD_UPKEEP_ET_PER_TILE,
  SOURCE_RATE,
  SPAWN_RATE,
  STORAGE_COST,
  branchHoldingEt,
  chebyshev,
  haulRate,
  reachableStock,
  spawnTimeEt,
  upkeepEt
} from "../primitives";
import { haulFleetBillEt, haulerBody } from "../sizing";
import { quoteBuild } from "../corps/build";
import { HaulGap, quoteHaul } from "../corps/haul";
import { TrunkMember, planTrunks, quoteLink, stationAnatomyEt } from "../corps/link";
import { quoteMine } from "../corps/mine";
import { ESTATE_CORP, quoteTender, tenderCapacities } from "../corps/spawning";
import { quoteUpgrade } from "../corps/upgrade";
import { quoteWorkman } from "../corps/workman";
import { ChainCandidate, ChainStage, SinkChain, StageOption, clear } from "./market";
import { EconomyView, ViewCreep, ViewLink } from "./view";
import { Approval, EnginePlan, FrontierLine, Offer, PlaceId, StructureKind, stepBillEt } from "./vocabulary";

function assigned(view: EconomyView, corpId: string): ViewCreep[] {
  return view.creeps.filter(c => c.corp === corpId);
}

function linkPair(view: EconomyView, from: PlaceId, to: PlaceId): { atFrom: ViewLink; atTo: ViewLink } | null {
  let best: { atFrom: ViewLink; atTo: ViewLink; range: number } | null = null;
  for (const a of view.links) {
    if (a.at !== from) continue;
    for (const b of view.links) {
      if (b.at !== to || a.room !== b.room) continue;
      const range = Math.max(chebyshev(a, b), 1);
      if (!best || range < best.range) best = { atFrom: a, atTo: b, range };
    }
  }
  return best ? { atFrom: best.atFrom, atTo: best.atTo } : null;
}

function optionsAt(offer: Offer, place: PlaceId): StageOption[] {
  return offer.steps.map((s, i) => ({ offer, step: i, capacity: s.provides.energyAt?.[place] ?? 0 }));
}

function assembleAndClear(
  view: EconomyView,
  warchestTarget: number
): { plan: EnginePlan; gaps: Map<string, HaulGap>; trunkBuffers: Map<string, PlaceId> } {
  const productionStaffed = view.creeps.some(c => c.corp !== ESTATE_CORP);
  const budget = productionStaffed ? view.bodyBudget : Math.min(view.bodyBudget, Math.max(view.bankStock, 300));

  const gapByOffer = new Map<string, HaulGap>();

  const commuteByCorp = new Map<string, number>();

  const isRoaded = (from: PlaceId, to: PlaceId): boolean => view.roads.some(r => r.from === from && r.to === to);
  const transportBook = (gap: HaulGap, commute = 0): StageOption[] => {
    const g: HaulGap = { ...gap, roaded: isRoaded(gap.from, gap.to) };
    gapByOffer.set(`haul:${g.from}->${g.to}`, g);
    commuteByCorp.set(`haul:${g.from}->${g.to}`, commute);
    const options: StageOption[] = [];
    const haul = quoteHaul({
      gap: g,
      bank: view.bank,
      bodyBudget: budget,
      commute,
      creeps: assigned(view, `haul:${g.from}->${g.to}`)
    });
    if (haul) options.push(...optionsAt(haul, g.to));
    const pair = linkPair(view, g.from, g.to);
    const link = pair ? quoteLink({ gap: g, atFrom: pair.atFrom, atTo: pair.atTo }) : null;
    if (link && link.steps[0].backedBy) options.push(...optionsAt(link, g.to));

    const steadyUnit = (o: StageOption): number => {
      const bill = stepBillEt(o.offer.steps[o.step]);
      return o.capacity > 1e-9 ? bill / o.capacity : Infinity;
    };
    options.sort((a, b) => {
      const d: number = steadyUnit(a) - steadyUnit(b);
      if (Math.abs(d) > 1e-9) return d;
      const backedA = a.offer.steps[a.step].backedBy ? 0 : 1;
      const backedB = b.offer.steps[b.step].backedBy ? 0 : 1;
      if (backedA !== backedB) return backedA - backedB;
      if (a.offer.id !== b.offer.id) return a.offer.id < b.offer.id ? -1 : 1;
      return a.step - b.step;
    });
    return options;
  };

  const haulUnit = (dist: number): number => {
    const body = haulerBody(budget);
    if (!body) return Infinity;
    return upkeepEt(body) / haulRate(body.carry, dist);
  };

  const chains: ChainCandidate[] = [];
  const directChain = (srcId: string, mineOptions: StageOption[], distToBank: number, supply: number): void => {
    const book = transportBook({ from: srcId, to: view.bank, dist: distToBank, flow: supply }, distToBank);
    if (book.length > 0) {
      chains.push({
        id: `chain:${srcId}:specialist`,
        sourceId: srcId,
        stages: [{ options: mineOptions }, { options: book }]
      });
    }
  };
  interface SrcRecord {
    srcId: string;
    mineOptions: StageOption[] | null;
    supply: number;
    distToBank: number;
    workman: Offer | null;
  }
  const srcRecords: SrcRecord[] = [];
  const sourceCaps: Record<string, number> = {};
  for (const src of view.sources) {
    sourceCaps[src.id] = SOURCE_RATE;

    commuteByCorp.set(`mine:${src.id}`, src.distToBank);
    commuteByCorp.set(`workman:${src.id}`, src.distToBank);
    const mine = quoteMine({
      sourceId: src.id,
      spots: src.spots,
      bank: view.bank,
      bodyBudget: budget,
      commute: src.distToBank,
      creeps: assigned(view, `mine:${src.id}`)
    });
    const workman = quoteWorkman({
      sourceId: src.id,
      spots: src.spots,
      bank: view.bank,
      distToBank: src.distToBank,
      bodyBudget: budget,
      creeps: assigned(view, `workman:${src.id}`)
    });
    const mineOptions = mine ? optionsAt(mine, src.id) : null;
    const supply = mineOptions ? mineOptions.reduce((a, o) => a + o.capacity, 0) : 0;
    srcRecords.push({ srcId: src.id, mineOptions, supply, distToBank: src.distToBank, workman });
  }

  const trunkMembers: TrunkMember[] = [];
  for (const r of srcRecords) {
    if (r.mineOptions) {
      trunkMembers.push({ srcId: r.srcId, mineOptions: r.mineOptions, supply: r.supply, distToBank: r.distToBank });
    }
  }
  const trunkPlanning = planTrunks(
    {
      bank: view.bank,
      outposts: view.outposts,
      bodyBudget: budget,
      haulUnit,
      book: transportBook,
      pair: (from, to) => linkPair(view, from, to),
      roaded: isRoaded,
      creeps: id => assigned(view, id)
    },
    trunkMembers
  );

  for (const r of srcRecords) {
    if (r.mineOptions && !trunkPlanning.viaSeated.has(r.srcId)) {
      directChain(r.srcId, r.mineOptions, r.distToBank, r.supply);
    }
    if (r.workman) {
      chains.push({
        id: `chain:${r.srcId}:workman`,
        sourceId: r.srcId,
        stages: [{ options: optionsAt(r.workman, view.bank) }]
      });
    }
  }
  chains.push(...trunkPlanning.chains);
  trunkPlanning.commutes.forEach((walk, id) => commuteByCorp.set(id, walk));

  const sinks: SinkChain[] = [];
  const sinkFor = (offer: Offer | null, at: PlaceId, dist: number, capital: boolean): void => {
    if (!offer) return;
    const burnOptions: StageOption[] = offer.steps.map((s, i) => ({
      offer,
      step: i,
      capacity: s.requires.energyAt?.[at] ?? 0
    }));
    const demand = burnOptions.reduce((a, o) => a + o.capacity, 0);
    const stages: ChainStage[] = [];
    if (at !== view.bank) {
      const book = transportBook({ from: view.bank, to: at, dist, flow: demand });
      if (book.length > 0) stages.push({ options: book });
    }
    stages.push({ options: burnOptions });
    sinks.push(capital ? { stages, capital } : { stages });
  };
  for (const site of view.sites) {
    commuteByCorp.set(`build:${site.id}`, site.dist);
    sinkFor(
      quoteBuild({
        siteId: site.id,
        at: site.at,
        total: site.total,
        remaining: site.remaining,
        bodyBudget: budget,
        commute: site.dist,
        creeps: assigned(view, `build:${site.id}`)
      }),
      site.at,
      site.dist,
      true
    );
  }
  if (view.controller) {
    const ctrl = view.controller;
    const feed = ctrl.distFromBank > 1 ? ctrl.id : view.bank;
    commuteByCorp.set(`upgrade:${ctrl.id}`, ctrl.distFromBank);
    sinkFor(
      quoteUpgrade({
        controllerId: ctrl.id,
        feed,
        bodyBudget: budget,
        maxBurn: view.sources.length * SOURCE_RATE,
        commute: ctrl.distFromBank,
        creeps: assigned(view, `upgrade:${ctrl.id}`)
      }),
      feed,
      ctrl.distFromBank,
      false
    );
  }

  const spawnCapacity = view.spawnIds.length * SPAWN_RATE;

  const standingBills = view.creeps.reduce((sum, c) => sum + upkeepEt(c.body, commuteByCorp.get(c.corp) ?? 0), 0);
  const standingSpawnEt = view.creeps.reduce((sum, c) => sum + spawnTimeEt(c.body, commuteByCorp.get(c.corp) ?? 0), 0);

  const tenderCreeps = assigned(view, ESTATE_CORP);
  const tenderOffer = quoteTender({
    bank: view.bank,
    estateRadius: view.estateRadius,
    bodyBudget: budget,
    obligationEt: view.sources.length * SOURCE_RATE + standingBills,
    creeps: tenderCreeps
  });

  const plan = clear({
    tick: view.tick,
    bank: view.bank,
    chains,
    sinks,
    spawnCapacity,
    bankStock: view.bankStock,
    sourceCaps,
    standingBills,
    standingSpawnEt,
    holdingEt:
      branchHoldingEt(view.bankBranch, view.bankStock, view.bodyBudget) +
      view.roads.reduce((sum, r) => sum + r.dist * ROAD_UPKEEP_ET_PER_TILE, 0),
    warchestTarget,
    tender: tenderOffer ? { offer: tenderOffer, capacities: tenderCapacities(tenderOffer, view.estateRadius) } : null
  });
  return { plan, gaps: gapByOffer, trunkBuffers: trunkPlanning.buffers };
}

export function replan(view: EconomyView): EnginePlan {
  const committed = view.sites.reduce((sum, s) => sum + s.remaining, 0);
  const { plan: base, gaps: gapByOffer, trunkBuffers } = assembleAndClear(view, committed);

  const approvals: Approval[] = [];
  const awaiting: FrontierLine[] = [];
  let awaitingCapex = 0;
  const paidHubRooms = new Set<string>();
  const linkBudget = view.linkBudget ?? Infinity;
  let linksUsed =
    view.links.length +
    view.sites.filter(k => k.structure === "link").reduce((n, k) => n + Math.round(k.total / LINK_COST), 0);
  let spendable = view.bankStock - committed;

  const stream = base.expected.upgradeEt + base.expected.warchestEt + base.expected.holdingEt;
  const reach = reachableStock(view.bankBranch, stream, view.bodyBudget);
  const noteAwaiting = (offerId: string, capex: number, detail: string): void => {
    if (committed + awaitingCapex + capex > reach + 1e-9) {
      awaiting.push({
        offerId,
        reason: "capex unreachable",
        detail: `${capex}e capex beyond this ${view.bankBranch} branch's ~${Math.round(reach)}e ceiling — ${detail}`
      });
    } else {
      awaiting.push({
        offerId,
        reason: "awaiting stock",
        detail: `${capex}e capex, ${Math.max(spendable, 0).toFixed(0)}e spendable — ${detail}`
      });
      awaitingCapex += capex;
    }
  };
  const isSitePlace = (p: PlaceId): boolean => p !== view.bank && view.sites.some(s => s.at === p);
  const siteEdges = new Set<string>();
  for (const s of view.sites) if (s.edge) siteEdges.add(`${s.edge.from}->${s.edge.to}`);
  interface Proposal {
    structure: StructureKind;
    at: PlaceId;
    edge?: { from: PlaceId; to: PlaceId };
    offerId: string;
    savingEt: number;
    capex: number;
    links: number;
    hubLinks: number;
    hubRoom?: string;
    detail: string;
  }
  const proposals: Proposal[] = [];

  for (const corp of base.corps) {
    if (corp.kind !== "haul") continue;
    const gap = gapByOffer.get(corp.id);
    if (!gap || corp.pnl.grossEt <= 1e-9) continue;
    if (isSitePlace(gap.from) || isSitePlace(gap.to)) continue;
    if (siteEdges.has(`${gap.from}->${gap.to}`)) continue;
    const pickupWalk = gap.from === view.bank ? 0 : view.sources.find(k => k.id === gap.from)?.distToBank ?? gap.dist;
    const replacementBill = haulFleetBillEt(corp.pnl.grossEt, gap.dist, gap.roaded ?? false, pickupWalk);
    const incumbentUnit = replacementBill / corp.pnl.grossEt;

    const wireOpt = view.wireOptions.find(w => w.from === gap.from && w.to === gap.to) ?? null;
    const standingPair = linkPair(view, gap.from, gap.to);
    const cand = quoteLink({
      gap: { from: gap.from, to: gap.to, dist: gap.dist, flow: corp.pnl.grossEt },
      atFrom: standingPair?.atFrom ?? null,
      atTo: standingPair?.atTo ?? null,
      wire: wireOpt
    });
    const st = cand && !cand.steps[0].backedBy ? cand.steps[0] : null;
    const throughput = st?.provides.energyAt?.[gap.to] ?? 0;
    const candUnit = st && throughput > 1e-9 ? stepBillEt(st) / throughput : Infinity;
    if (cand && st && candUnit + 1e-9 < incumbentUnit) {
      const capex = st.cost.upfront;
      proposals.push({
        structure: "link",
        at: gap.from,
        edge: { from: gap.from, to: gap.to },
        offerId: cand.id,
        savingEt: (incumbentUnit - candUnit) * corp.pnl.grossEt,
        capex,
        links: Math.round(capex / LINK_COST),
        hubLinks: wireOpt?.missingHub ? 1 : 0,
        hubRoom: wireOpt?.hubRoom,
        detail:
          `link ${candUnit.toFixed(4)}/unit beats bodies ${incumbentUnit.toFixed(4)}/unit ` +
          `on ${gap.from}->${gap.to} (${corp.pnl.grossEt.toFixed(1)} e/t, range ${wireOpt?.range ?? 0})`
      });
      continue;
    }

    if (!gap.roaded) {
      const roadedBill = haulFleetBillEt(corp.pnl.grossEt, gap.dist, true, pickupWalk);
      const saving = replacementBill - roadedBill - gap.dist * ROAD_UPKEEP_ET_PER_TILE;
      const capex = gap.dist * ROAD_COST_PER_TILE;
      if (saving * HORIZON > capex) {
        proposals.push({
          structure: "road",
          at: gap.from,
          edge: { from: gap.from, to: gap.to },
          offerId: `road:${gap.from}->${gap.to}`,
          savingEt: saving - capex / HORIZON,
          capex,
          links: 0,
          hubLinks: 0,
          detail:
            `paving ${gap.from}->${gap.to} (${gap.dist} tiles) saves ${saving.toFixed(3)} e/t of fleet: ` +
            `${(saving * HORIZON).toFixed(0)}e over H beats ${capex}e capex`
        });
      }
    }
  }

  for (const st of view.stationOptions) {
    if (siteEdges.has(`${st.id}->bank`)) continue;
    const members = st.sources
      .map(m => ({ m, corp: base.corps.find(c => c.id === `haul:${m.id}->bank`) }))
      .filter(x => x.corp && x.corp.pnl.grossEt > 1e-9);
    if (members.length === 0) continue;
    const linksNeeded = 1 + (st.missingHub ? 1 : 0);
    const capex = linksNeeded * LINK_COST;
    let flow = 0;
    let saving = -capex / HORIZON;
    for (const x of members) {
      const gap = gapByOffer.get(x.corp!.id);
      const gross = x.corp!.pnl.grossEt;
      const memberWalk = view.sources.find(k => k.id === x.m.id)?.distToBank ?? gap?.dist ?? 50;
      flow += gross;
      saving +=
        haulFleetBillEt(gross, gap?.dist ?? 50, gap?.roaded ?? false, memberWalk) -
        haulFleetBillEt(gross, x.m.collectRange, false, memberWalk) -
        LINK_LOSS * gross;
    }
    saving -= stationAnatomyEt(flow);
    if (LINK_CAPACITY / Math.max(st.range, 1) + 1e-9 < flow) continue;
    if (saving <= 0) continue;
    proposals.push({
      structure: "link",
      at: st.id,
      edge: { from: st.id, to: "bank" },
      offerId: st.id,
      savingEt: saving,
      capex,
      links: linksNeeded,
      hubLinks: st.missingHub ? 1 : 0,
      hubRoom: st.hubRoom,
      detail:
        `${st.id} collects ${members.map(x => x.m.id).join("+")} (${flow.toFixed(0)} e/t, range ${st.range}): ` +
        `saves ${saving.toFixed(3)} e/t over the direct fleets`
    });
  }

  if (!view.sites.some(k => k.structure === "extension")) {
    const cf = assembleAndClear({ ...view, bodyBudget: view.bodyBudget + EXTENSION_CAPACITY }, committed).plan;
    const delta = cf.expected.upgradeEt - base.expected.upgradeEt;
    if (delta * HORIZON > EXTENSION_COST) {
      proposals.push({
        structure: "extension",
        at: view.bank,
        offerId: "extension:estate",
        savingEt: delta - EXTENSION_COST / HORIZON,
        capex: EXTENSION_COST,
        links: 0,
        hubLinks: 0,
        detail:
          `+${EXTENSION_CAPACITY}e budget adds ${delta.toFixed(3)} CP/t: ` +
          `${(delta * HORIZON).toFixed(0)}e over H beats ${EXTENSION_COST}e capex`
      });
    }
  }

  if (!view.sites.some(k => k.structure === "container" || k.structure === "storage")) {
    const rung =
      view.bankBranch === "pile"
        ? {
            structure: "container" as const,
            capex: CONTAINER_COST,
            after: branchHoldingEt("container", view.bankStock, view.bodyBudget)
          }
        : view.bankBranch === "container"
        ? { structure: "storage" as const, capex: STORAGE_COST, after: 0 }
        : null;
    if (rung) {
      const branchNow = branchHoldingEt(view.bankBranch, view.bankStock, view.bodyBudget);
      const saving = branchNow - rung.after;
      if (saving * HORIZON > rung.capex) {
        proposals.push({
          structure: rung.structure,
          at: view.bank,
          offerId: `${rung.structure}:bank`,
          savingEt: saving - rung.capex / HORIZON,
          capex: rung.capex,
          links: 0,
          hubLinks: 0,
          detail:
            `${rung.structure} saves ${saving.toFixed(2)} e/t of holding: ` +
            `${(saving * HORIZON).toFixed(0)}e over H beats ${rung.capex}e capex`
        });
      }
    }
  }

  for (const corp of base.corps) {
    if (corp.kind !== "link") continue;
    const at = trunkBuffers.get(corp.id);
    if (!at) continue;
    if (view.sites.some(k => k.structure === "container" && k.edge && k.edge.from === at)) continue;
    if (CONTAINER_COST <= spendable + 1e-9) {
      spendable -= CONTAINER_COST;
      approvals.push({
        structure: "container",
        at,
        edge: { from: at, to: at },
        capex: CONTAINER_COST,
        detail: `port buffer at ${at}: the trunk's arrival space (haul-fed — the anatomy's trigger)`
      });
    } else {
      noteAwaiting(corp.id, CONTAINER_COST, `port buffer at ${at}`);
    }
  }

  proposals.sort((a, b) => b.savingEt / b.capex - a.savingEt / a.capex || a.offerId.localeCompare(b.offerId));
  for (const prop of proposals) {
    let capex = prop.capex;
    let links = prop.links;
    if (prop.hubLinks > 0 && paidHubRooms.has(prop.hubRoom ?? "")) {
      capex -= prop.hubLinks * LINK_COST;
      links -= prop.hubLinks;
    }
    if (links > 0 && linksUsed + links > linkBudget) {
      awaiting.push({
        offerId: prop.offerId,
        reason: "link budget",
        detail: `${links} link(s) wanted, ${Math.max(linkBudget - linksUsed, 0)} of ${linkBudget} left — ${prop.detail}`
      });
      continue;
    }
    if (capex <= spendable + 1e-9) {
      spendable -= capex;
      linksUsed += links;
      if (prop.hubLinks > 0 && links === prop.links) paidHubRooms.add(prop.hubRoom ?? "");
      approvals.push({ structure: prop.structure, at: prop.at, edge: prop.edge, capex, detail: prop.detail });
    } else {
      noteAwaiting(prop.offerId, capex, prop.detail);
    }
  }

  const plan = awaitingCapex > 0 ? assembleAndClear(view, committed + awaitingCapex).plan : base;
  plan.approvals = approvals;
  plan.frontier.push(...awaiting);
  return plan;
}
