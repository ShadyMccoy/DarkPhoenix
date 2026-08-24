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
  CONTAINER_HOLD_ET,
  EXTENSION_CAPACITY,
  EXTENSION_COST,
  HORIZON,
  LINK_CAPACITY,
  LINK_COST,
  LINK_LOSS,
  ROAD_COST_PER_TILE,
  ROAD_UPKEEP_ET_PER_TILE,
  SOURCE_RATE,
  STORAGE_COST,
  branchHoldingEt,
  chebyshev,
  haulRate,
  reachableStock,
  spawnTimeEt,
  upkeepEt
} from "../primitives";
import { haulFleetBillEt, haulerBody, hubServiceBody, portTenderBody } from "../sizing";
import { quoteBuild } from "../corps/build";
import { HaulGap, quoteHaul } from "../corps/haul";
import { TrunkSlice, quoteLink, quoteTrunk } from "../corps/link";
import { quoteMine } from "../corps/mine";
import { ESTATE_CORP, quoteSpawning, quoteTender, tenderCapacities } from "../corps/spawning";
import { quoteUpgrade } from "../corps/upgrade";
import { quoteWorkman } from "../corps/workman";
import { ChainCandidate, ChainStage, SinkChain, StageOption, clear } from "./market";
import { EconomyView, ViewCreep, ViewLink } from "./view";
import { Approval, EnginePlan, FrontierLine, Offer, PlaceId, Step, StructureKind } from "./vocabulary";

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
function assembleAndClear(view: EconomyView, warchestTarget: number): { plan: EnginePlan; gaps: Map<string, HaulGap> } {
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
  const transportBook = (gap: HaulGap): StageOption[] => {
    gap.roaded = view.roads.some(r => r.from === gap.from && r.to === gap.to);
    gapByOffer.set(`haul:${gap.from}->${gap.to}`, gap);
    const options: StageOption[] = [];
    const haul = quoteHaul({
      gap,
      bank: view.bank,
      bodyBudget: budget,
      creeps: assigned(view, `haul:${gap.from}->${gap.to}`)
    });
    if (haul) options.push(...optionsAt(haul, gap.to));
    const pair = linkPair(view, gap.from, gap.to);
    const link = pair ? quoteLink({ gap, atFrom: pair.atFrom, atTo: pair.atTo }) : null;
    if (link && link.steps[0].backedBy) options.push(...optionsAt(link, gap.to));

    const steadyUnit = (o: StageOption): number => {
      const st: Step = o.offer.steps[o.step];
      let bill = st.cost.upkeepEt + (st.cost.feeEt ?? 0);
      // A backed BODY still owes its replacement, continuously; a backed
      // STRUCTURE owes only its fee (links do not wear out). The body
      // rides the step now — the creep re-join this closure used to do
      // was one of the compensating lenses the roster fix deleted
      // (Addendum 4, second landing).
      if (st.backedBy && st.body) bill += upkeepEt(st.body);
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
  // consolidation (owner 2026-08-23: "consolidate multiple haul routes
  // into one link outpost"): a source routes via a collection branch when
  // the short collector leg plus the trunk's price undercuts its direct
  // route. The trunk is ONE standing pair quoted as one wire-share step
  // per source, so shared capacity funds once and the book audits the
  // joint. The pair and its ration come from linkPair — the LEGAL
  // closest pair. When the ration binds, the excess is a RATE, never a
  // member (Addendum 5, owner 2026-08-24: "they could still bring all 30
  // to the outpost and the link can hire a hauler for the excess"): a
  // member takes what wire is left and the trunk's own overflow bodies
  // walk the rest, so nobody sheds to a direct route while the blend
  // still pays. Members still seat in displaced-saving order (Addendum
  // 3), which decides who rides the cheap wire and who pays the walk.
  // v0: standing trunks only, whole-supply routing per member,
  // best-outpost-only per source.
  interface TrunkPlan {
    place: PlaceId;
    pair: { atFrom: ViewLink; atTo: ViewLink };
    slices: TrunkSlice[];
    overflow: TrunkSlice[];
    distToBank: number;
    remaining: number;
  }
  const trunkFor = (place: PlaceId): TrunkPlan | null => {
    const pair = linkPair(view, place, view.bank);
    const op = view.outposts.find(o => o.place === place);
    if (!pair || !op) return null;
    const range = Math.max(chebyshev(pair.atFrom, pair.atTo), 1);
    return { place, pair, slices: [], overflow: [], distToBank: op.distToBank, remaining: LINK_CAPACITY / range };
  };
  const trunks = new Map<string, TrunkPlan>();
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
    /** Every paying trunk, best saving first — a full best trunk spills
     * to the next, never straight to bodies while a paying trunk stands
     * idle (best-only admission was a regression the review caught). */
    options: ViaOption[];
  }
  const viaCandidates: ViaCandidate[] = [];
  interface PendingVia {
    srcId: string;
    mineOptions: StageOption[];
    collector: StageOption[];
    outpostPlace: PlaceId;
  }
  const pendingVia: PendingVia[] = [];

  const chains: ChainCandidate[] = [];
  const directChain = (srcId: string, mineOptions: StageOption[], distToBank: number, supply: number): void => {
    const book = transportBook({ from: srcId, to: view.bank, dist: distToBank, flow: supply });
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

    const mine = quoteMine({
      sourceId: src.id,
      spots: src.spots,
      bank: view.bank,
      bodyBudget: budget,
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
    if (!mineOptions) continue;

    const directUnit = haulUnit(src.distToBank);
    // A source with a STANDING direct wire never rides a tree: its
    // direct marginal is the same 3% tax with no collector leg, so via
    // (leg + tax, possibly tax + tax) can only lose. The heuristic
    // compared BODY units on both sides and pulled wired sources onto
    // the trunks — a double-taxed relay that also stole slices from
    // the genuinely-displacing members (caught in the forest re-run).
    const directWire = linkPair(view, src.id, view.bank);
    const options: ViaOption[] = [];
    for (const op of directWire ? [] : view.outposts) {
      const dSrc = op.distToSource[src.id];
      if (dSrc === undefined) continue;
      if (!trunks.has(op.place)) {
        const t = trunkFor(op.place);
        if (t) trunks.set(op.place, t);
      }
      if (!trunks.has(op.place)) continue;
      const saving = directUnit - (haulUnit(dSrc) + LINK_LOSS);
      if (saving > 1e-9) options.push({ outpostPlace: op.place, dSrc, saving });
    }
    if (options.length > 0) {
      options.sort((a, b) => b.saving - a.saving || (a.outpostPlace < b.outpostPlace ? -1 : 1));
      viaCandidates.push({ srcId: src.id, mineOptions, supply, directDist: src.distToBank, options });
    }
  }

  // Member admission, by MERIT: the biggest TOTAL displaced saving
  // (per-unit saving × the source's actual supply — a spots-limited
  // trickle must not outrank a full source) seats first, so the best
  // displacers ride the cheap wire. A member takes the wire that is
  // LEFT and spills the rest onto the trunk's own overflow bodies; its
  // BLENDED gain (wire share at the tax, spill at the corridor walk)
  // decides admission — a member whose blend loses to its direct route
  // stays direct, naturally: a mostly-spilled member pays the collector
  // leg plus the corridor, which the triangle makes a detour.
  viaCandidates.sort(
    (a, b) => b.options[0].saving * b.supply - a.options[0].saving * a.supply || (a.srcId < b.srcId ? -1 : 1)
  );
  const viaSeated = new Set<string>();
  for (const c of viaCandidates) {
    const directUnit = haulUnit(c.directDist);
    for (const o of c.options) {
      const t = trunks.get(o.outpostPlace);
      if (!t) continue;
      const wireShare = Math.min(c.supply, Math.max(t.remaining, 0));
      const spill = c.supply - wireShare;
      const gain = wireShare * o.saving + spill * (directUnit - haulUnit(o.dSrc) - haulUnit(t.distToBank));
      if (gain <= 1e-9) continue;
      // A collector leg unloads into the port: its bodies cap at the
      // landing quantum (Addendum 4's anatomy at the haul quote).
      const collector = transportBook({
        from: c.srcId,
        to: o.outpostPlace,
        dist: o.dSrc,
        flow: c.supply,
        linkFed: true
      });
      if (collector.length === 0) continue;
      viaSeated.add(c.srcId);
      pendingVia.push({ srcId: c.srcId, mineOptions: c.mineOptions, collector, outpostPlace: o.outpostPlace });
      if (wireShare > 1e-9) t.slices.push({ sourceId: c.srcId, flow: wireShare });
      if (spill > 1e-9) t.overflow.push({ sourceId: c.srcId, flow: spill });
      t.remaining -= wireShare;
      break;
    }
  }

  // The chains array assembles in the SOURCE ORDER the market clears
  // in: per source, specialist before workman (the cascade tests pin
  // that phase-1 priority), via chains after the trunks consolidate.
  // Pushing rejected fallbacks at admission time slid them behind their
  // own workman chains (review finding — a phase-1 priority flip on
  // any source holding both fleets).
  for (const r of srcRecords) {
    if (r.mineOptions && !viaSeated.has(r.srcId)) directChain(r.srcId, r.mineOptions, r.distToBank, r.supply);
    if (r.workman) {
      chains.push({
        id: `chain:${r.srcId}:workman`,
        sourceId: r.srcId,
        stages: [{ options: optionsAt(r.workman, view.bank) }]
      });
    }
  }

  // Consolidated chains: the trunk offers exist only after every share
  // is known, so via-chains assemble here — mine → collector → the
  // member's trunk options (throat at zero capacity, its wire share,
  // its overflow bodies), indices straight from the quote's own layout:
  // a broker-side re-derivation would be a second lens on the offer's
  // shape. The throat funds with whichever member funds first and the
  // market charges shared steps once (Addendum 4).
  for (const t of trunks.values()) {
    const q = quoteTrunk({
      from: t.place,
      to: view.bank,
      slices: t.slices,
      overflow: t.overflow,
      distToBank: t.distToBank,
      roaded: view.roads.some(r => r.from === t.place && r.to === view.bank),
      bodyBudget: budget,
      atFrom: t.pair.atFrom,
      atTo: t.pair.atTo,
      container: view.outposts.find(o => o.place === t.place)?.hasContainer ?? false,
      creeps: assigned(view, `link:${t.place}->${view.bank}`)
    });
    if (!q) continue;
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

  // Round 1 — anchored consumption; its feed place nets a bank→feed gap.
  // Capital sinks first (the bank's draw policy): every open site is a
  // build chain — transport covers the site's place like any gap, the
  // build corp burns there, and the burn draws the stock the approval
  // reserved.
  const sinks: SinkChain[] = [];
  for (const site of view.sites) {
    const buildOffer = quoteBuild({
      siteId: site.id,
      at: site.at,
      total: site.total,
      remaining: site.remaining,
      bodyBudget: budget,
      creeps: assigned(view, `build:${site.id}`)
    });
    if (!buildOffer) continue;
    const burnOptions: StageOption[] = buildOffer.steps.map((s, i) => ({
      offer: buildOffer,
      step: i,
      capacity: s.requires.energyAt?.[site.at] ?? 0
    }));
    const demand = burnOptions.reduce((a, o) => a + o.capacity, 0);
    const stages: ChainStage[] = [];
    if (site.at !== view.bank) {
      const book = transportBook({ from: view.bank, to: site.at, dist: site.dist, flow: demand });
      if (book.length > 0) stages.push({ options: book });
    }
    stages.push({ options: burnOptions });
    sinks.push({ stages, capital: true });
  }
  if (view.controller) {
    const ctrl = view.controller;
    // An adjacent controller self-loads AT the bank — its draw and the
    // bank's supply meet at one place, so the book clears with no gap.
    const feed = ctrl.distFromBank > 1 ? ctrl.id : view.bank;
    const upgrade = quoteUpgrade({
      controllerId: ctrl.id,
      feed,
      bodyBudget: budget,
      maxBurn: view.sources.length * SOURCE_RATE,
      creeps: assigned(view, `upgrade:${ctrl.id}`)
    });
    if (upgrade) {
      const burnOptions: StageOption[] = upgrade.steps.map((s, i) => ({
        offer: upgrade,
        step: i,
        capacity: s.requires.energyAt?.[feed] ?? 0
      }));
      const demand = burnOptions.reduce((a, o) => a + o.capacity, 0);
      const stages: ChainStage[] = [];
      if (feed !== view.bank) {
        const book = transportBook({ from: view.bank, to: feed, dist: ctrl.distFromBank, flow: demand });
        if (book.length > 0) stages.push({ options: book });
      }
      stages.push({ options: burnOptions });
      sinks.push({ stages });
    }
  }

  const spawning = quoteSpawning({ spawnIds: view.spawnIds });
  const spawnCapacity = spawning ? spawning.steps.reduce((sum, s) => sum + (s.provides.spawnTime ?? 0), 0) : 0;

  // The live fleet's perpetual replacement bill — steady state has no
  // expiry event, only this cash line. The market needs it too: the
  // tender is sized to the WHOLE heartbeat, standing fleet included —
  // and the fleet's sustain MACHINE TIME seeds the spawn constraint the
  // same way (a capacity is a capacity in every currency).
  const standingBills = view.creeps.reduce((sum, c) => sum + upkeepEt(c.body), 0);
  const standingSpawnEt = view.creeps.reduce((sum, c) => sum + spawnTimeEt(c.body), 0);

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
  return { plan, gaps: gapByOffer };
}

export function replan(view: EconomyView): EnginePlan {
  // Open sites' remaining capex is already the bank's to hold: if hires
  // dipped the stock below it, the warchest tops it back up.
  const committed = view.sites.reduce((sum, s) => sum + s.remaining, 0);
  const { plan: base, gaps: gapByOffer } = assembleAndClear(view, committed);

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
    const replacementBill = haulFleetBillEt(corp.pnl.grossEt, gap.dist, gap.roaded ?? false);
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
    const candUnit = st && throughput > 1e-9 ? (st.cost.upkeepEt + (st.cost.feeEt ?? 0)) / throughput : Infinity;
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
      const roadedBill = haulFleetBillEt(corp.pnl.grossEt, gap.dist, true);
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
      flow += gross;
      saving +=
        haulFleetBillEt(gross, gap?.dist ?? 50, gap?.roaded ?? false) -
        haulFleetBillEt(gross, x.m.collectRange, false) -
        LINK_LOSS * gross;
    }
    // The candidate prices its whole port anatomy (Addendum 4): the
    // throat's bill, the hub-side service, and the buffer container it
    // OBLIGATES — hold plus capex over H. The container itself approves
    // as the standing trunk's obligation once the station stands, so the
    // purse pays it then; the hurdle prices it now, as a known
    // consequence, or a tree could clear on arithmetic its kit falsifies.
    saving -=
      upkeepEt(portTenderBody(flow)) + upkeepEt(hubServiceBody()) + CONTAINER_HOLD_ET + CONTAINER_COST / HORIZON;
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
    const at = corp.id.slice("link:".length).split("->")[0];
    if (at.indexOf("outpost:") !== 0) continue;
    const op = view.outposts.find(o => o.place === at);
    if (!op || op.hasContainer) continue;
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
