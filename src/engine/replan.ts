/**
 * replan.ts — the broker: it lives between the world and the corps (owner
 * 2026-08-22). It reads the EconomyView, hands each kind its typed assets
 * — including the creeps already assigned to each corp id, so sunk capital
 * arrives as handed assets — collects offers, composes chain candidates
 * per source (specialist mine+haul vs the fused workman, competing for the
 * same regen cap), and lets the market clear. Corps see only handoffs;
 * the market sees only schedules; domain wiring lives here and is ~a page.
 */
import { SOURCE_RATE, upkeepEt } from "../primitives";
import { quoteHaul } from "../corps/haul";
import { quoteMine } from "../corps/mine";
import { quoteSpawning, quoteTender, tenderCapacities } from "../corps/spawning";
import { quoteUpgrade } from "../corps/upgrade";
import { quoteWorkman } from "../corps/workman";
import { ChainCandidate, ChainStage, SinkChain, clear } from "./market";
import { EconomyView, ViewCreep } from "./view";
import { EnginePlan, Offer, PlaceId } from "./vocabulary";

function assigned(view: EconomyView, corpId: string): ViewCreep[] {
  return view.creeps.filter(c => c.corp === corpId);
}

/** A stage's per-step capacity in delivered terms: what each step provides
 * at the stage's output place. */
function capacitiesAt(offer: Offer, place: PlaceId): number[] {
  return offer.steps.map(s => s.provides.energyAt?.[place] ?? 0);
}

export function replan(view: EconomyView): EnginePlan {
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
      const mineCaps = capacitiesAt(mine, src.id);
      const haul = quoteHaul({
        gap: {
          from: src.id,
          to: view.bank,
          dist: src.distToBank,
          flow: mineCaps.reduce((a, b) => a + b, 0)
        },
        bank: view.bank,
        bodyBudget: view.bodyBudget,
        creeps: assigned(view, `haul:${src.id}->${view.bank}`)
      });
      if (haul) {
        chains.push({
          id: `chain:${src.id}:specialist`,
          sourceId: src.id,
          stages: [
            { offer: mine, capacities: mineCaps },
            { offer: haul, capacities: capacitiesAt(haul, view.bank) }
          ]
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
        stages: [{ offer: workman, capacities: capacitiesAt(workman, view.bank) }]
      });
    }
  }

  const sinks: SinkChain[] = [];
  if (view.controller) {
    const ctrl = view.controller;
    const upgrade = quoteUpgrade({
      controllerId: ctrl.id,
      feed: ctrl.id,
      bodyBudget: view.bodyBudget,
      maxBurn: view.sources.length * SOURCE_RATE,
      creeps: assigned(view, `upgrade:${ctrl.id}`)
    });
    if (upgrade) {
      const burns = upgrade.steps.map(s => s.requires.energyAt?.[ctrl.id] ?? 0);
      const stages: ChainStage[] = [];
      // An adjacent controller self-loads across the bank tile; a distant
      // one needs its feed hauled — the consumption side of the position
      // book, priced by the same kind and the same route law as mining.
      if (ctrl.distFromBank > 1) {
        const feeder = quoteHaul({
          gap: {
            from: view.bank,
            to: ctrl.id,
            dist: ctrl.distFromBank,
            flow: burns.reduce((a, b) => a + b, 0)
          },
          bank: view.bank,
          bodyBudget: view.bodyBudget,
          creeps: assigned(view, `haul:${view.bank}->${ctrl.id}`)
        });
        if (feeder) stages.push({ offer: feeder, capacities: capacitiesAt(feeder, ctrl.id) });
      }
      stages.push({ offer: upgrade, capacities: burns });
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
  // expiry event, only this cash line. The market needs it too: the tender
  // is sized to the WHOLE heartbeat, standing fleet included.
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
