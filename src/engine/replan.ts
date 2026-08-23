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
  CREEP_LIFE,
  EXTENSION_CAPACITY,
  EXTENSION_COST,
  HORIZON,
  LINK_CAPACITY,
  LINK_LOSS,
  PART_COST,
  SOURCE_RATE,
  haulRate,
  upkeepEt
} from "../primitives";
import { carryPartsFor, haulerBody } from "../sizing";
import { quoteBuild } from "../corps/build";
import { HaulGap, quoteHaul } from "../corps/haul";
import { TrunkSlice, quoteLink, quoteTrunk } from "../corps/link";
import { quoteMine } from "../corps/mine";
import { ESTATE_CORP, quoteSpawning, quoteTender, tenderCapacities } from "../corps/spawning";
import { quoteUpgrade } from "../corps/upgrade";
import { quoteWorkman } from "../corps/workman";
import { ChainCandidate, ChainStage, SinkChain, StageOption, clear } from "./market";
import { EconomyView, ViewCreep, ViewLink, ViewOutpost } from "./view";
import { Approval, EnginePlan, FrontierLine, Offer, PlaceId, Step } from "./vocabulary";

function assigned(view: EconomyView, corpId: string): ViewCreep[] {
  return view.creeps.filter(c => c.corp === corpId);
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
  const linkAt = (place: PlaceId): ViewLink | null => view.links.find(l => l.at === place) ?? null;

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

  const creepById = new Map<string, ViewCreep>(view.creeps.map(c => [c.id, c]));

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
    gapByOffer.set(`haul:${gap.from}->${gap.to}`, gap);
    const options: StageOption[] = [];
    const haul = quoteHaul({
      gap,
      bank: view.bank,
      bodyBudget: budget,
      creeps: assigned(view, `haul:${gap.from}->${gap.to}`)
    });
    if (haul) options.push(...optionsAt(haul, gap.to));
    const link = quoteLink({ gap, atFrom: linkAt(gap.from), atTo: linkAt(gap.to) });
    if (link && link.steps[0].backedBy) options.push(...optionsAt(link, gap.to));

    const steadyUnit = (o: StageOption): number => {
      const st: Step = o.offer.steps[o.step];
      let bill = st.cost.upkeepEt + (st.cost.feeEt ?? 0);
      // A backed BODY still owes its replacement, continuously; a backed
      // STRUCTURE owes only its fee (links do not wear out).
      const c = st.backedBy ? creepById.get(st.backedBy) : undefined;
      if (c) bill += upkeepEt(c.body);
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
  // the short collector leg plus the trunk's tax undercuts its direct
  // route. The trunk is ONE standing pair quoted as one slice-step per
  // source, so shared capacity funds once and the book audits the joint.
  // v0: standing trunks only, whole-supply routing.
  interface TrunkPlan {
    outpost: ViewOutpost;
    slices: TrunkSlice[];
    remaining: number;
  }
  interface PendingVia {
    srcId: string;
    mineOptions: StageOption[];
    collector: StageOption[];
    outpostPlace: PlaceId;
    sliceIdx: number;
    flow: number;
  }
  const trunks = new Map<string, TrunkPlan>();
  const pendingVia: PendingVia[] = [];

  const chains: ChainCandidate[] = [];
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
    if (mine) {
      const mineOptions = optionsAt(mine, src.id);
      const supply = mineOptions.reduce((a, o) => a + o.capacity, 0);

      let via: { op: ViewOutpost; collector: StageOption[] } | null = null;
      const directUnit = haulUnit(src.distToBank);
      let bestUnit = Infinity;
      for (const op of view.outposts) {
        if (!linkAt(op.place) || !linkAt(view.bank)) continue;
        const dSrc = op.distToSource[src.id];
        if (dSrc === undefined) continue;
        const t = trunks.get(op.place);
        const remaining = t ? t.remaining : LINK_CAPACITY / Math.max(op.distToBank, 1);
        if (remaining + 1e-9 < supply) continue;
        const unit = haulUnit(dSrc) + LINK_LOSS;
        if (unit + 1e-9 < directUnit && unit < bestUnit) {
          const collector = transportBook({ from: src.id, to: op.place, dist: dSrc, flow: supply });
          if (collector.length > 0) {
            via = { op, collector };
            bestUnit = unit;
          }
        }
      }

      if (via) {
        const t = trunks.get(via.op.place) ?? {
          outpost: via.op,
          slices: [],
          remaining: LINK_CAPACITY / Math.max(via.op.distToBank, 1)
        };
        pendingVia.push({
          srcId: src.id,
          mineOptions,
          collector: via.collector,
          outpostPlace: via.op.place,
          sliceIdx: t.slices.length,
          flow: supply
        });
        t.slices.push({ sourceId: src.id, flow: supply });
        t.remaining -= supply;
        trunks.set(via.op.place, t);
      } else {
        const book = transportBook({ from: src.id, to: view.bank, dist: src.distToBank, flow: supply });
        if (book.length > 0) {
          chains.push({
            id: `chain:${src.id}:specialist`,
            sourceId: src.id,
            stages: [{ options: mineOptions }, { options: book }]
          });
        }
      }
    }

    const workman = quoteWorkman({
      sourceId: src.id,
      spots: src.spots,
      bank: view.bank,
      distToBank: src.distToBank,
      bodyBudget: budget,
      creeps: assigned(view, `workman:${src.id}`)
    });
    if (workman) {
      chains.push({
        id: `chain:${src.id}:workman`,
        sourceId: src.id,
        stages: [{ options: optionsAt(workman, view.bank) }]
      });
    }
  }

  // Consolidated chains: the trunk offers exist only after every slice is
  // known, so via-chains assemble here — mine → collector → trunk slice.
  for (const t of trunks.values()) {
    const trunkOffer = quoteTrunk({
      from: t.outpost.place,
      to: view.bank,
      dist: t.outpost.distToBank,
      slices: t.slices,
      atFrom: linkAt(t.outpost.place),
      atTo: linkAt(view.bank)
    });
    if (!trunkOffer) continue;
    for (const v of pendingVia) {
      if (v.outpostPlace !== t.outpost.place) continue;
      chains.push({
        id: `chain:${v.srcId}:via`,
        sourceId: v.srcId,
        stages: [
          { options: v.mineOptions },
          { options: v.collector },
          { options: [{ offer: trunkOffer, step: v.sliceIdx, capacity: v.flow }] }
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

  const tenderCreeps = assigned(view, ESTATE_CORP);
  const tenderOffer = quoteTender({
    bank: view.bank,
    estateRadius: view.estateRadius,
    bodyBudget: budget,
    creeps: tenderCreeps
  });

  // The live fleet's perpetual replacement bill — steady state has no
  // expiry event, only this cash line. The market needs it too: the
  // tender is sized to the WHOLE heartbeat, standing fleet included.
  const standingBills = view.creeps.reduce((sum, c) => sum + upkeepEt(c.body), 0);

  const plan = clear({
    tick: view.tick,
    bank: view.bank,
    chains,
    sinks,
    spawnCapacity,
    bankStock: view.bankStock,
    sourceCaps,
    standingBills,
    warchestTarget,
    tender: tenderOffer
      ? { offer: tenderOffer, capacities: tenderCapacities(tenderOffer, view.estateRadius, tenderCreeps) }
      : null
  });
  return { plan, gaps: gapByOffer };
}

export function replan(view: EconomyView): EnginePlan {
  const linkAt = (place: PlaceId): ViewLink | null => view.links.find(l => l.at === place) ?? null;

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
  let spendable = view.bankStock - committed;
  const isSitePlace = (p: PlaceId): boolean => view.sites.some(s => s.at === p);
  const siteEdges = new Set<string>();
  for (const s of view.sites) if (s.edge) siteEdges.add(`${s.edge.from}->${s.edge.to}`);
  for (const corp of base.corps) {
    if (corp.kind !== "haul") continue;
    const gap = gapByOffer.get(corp.id);
    if (!gap || corp.pnl.grossEt <= 1e-9) continue;
    // Never invest in an edge that serves a SITE: the flow is transient
    // (the project ends), and H-amortized capex assumes it is forever —
    // a candidate here would clear its hurdle on flow that will vanish.
    if (isSitePlace(gap.from) || isSitePlace(gap.to)) continue;
    if (siteEdges.has(`${gap.from}->${gap.to}`)) continue;
    const cand = quoteLink({
      gap: { from: gap.from, to: gap.to, dist: gap.dist, flow: corp.pnl.grossEt },
      atFrom: linkAt(gap.from),
      atTo: linkAt(gap.to)
    });
    if (!cand || cand.steps[0].backedBy) continue;
    const st = cand.steps[0];
    const throughput = st.provides.energyAt?.[gap.to] ?? 0;
    if (throughput <= 1e-9) continue;
    const candUnit = (st.cost.upkeepEt + (st.cost.feeEt ?? 0)) / throughput;
    // The incumbent prices at REPLACEMENT SCALE, not at its sunk quote
    // (the roadmap's replacement-scale displacement rule, pulled in by
    // measurement: a backed fleet quotes ~zero, which made living bodies
    // IMMORTAL incumbents — the link candidate could never fire once the
    // haul fleet stood, and the investment loop never closed). In steady
    // state replacement is continuous — the amortized bill IS the
    // fleet's marginal cost — so the challenger meets that bill: piece
    // 5's "the true re-decision happens at replacement time, at full
    // cost", with replacement time being always, a little. The bill is
    // the IDEAL fleet's, from the one logistics law — the funded fleet
    // can be fatter (quoted for schedule demand, funded for less), and
    // that idle CARRY is utilization waste, never a reason to buy wire.
    const idealPairs = carryPartsFor(corp.pnl.grossEt, gap.dist);
    const replacementBill = (idealPairs * (PART_COST.carry + PART_COST.move)) / CREEP_LIFE;
    const incumbentUnit = replacementBill / corp.pnl.grossEt;
    if (candUnit + 1e-9 >= incumbentUnit) continue;
    const capex = st.cost.upfront;
    const detail =
      `link ${candUnit.toFixed(4)}/unit beats bodies ${incumbentUnit.toFixed(4)}/unit ` +
      `on ${gap.from}->${gap.to} (${corp.pnl.grossEt.toFixed(1)} e/t)`;
    if (capex <= spendable + 1e-9) {
      spendable -= capex;
      approvals.push({ structure: "link", edge: { from: gap.from, to: gap.to }, at: gap.from, capex, detail });
    } else {
      awaiting.push({
        offerId: cand.id,
        reason: "awaiting stock",
        detail: `${capex}e capex, ${Math.max(spendable, 0).toFixed(0)}e spendable — ${detail}`
      });
      awaitingCapex += capex;
    }
  }

  // The GLOBAL candidate: the next extension (roadmap Tier 1.2 —
  // bodyBudget becomes endogenous). Its payoff is a change in EVERY
  // quote, so no order book can price it; the planner differences whole
  // plans instead — the counterfactual world at +50e budget, cleared by
  // the same machinery — and applies the piece-9 hurdle literally:
  // Δ(controller stream) over HORIZON against capex. One candidate at a
  // time: an open extension site defers the next evaluation until the
  // payoff is real (the estate grows sequentially, and quotes on the
  // NEXT increment re-run against the grown estate).
  if (!view.sites.some(s => s.structure === "extension")) {
    const cf = assembleAndClear({ ...view, bodyBudget: view.bodyBudget + EXTENSION_CAPACITY }, committed).plan;
    const delta = cf.expected.upgradeEt - base.expected.upgradeEt;
    if (delta * HORIZON > EXTENSION_COST) {
      const detail =
        `+${EXTENSION_CAPACITY}e budget adds ${delta.toFixed(3)} CP/t: ` +
        `${(delta * HORIZON).toFixed(0)}e over H beats ${EXTENSION_COST}e capex`;
      if (EXTENSION_COST <= spendable + 1e-9) {
        spendable -= EXTENSION_COST;
        approvals.push({ structure: "extension", at: view.bank, capex: EXTENSION_COST, detail });
      } else {
        awaiting.push({
          offerId: "extension:estate",
          reason: "awaiting stock",
          detail: `${EXTENSION_COST}e capex, ${Math.max(spendable, 0).toFixed(0)}e spendable — ${detail}`
        });
        awaitingCapex += EXTENSION_COST;
      }
    }
  }

  const plan = awaitingCapex > 0 ? assembleAndClear(view, committed + awaitingCapex).plan : base;
  plan.approvals = approvals;
  plan.frontier.push(...awaiting);
  return plan;
}
