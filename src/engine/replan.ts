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
 *
 * Corps see only handoffs; the market sees only option books; the domain
 * wiring lives here and stays about a page.
 */
import { SOURCE_RATE, upkeepEt } from "../primitives";
import { HaulGap, quoteHaul } from "../corps/haul";
import { quoteLink } from "../corps/link";
import { quoteMine } from "../corps/mine";
import { quoteSpawning, quoteTender, tenderCapacities } from "../corps/spawning";
import { quoteUpgrade } from "../corps/upgrade";
import { quoteWorkman } from "../corps/workman";
import { ChainCandidate, ChainStage, SinkChain, StageOption, clear } from "./market";
import { EconomyView, ViewCreep, ViewLink } from "./view";
import { EnginePlan, Offer, PlaceId } from "./vocabulary";

function assigned(view: EconomyView, corpId: string): ViewCreep[] {
  return view.creeps.filter(c => c.corp === corpId);
}

/** An offer's steps as stage options, capacities read at `place`. */
function optionsAt(offer: Offer, place: PlaceId): StageOption[] {
  return offer.steps.map((s, i) => ({ offer, step: i, capacity: s.provides.energyAt?.[place] ?? 0 }));
}

export function replan(view: EconomyView): EnginePlan {
  const linkAt = (place: PlaceId): ViewLink | null => view.links.find(l => l.at === place) ?? null;

  /** Round 2 for one gap: every transport kind quotes; the options merge
   * into the edge's order book — standing capital leads, then cheapest
   * marginal cost per unit of flow. Who wins the edge is this sort. */
  const transportBook = (gap: HaulGap): StageOption[] => {
    const options: StageOption[] = [];
    const haul = quoteHaul({
      gap,
      bank: view.bank,
      bodyBudget: view.bodyBudget,
      creeps: assigned(view, `haul:${gap.from}->${gap.to}`)
    });
    if (haul) options.push(...optionsAt(haul, gap.to));
    const link = quoteLink({ gap, atFrom: linkAt(gap.from), atTo: linkAt(gap.to) });
    // Investments draw from STOCK (piece 9): a candidate structure the
    // bank cannot pay for today is not on the book — it would only block
    // the affordable options behind it. It reappears as the warchest
    // grows. Bodies are flow, not investment: the ramp filter owns them.
    if (link && link.steps[0].cost.upfront <= view.bankStock) options.push(...optionsAt(link, gap.to));

    const marginal = (o: StageOption): number => {
      const c = o.offer.steps[o.step].cost;
      return o.capacity > 1e-9 ? (c.upkeepEt + (c.feeEt ?? 0)) / o.capacity : Infinity;
    };
    options.sort((a, b) => {
      const backedA = a.offer.steps[a.step].backedBy ? 0 : 1;
      const backedB = b.offer.steps[b.step].backedBy ? 0 : 1;
      if (backedA !== backedB) return backedA - backedB;
      const d = marginal(a) - marginal(b);
      if (Math.abs(d) > 1e-9) return d;
      if (a.offer.id !== b.offer.id) return a.offer.id < b.offer.id ? -1 : 1;
      return a.step - b.step;
    });
    return options;
  };

  // Round 1 — anchored production, one gap per supplying place.
  const chains: ChainCandidate[] = [];
  const sourceCaps: Record<string, number> = {};
  for (const src of view.sources) {
    sourceCaps[src.id] = SOURCE_RATE;

    const mine = quoteMine({
      sourceId: src.id,
      spots: src.spots,
      bank: view.bank,
      bodyBudget: view.bodyBudget,
      creeps: assigned(view, `mine:${src.id}`)
    });
    if (mine) {
      const mineOptions = optionsAt(mine, src.id);
      const supply = mineOptions.reduce((a, o) => a + o.capacity, 0);
      const book = transportBook({ from: src.id, to: view.bank, dist: src.distToBank, flow: supply });
      if (book.length > 0) {
        chains.push({
          id: `chain:${src.id}:specialist`,
          sourceId: src.id,
          stages: [{ options: mineOptions }, { options: book }]
        });
      }
    }

    const workman = quoteWorkman({
      sourceId: src.id,
      spots: src.spots,
      bank: view.bank,
      distToBank: src.distToBank,
      bodyBudget: view.bodyBudget,
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

  // Round 1 — anchored consumption; its feed place nets a bank→feed gap.
  const sinks: SinkChain[] = [];
  if (view.controller) {
    const ctrl = view.controller;
    // An adjacent controller self-loads AT the bank — its draw and the
    // bank's supply meet at one place, so the book clears with no gap.
    const feed = ctrl.distFromBank > 1 ? ctrl.id : view.bank;
    const upgrade = quoteUpgrade({
      controllerId: ctrl.id,
      feed,
      bodyBudget: view.bodyBudget,
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

  const tenderCreeps = assigned(view, "spawning:estate");
  const tenderOffer = quoteTender({
    bank: view.bank,
    estateRadius: view.estateRadius,
    bodyBudget: view.bodyBudget,
    creeps: tenderCreeps
  });

  // The live fleet's perpetual replacement bill — steady state has no
  // expiry event, only this cash line. The market needs it too: the
  // tender is sized to the WHOLE heartbeat, standing fleet included.
  const standingBills = view.creeps.reduce((sum, c) => sum + upkeepEt(c.body), 0);

  return clear({
    tick: view.tick,
    bank: view.bank,
    chains,
    sinks,
    spawnCapacity,
    bankStock: view.bankStock,
    sourceCaps,
    standingBills,
    tender: tenderOffer
      ? { offer: tenderOffer, capacities: tenderCapacities(tenderOffer, view.estateRadius, tenderCreeps) }
      : null
  });
}
