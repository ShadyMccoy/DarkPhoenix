/**
 * replan.ts — the broker: it lives between the world and the corps (owner
 * 2026-08-22), and it clears in the constitution's own order (owner
 * 2026-08-23, after the position book caught hand-wired matching):
 *
 *   round 1 — anchored offers: producers quote at their places, sinks
 *   quote at their feed points; the netted places ARE the gaps, every
 *   chain cut at the bank (piece 9).
 *   round 2 — every transport kind quotes each gap: haul offers bodies,
 *   link offers volleys, and their options merge into the edge's ORDER
 *   BOOK, standing capital first, then cheapest marginal unit. Nothing
 *   is hand-wired: a gap with no coverage simply yields no chain, and
 *   the position book stays the tripwire behind it all.
 *   round 3 — investment (Tier 1.1): the order books trade only what can
 *   move energy TODAY (standing structures, buyable bodies); a candidate
 *   structure is instead evaluated against the edges the funded plan
 *   actually runs — traffic generates infrastructure candidates (piece 7)
 *   — and approved when it beats the incumbent's unit cost AND the bank's
 *   spendable stock covers its capex. A winner the bank cannot pay prints
 *   `awaiting stock`, and the plan re-clears with the warchest target so
 *   the residual banks toward it instead of burning.
 *
 * Corps see only handoffs; the market sees only option books; the domain
 * wiring lives here and stays about a page.
 */
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

/**
 * A place can hold SEVERAL links (a border bank keeps one hub per room);
 * a pair is whichever combination is LEGAL and closest — one arbitrary
 * link per place silently dropped legal pairs (caught in the wide-world
 * run).
 */
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

/** An offer's steps as stage options, capacities read at `place`. */
function optionsAt(offer: Offer, place: PlaceId): StageOption[] {
  return offer.steps.map((s, i) => ({ offer, step: i, capacity: s.provides.energyAt?.[place] ?? 0 }));
}

/**
 * Rounds 1–2 plus clearing, for ONE world. Pure over the view, which is
 * what lets round 3 difference WHOLE PLANS across counterfactual views:
 * a global candidate (an extension) changes every quote at once, so no
 * order book can price it — only a second clearing can.
 */
function assembleAndClear(
  view: EconomyView,
  warchestTarget: number
): { plan: EnginePlan; gaps: Map<string, HaulGap>; trunkBuffers: Map<string, PlaceId> } {
  // The buyable budget — v1's survival law, ported: "sizes to capacity
  // when staffed, to cash-in-hand when nobody is alive". With PRODUCTION
  // standing, income refills the estate, so waiting for the full body is
  // nearly free and sizing tracks capacity — sizing to instantaneous
  // stock instead bred runt cohorts every time the balance dipped (the
  // spec-01 equilibrium, re-observed in the believer). With production
  // dead, the bank can only load what it holds, floored at the spawn's
  // 300 self-regen. "Staffed" means production: the tender alone must
  // not flip the regime (an any-creep test deadlocked the cold start —
  // the tender hired first and snapped every quote to unbuyable bodies).
  const productionStaffed = view.creeps.some(c => c.corp !== ESTATE_CORP);
  const budget = productionStaffed ? view.bodyBudget : Math.min(view.bodyBudget, Math.max(view.bankStock, 300));

  /** Gaps the books were built for, by haul offer id — round 3 evaluates
   * link candidates against exactly these funded edges. */
  const gapByOffer = new Map<string, HaulGap>();

  /** Posting walk per corp id, registered where each handoff is built —
   * the standing seeds (standingBills / standingSpawnEt) prorate live
   * creeps by their corp's commute so the heartbeat is not silently
   * under-covered by commuting fleets (Addendum 6, corrected: every
   * body's posting is its PICKUP — haulers start at the source, the
   * trunk's whole roster commutes the corridor; only bank-pickup bodies
   * commute zero). The ROWS stay exact per step. */
  const commuteByCorp = new Map<string, number>();

  /** Round 2 for one gap: every transport kind quotes; the options merge
   * into the edge's order book, cheapest STEADY-STATE unit first — who
   * wins the edge is this sort. The book trades only what can move energy
   * TODAY: standing pairs and buyable bodies. A candidate structure is
   * round 3's business — on the book it would crowd out the workable
   * option behind it and strand the edge's flow for its whole
   * construction window.
   *
   * Ordering prices bodies at REPLACEMENT SCALE (the roadmap's
   * replacement-scale displacement rule): a backed body's funding quote
   * is sunk-zero (piece 5), but in a steady-state ledger its keep-alive
   * cost is its amortized bill, paid continuously — ordering by the sunk
   * quote made living fleets immortal incumbents, and a standing link
   * (3% tax) could never take its edge back from the bodies it beat.
   * Backed-first survives as the TIEBREAK: within equal steady-state
   * cost, standing capital holds — the anti-thrash piece 5 wanted. */
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

  /** Marginal haul cost per unit of flow at a distance — the broker's
   * route-selection heuristic; the books still price the real thing. */
  const haulUnit = (dist: number): number => {
    const body = haulerBody(budget);
    if (!body) return Infinity;
    return upkeepEt(body) / haulRate(body.carry, dist);
  };

  // Round 1 — anchored production, one gap per supplying place. Outpost
  // consolidation lives in the link vertical (planTrunks — Addenda 3/5
  // hold its admission and overflow rulings); the broker lends it books,
  // pairs, and route facts.
  const chains: ChainCandidate[] = [];
  const directChain = (srcId: string, mineOptions: StageOption[], distToBank: number, supply: number): void => {
    // The fleet starts at the source (Addendum 6, corrected): the walk
    // out is a time-to-live penalty, not a first cycle.
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

  // The chains array assembles in the SOURCE ORDER the market clears
  // in: per source, specialist before workman (the cascade tests pin
  // that phase-1 priority), via chains after the trunks consolidate.
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

  // Round 1 — anchored consumption; its feed place nets a bank→feed gap.
  // Capital sinks first (the bank's draw policy): the burn draws the
  // stock the approval reserved. An adjacent controller self-loads AT
  // the bank — its draw and the bank's supply meet at one place, so the
  // book clears with no gap.
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

  // The live fleet's perpetual replacement bill — steady state has no
  // expiry event, only this cash line. The market needs it too: the
  // tender is sized to the WHOLE heartbeat, standing fleet included —
  // and the fleet's sustain MACHINE TIME seeds the spawn constraint the
  // same way (a capacity is a capacity in every currency).
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
    // The branch's rot plus the road network's upkeep: standing costs the
    // bank pays whether or not anything funds.
    holdingEt:
      branchHoldingEt(view.bankBranch, view.bankStock, view.bodyBudget) +
      view.roads.reduce((sum, r) => sum + r.dist * ROAD_UPKEEP_ET_PER_TILE, 0),
    warchestTarget,
    tender: tenderOffer ? { offer: tenderOffer, capacities: tenderCapacities(tenderOffer, view.estateRadius) } : null
  });
  return { plan, gaps: gapByOffer, trunkBuffers: trunkPlanning.buffers };
}

export function replan(view: EconomyView): EnginePlan {
  // Open sites' remaining capex is already the bank's to hold: if hires
  // dipped the stock below it, the warchest tops it back up.
  const committed = view.sites.reduce((sum, s) => sum + s.remaining, 0);
  const { plan: base, gaps: gapByOffer, trunkBuffers } = assembleAndClear(view, committed);

  // Round 3 — investment evaluation on the funded plan's own traffic.
  // Piece 5's challenger rule as arithmetic: the candidate's FULL-cost
  // unit (tax + capex over HORIZON) against the incumbent fleet's unit
  // on the flow the edge actually carries. Approval draws down the
  // spendable stock (capex is reserved, then burned as build flow); a
  // winner the bank cannot pay prints `awaiting stock` and raises the
  // warchest target so the residual banks toward it.
  const approvals: Approval[] = [];
  const awaiting: FrontierLine[] = [];
  let awaitingCapex = 0;
  const paidHubRooms = new Set<string>();
  // The link allowance (per-RCL scarcity, staged): standing links, links
  // in open sites, and this replan's approvals all draw one pool. A wire
  // that clears its hurdle but not the allowance prints `link budget` —
  // never the warchest: no amount of saving mints another link.
  const linkBudget = view.linkBudget ?? Infinity;
  let linksUsed =
    view.links.length +
    view.sites.filter(k => k.structure === "link").reduce((n, k) => n + Math.round(k.total / LINK_COST), 0);
  let spendable = view.bankStock - committed;

  // What the branch can physically accumulate to: the divertable stream
  // (dividend + what already banks) feeds the pile, and decay grows with
  // it until it eats the whole stream. A candidate beyond the asymptote
  // prints `capex unreachable` and never joins the warchest target —
  // chasing it would pause the dividend forever and never arrive.
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
  // The bank is excluded on purpose: kernel sites (extension, container)
  // assemble AT the bank place, and matching it froze ALL link/road
  // evaluation for their whole construction window — every eligible edge
  // touches the bank (review finding). The transient-flow concern this
  // guard exists for applies to a site's OWN place, never the kernel.
  const isSitePlace = (p: PlaceId): boolean => p !== view.bank && view.sites.some(s => s.at === p);
  const siteEdges = new Set<string>();
  for (const s of view.sites) if (s.edge) siteEdges.add(`${s.edge.from}->${s.edge.to}`);
  // Candidates are COLLECTED first and the purse spends in MERIT order
  // (net saving per capex e) — inline spending funded whichever corp id
  // sorted first: four near roads drained the purse before the far
  // wires that saved 3x as much (caught in the wide-world demo).
  interface Proposal {
    structure: StructureKind;
    at: PlaceId;
    edge?: { from: PlaceId; to: PlaceId };
    offerId: string;
    savingEt: number;
    capex: number;
    links: number;
    /** 1 when a missing hub's link rides in `capex`/`links` — dropped at
     * spend time if another approval already paid this room's hub. */
    hubLinks: number;
    hubRoom?: string;
    detail: string;
  }
  const proposals: Proposal[] = [];

  for (const corp of base.corps) {
    if (corp.kind !== "haul") continue;
    const gap = gapByOffer.get(corp.id);
    if (!gap || corp.pnl.grossEt <= 1e-9) continue;
    // Never invest in an edge that serves a SITE: the flow is transient
    // (the project ends), and H-amortized capex assumes it is forever —
    // a candidate here would clear its hurdle on flow that will vanish.
    if (isSitePlace(gap.from) || isSitePlace(gap.to)) continue;
    if (siteEdges.has(`${gap.from}->${gap.to}`)) continue;
    // The incumbent prices at REPLACEMENT SCALE, not at its sunk quote
    // (the roadmap's replacement-scale displacement rule, pulled in by
    // measurement: a backed fleet quotes ~zero, which made living bodies
    // IMMORTAL incumbents). In steady state replacement is continuous —
    // the amortized bill IS the fleet's marginal cost. The bill is the
    // IDEAL fleet's, from the one logistics law.
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

    // The road (Tier 1.4): the edge's third option — same fleet law,
    // cheaper gait (2C:1M). Only where the wire did NOT clear: a paved
    // route under a link is capex twice for one flow.
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

  // The BRANCHING TREE (owner 2026-08-24): a shared collection station —
  // M1..MN short-haul into one link, which fires to the bank hub. The
  // network plan proposes these only where links are too scarce for
  // private mouths; the market still decides on the funded traffic.
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
    // The hurdle prices the kit now, or a tree could clear on
    // arithmetic its own kit falsifies (Addendum 4); the vertical owns
    // the terms.
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

  // The GLOBAL candidate: the next extension (roadmap Tier 1.2 —
  // bodyBudget becomes endogenous), priced by differencing whole plans:
  // the counterfactual +50e world, cleared by the same machinery, and
  // the piece-9 hurdle literally. One at a time; an open extension site
  // defers the next look until the payoff is real.
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

  // The bank-branch ladder (Tier 1.3): capex that cheapens banking,
  // priced at TODAY'S stock (greedy myopia, recorded). One rung at a
  // time; an open branch site defers the next look. Branch holding ONLY
  // — expected.holdingEt also carries the road network's upkeep, which
  // survives the build (review finding, the session's one HIGH).
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

  // The port buffer is the standing trunk's OBLIGATION, never a
  // candidate (Addendum 4, ratified 2026-08-24): the dampener is what
  // makes the ration real — a haul-fed port without its mouth is v1's
  // measured 22.4%-of-arrivals-holding machine — so a funded trunk with
  // a bare outpost draws its container AHEAD of the merit spend, the way
  // obligations draw first everywhere else. Miner-fed mouths and the
  // hub (storage-backed) trigger nothing: haul-fed only.
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

  // THE SPEND, in merit order: net saving per capex e, deterministic
  // tiebreak. Hub-sharing adjusts at spend time (per room); the link
  // allowance and the purse gate as before.
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
