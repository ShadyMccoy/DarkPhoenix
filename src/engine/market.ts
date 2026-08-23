/**
 * market.ts — the kind-agnostic clearing core: offers in, funded plan +
 * blocked frontier out. It holds NO domain knowledge — it never sees a
 * body, a route, or a source, only schedules of steps with capacities and
 * costs — so it cannot accumulate case logic (piece 6: the engine is too
 * small to hide anything in). The corp kinds price; this module combines.
 *
 * Depth-0 clearing IS the greedy merit-order loop: compose each chain's
 * stages into delivered increments, then fund increments best-first —
 * standing capital first (sunk holds its funding, piece 5), then by
 * marginal net descending — until a constraint closes each chain and
 * prints its frontier line. Funding checks, in order: source room,
 * marginal net, spawn machine time, ramp solvency (piece 8's heartbeat
 * constraint: with no standing income, a chain whose first increment
 * cannot be bought from stock can never close — the workman root emerges
 * here, no mode). Consumption then draws the residual, ladder-style.
 *
 * An increment that only half-fits its source funds TRIMMED (the body is
 * quantized, the flow is not): the challenger enters at reduced delivery
 * rather than deadlocking against incumbents — the stranded remainder is
 * plainly visible as mined-vs-delivered surplus, first lab question.
 */
import { CorpInstance, EnginePlan, Flows, FrontierLine, Offer, PlaceId, Step } from "./vocabulary";

export interface ChainStage {
  offer: Offer;
  /** Per-step capacity in the chain's delivered currency (e/t). */
  capacities: number[];
}

/** A production chain candidate: ordered stages, source side → bank. */
export interface ChainCandidate {
  id: string;
  /** Source whose regen cap the chain draws against. */
  sourceId: string | null;
  stages: ChainStage[];
}

export interface SinkCandidate {
  offer: Offer;
  /** Per-step draw at the bank (burn, e/t). */
  burns: number[];
}

export interface MarketInput {
  tick: number;
  bank: PlaceId;
  chains: ChainCandidate[];
  sinks: SinkCandidate[];
  /** Machine-time capacity, parts/tick (Σ spawning provides). */
  spawnCapacity: number;
  bankStock: number;
  /** Regen caps by source id, e/t. */
  sourceCaps: Record<string, number>;
}

interface StepRef {
  stage: number;
  step: number;
}

interface Inc {
  delivered: number;
  steps: StepRef[];
  upkeepEt: number;
  spawnTimeEt: number;
  upfront: number;
  /** Every step already embodied — standing capital. */
  backed: boolean;
}

/**
 * Zip a chain's stages into delivered increments: repeatedly extend the
 * bottleneck stage (lowest cumulative capacity) one step; each rise of the
 * cross-stage minimum emits an increment carrying the steps that produced
 * it. A miner step waits inside `pending` until a hauler step makes its
 * energy deliverable — increments price END-TO-END by construction.
 */
function chainIncrements(chain: ChainCandidate): Inc[] {
  const n = chain.stages.length;
  const cum: number[] = new Array<number>(n).fill(0);
  const ptr: number[] = new Array<number>(n).fill(0);
  let lastMin = 0;
  let pending: StepRef[] = [];
  const incs: Inc[] = [];
  for (;;) {
    let minIdx = 0;
    for (let i = 1; i < n; i++) if (cum[i] < cum[minIdx]) minIdx = i;
    const stage = chain.stages[minIdx];
    if (ptr[minIdx] >= stage.capacities.length) break;
    const stepIdx = ptr[minIdx];
    ptr[minIdx] += 1;
    cum[minIdx] += stage.capacities[stepIdx];
    pending.push({ stage: minIdx, step: stepIdx });
    const m = Math.min(...cum);
    if (m > lastMin) {
      const inc: Inc = {
        delivered: m - lastMin,
        steps: pending,
        upkeepEt: 0,
        spawnTimeEt: 0,
        upfront: 0,
        backed: true
      };
      for (const ref of pending) {
        const s = chain.stages[ref.stage].offer.steps[ref.step];
        inc.upkeepEt += s.cost.upkeepEt;
        inc.spawnTimeEt += s.cost.spawnTimeEt;
        inc.upfront += s.cost.upfront;
        if (!s.backedBy) inc.backed = false;
      }
      incs.push(inc);
      pending = [];
      lastMin = m;
    }
  }
  return incs;
}

function flowMagnitude(f: Flows): number {
  let m = f.controlPoints ?? 0;
  for (const place of Object.keys(f.energyAt ?? {})) m += (f.energyAt as Record<string, number>)[place];
  return m;
}

const EPS = 1e-9;

export function clear(input: MarketInput): EnginePlan {
  const frontier: FrontierLine[] = [];
  const funded = new Map<string, { offer: Offer; chain: string | null; steps: number[] }>();
  const fund = (offer: Offer, chain: string | null, stepIdx: number): void => {
    let f = funded.get(offer.id);
    if (!f) {
      f = { offer, chain, steps: [] };
      funded.set(offer.id, f);
    }
    f.steps.push(stepIdx);
  };

  interface LiveChain {
    chain: ChainCandidate;
    incs: Inc[];
    next: number;
  }
  const live: LiveChain[] = input.chains.map(c => ({ chain: c, incs: chainIncrements(c), next: 0 }));

  // Standing income: what already-living capital delivers before any
  // purchase — the leading fully-backed increments of every chain.
  let standingIncome = 0;
  for (const lc of live) {
    for (const inc of lc.incs) {
      if (!inc.backed) break;
      standingIncome += inc.delivered;
    }
  }

  const srcUsed: Record<string, number> = {};
  const srcFundedBy: Record<string, string[]> = {};
  const closed = new Set<string>();
  let spawnUsed = 0;
  let delivered = 0;
  let refill = 0;
  let standingEt = 0;

  const remainingOn = (sourceId: string | null): number => {
    if (sourceId === null) return Infinity;
    return (input.sourceCaps[sourceId] ?? Infinity) - (srcUsed[sourceId] ?? 0);
  };

  // Merit loop: every iteration funds one increment or closes one chain,
  // so it terminates. Ordering: standing capital first, then effective
  // net descending, chain id as the deterministic tiebreak.
  for (;;) {
    let best: LiveChain | null = null;
    let bestBacked = false;
    let bestNet = -Infinity;
    for (const lc of live) {
      if (closed.has(lc.chain.id) || lc.next >= lc.incs.length) continue;
      const cand = lc.incs[lc.next];
      const candEff = Math.min(cand.delivered, Math.max(remainingOn(lc.chain.sourceId), 0));
      const candNet = candEff - cand.upkeepEt;
      const better =
        best === null ||
        (cand.backed && !bestBacked) ||
        (cand.backed === bestBacked &&
          (candNet > bestNet + EPS || (Math.abs(candNet - bestNet) <= EPS && lc.chain.id < best.chain.id)));
      if (better) {
        best = lc;
        bestBacked = cand.backed;
        bestNet = candNet;
      }
    }
    if (!best) break;

    const inc = best.incs[best.next];
    const cid = best.chain.id;
    const srcId = best.chain.sourceId;
    const remaining = Math.max(remainingOn(srcId), 0);
    const eff = Math.min(inc.delivered, remaining);

    if (eff <= EPS) {
      const rivals = srcId ? (srcFundedBy[srcId] ?? []).filter(id => id !== cid) : [];
      frontier.push({
        offerId: cid,
        reason: rivals.length > 0 ? "outcompeted" : "source saturated",
        detail:
          rivals.length > 0 ? `${srcId ?? "?"} fully drawn by ${rivals.join(", ")}` : `${srcId ?? "?"} at its regen cap`
      });
      closed.add(cid);
      continue;
    }
    const net = eff - inc.upkeepEt;
    if (net <= EPS) {
      frontier.push({ offerId: cid, reason: "net<0", detail: `marginal net ${net.toFixed(2)} e/t` });
      closed.add(cid);
      continue;
    }
    if (spawnUsed + inc.spawnTimeEt > input.spawnCapacity + EPS) {
      frontier.push({
        offerId: cid,
        reason: "spawn capacity",
        detail: `needs ${inc.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
      });
      closed.add(cid);
      continue;
    }
    if (standingIncome <= EPS && inc.upfront > input.bankStock + EPS) {
      frontier.push({
        offerId: cid,
        reason: "ramp insolvent",
        detail: `needs ${inc.upfront}e up front, ${input.bankStock}e on hand, no standing income`
      });
      closed.add(cid);
      continue;
    }

    for (const ref of inc.steps) {
      const stage = best.chain.stages[ref.stage];
      fund(stage.offer, cid, ref.step);
    }
    spawnUsed += inc.spawnTimeEt;
    refill += inc.upkeepEt;
    delivered += eff;
    if (inc.backed) standingEt += eff;
    if (srcId !== null) {
      srcUsed[srcId] = (srcUsed[srcId] ?? 0) + eff;
      const by = srcFundedBy[srcId] ?? (srcFundedBy[srcId] = []);
      if (!by.includes(cid)) by.push(cid);
    }
    best.next += 1;
  }

  // Consumption draws the residual: inflow minus every funded parts bill.
  // Obligations (the bills) came first by construction; the controller
  // drinks what is left — the ladder as the bank's draw policy (piece 9).
  let residual = delivered - refill;
  let upgradeEt = 0;
  let standingUpgradeEt = 0;
  for (const sink of input.sinks) {
    for (let i = 0; i < sink.offer.steps.length; i++) {
      const s = sink.offer.steps[i];
      const draw = sink.burns[i] + s.cost.upkeepEt;
      if (spawnUsed + s.cost.spawnTimeEt > input.spawnCapacity + EPS) {
        frontier.push({
          offerId: sink.offer.id,
          reason: "spawn capacity",
          detail: `needs ${s.cost.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
        });
        break;
      }
      if (draw > residual + EPS) {
        frontier.push({
          offerId: sink.offer.id,
          reason: "energy residual",
          detail: `step needs ${draw.toFixed(2)} e/t, residual ${residual.toFixed(2)} e/t`
        });
        break;
      }
      fund(sink.offer, null, i);
      residual -= draw;
      refill += s.cost.upkeepEt;
      spawnUsed += s.cost.spawnTimeEt;
      upgradeEt += sink.burns[i];
      if (s.backedBy) standingUpgradeEt += sink.burns[i];
    }
  }

  const corps: CorpInstance[] = [];
  let minedEt = 0;
  for (const f of funded.values()) {
    let gross = 0;
    let cost = 0;
    let backed = 0;
    let body: Step["buys"] | null = null;
    for (const i of f.steps) {
      const s = f.offer.steps[i];
      gross += flowMagnitude(s.provides);
      cost += s.cost.upkeepEt;
      if (s.backedBy) backed += 1;
      else if (!body && s.buys) body = s.buys;
    }
    if (f.offer.kind === "mine" || f.offer.kind === "workman") minedEt += gross;
    corps.push({
      id: f.offer.id,
      kind: f.offer.kind,
      body: body ?? null,
      target: f.steps.length,
      backed,
      chain: f.chain,
      pnl: { grossEt: gross, costEt: cost, netEt: gross - cost }
    });
  }
  corps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return {
    tick: input.tick,
    corps,
    frontier,
    expected: { minedEt, deliveredEt: delivered, refillEt: refill, upgradeEt, standingEt, standingUpgradeEt }
  };
}
