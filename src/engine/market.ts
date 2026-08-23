/**
 * market.ts — the kind-agnostic clearing core: offers in, funded plan +
 * blocked frontier out. It holds NO domain knowledge — it never sees a
 * body, a route, or a source, only schedules of steps with capacities and
 * costs — so it cannot accumulate case logic (piece 6: the engine is too
 * small to hide anything in). The corp kinds price; this module combines.
 *
 * Depth-0 clearing IS the greedy merit-order loop, in two phases. Phase 1:
 * standing capital holds its funding (piece 5) — every chain's leading
 * fully-backed increments fund first. Phase 2: chains BID THEIR BEST
 * MARGINAL PREFIX of remaining increments (the best scale, not the next
 * lump — a degenerate sliver increment from stage quantization can never
 * hide the profitable scale behind it), highest net funds, and a bid that
 * fails a constraint closes its chain with the frontier line saying which
 * arithmetic stopped it. Ramp solvency (piece 8's heartbeat constraint)
 * binds at bid time: with no standing income a bid is only as big as the
 * stock that can buy it, so the workman root emerges as the largest
 * affordable prefix — no mode. Consumption then draws the residual,
 * ladder-style.
 *
 * An increment that only half-fits its source funds TRIMMED (the body is
 * quantized, the flow is not): the challenger enters at reduced delivery
 * rather than deadlocking against incumbents — the stranded remainder is
 * plainly visible as mined-vs-delivered surplus, first lab question.
 */
import { CorpInstance, EnginePlan, Flows, FrontierLine, Offer, PlaceId, Step, addFlows } from "./vocabulary";

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

/** A consumption chain toward a sink: transport stages first, the burner
 * last, capacities in the sink's burn currency (e/t at the feed point).
 * The whole chain draws the residual — burn plus every stage's bill — so
 * a distant controller pays for its feed like a distant source pays for
 * its haul: same zipper, same route law, opposite direction. */
export interface SinkChain {
  stages: ChainStage[];
}

export interface MarketInput {
  tick: number;
  bank: PlaceId;
  chains: ChainCandidate[];
  sinks: SinkChain[];
  /** Machine-time capacity, parts/tick (Σ spawning provides). */
  spawnCapacity: number;
  bankStock: number;
  /** Regen caps by source id, e/t. */
  sourceCaps: Record<string, number>;
  /** The spawning corp's refill-intake schedule: tender steps and their
   * per-step capacity (e/t into the estate). Funded last, to cover the
   * whole refill obligation. */
  tender?: { offer: Offer; capacities: number[] } | null;
  /** The live fleet's sustain bill (Σ amortized body costs), from the
   * broker. Backed steps quote zero (sunk pricing), so the funded-step
   * refill line alone understates the heartbeat — the tender must cover
   * standing bills too. */
  standingBills?: number;
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

  // Allocated end-to-end flow per offer: every stage of a chain carries
  // the chain's REALIZED flow, whatever its quoted capacity. The position
  // book nets these — capacity idle is a corp's own business; unmatched
  // flow is a plan bug.
  const alloc = new Map<string, number>();
  const allocAdd = (id: string, amount: number): void => {
    alloc.set(id, (alloc.get(id) ?? 0) + amount);
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

  const fundInc = (lc: LiveChain, inc: Inc): void => {
    const eff = Math.min(inc.delivered, Math.max(remainingOn(lc.chain.sourceId), 0));
    for (const ref of inc.steps) fund(lc.chain.stages[ref.stage].offer, lc.chain.id, ref.step);
    for (const stage of lc.chain.stages) allocAdd(stage.offer.id, eff);
    spawnUsed += inc.spawnTimeEt;
    refill += inc.upkeepEt;
    delivered += eff;
    if (inc.backed) standingEt += eff;
    const srcId = lc.chain.sourceId;
    if (srcId !== null) {
      srcUsed[srcId] = (srcUsed[srcId] ?? 0) + eff;
      const by = srcFundedBy[srcId] ?? (srcFundedBy[srcId] = []);
      if (!by.includes(lc.chain.id)) by.push(lc.chain.id);
    }
    lc.next += 1;
  };

  // Phase 1 — standing capital holds its funding (piece 5): every chain's
  // leading fully-backed increments fund first, trimmed to their source.
  for (const lc of live) {
    while (lc.next < lc.incs.length && lc.incs[lc.next].backed) {
      if (Math.min(lc.incs[lc.next].delivered, Math.max(remainingOn(lc.chain.sourceId), 0)) <= EPS) break;
      fundInc(lc, lc.incs[lc.next]);
    }
  }

  /** A chain's bid: the best PREFIX of its remaining increments, trimmed to
   * the source room left. Bidding whole bundles keeps a degenerate sliver
   * increment (a stage-quantization artifact) from hiding the profitable
   * scale behind it — the bid is the best marginal SCALE, not the next
   * lump. Still depth-0: no lookahead through anything unbuilt. */
  interface Bid {
    lc: LiveChain;
    count: number;
    eff: number;
    upkeepEt: number;
    spawnTimeEt: number;
    upfront: number;
    net: number;
    /** Set when every prefix was unaffordable under the ramp bound: the
     * chain cannot start from stock — piece 8's filter, at bid time. */
    rampBlocked?: boolean;
  }
  const bestBid = (lc: LiveChain): Bid | null => {
    if (closed.has(lc.chain.id) || lc.next >= lc.incs.length) return null;
    // With no standing income, a bid is only as big as the stock that can
    // buy it — the root emerges as the largest affordable prefix.
    const rampBound = standingIncome <= EPS;
    const room = Math.max(remainingOn(lc.chain.sourceId), 0);
    let dCum = 0;
    let upkeep = 0;
    let spawn = 0;
    let upfront = 0;
    let bid: Bid | null = null;
    for (let k = lc.next; k < lc.incs.length; k++) {
      const inc = lc.incs[k];
      dCum += inc.delivered;
      upkeep += inc.upkeepEt;
      spawn += inc.spawnTimeEt;
      upfront += inc.upfront;
      if (rampBound && upfront > input.bankStock + EPS) break;
      const eff = Math.min(dCum, room);
      const net = eff - upkeep;
      if (!bid || net > bid.net + EPS) {
        bid = { lc, count: k - lc.next + 1, eff, upkeepEt: upkeep, spawnTimeEt: spawn, upfront, net };
      }
    }
    if (!bid) {
      return { lc, count: 0, eff: 0, upkeepEt: 0, spawnTimeEt: 0, upfront, net: -Infinity, rampBlocked: true };
    }
    return bid;
  };

  // Phase 2 — the merit loop: chains bid their best prefix; the highest
  // net funds; a bid that fails a constraint closes its chain with the
  // frontier line saying which arithmetic stopped it.
  for (;;) {
    let best: Bid | null = null;
    for (const lc of live) {
      const bid = bestBid(lc);
      if (!bid) continue;
      if (
        !best ||
        bid.net > best.net + EPS ||
        (Math.abs(bid.net - best.net) <= EPS && bid.lc.chain.id < best.lc.chain.id)
      ) {
        best = bid;
      }
    }
    if (!best) break;

    const cid = best.lc.chain.id;
    const srcId = best.lc.chain.sourceId;
    if (best.rampBlocked) {
      frontier.push({
        offerId: cid,
        reason: "ramp insolvent",
        detail: `needs ${best.upfront}e up front, ${input.bankStock}e on hand, no standing income`
      });
      closed.add(cid);
      continue;
    }
    if (best.eff <= EPS) {
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
    if (best.net <= EPS) {
      frontier.push({ offerId: cid, reason: "net<0", detail: `best marginal net ${best.net.toFixed(2)} e/t` });
      closed.add(cid);
      continue;
    }
    if (spawnUsed + best.spawnTimeEt > input.spawnCapacity + EPS) {
      frontier.push({
        offerId: cid,
        reason: "spawn capacity",
        detail: `needs ${best.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
      });
      closed.add(cid);
      continue;
    }
    for (let k = 0; k < best.count; k++) fundInc(best.lc, best.lc.incs[best.lc.next]);
  }

  // The heartbeat's carrier funds BEFORE the controller drinks (the ladder:
  // obligations first — piece 9): tender intake to cover the whole refill
  // obligation (owner 2026-08-23 — the spawning corp's own bodies, never a
  // haul job). Each funded tender adds its own bill to the obligation it
  // serves, so the loop runs until intake covers it.
  const heartbeat = (): number => refill + (input.standingBills ?? 0);
  if (input.tender && heartbeat() > EPS) {
    const t = input.tender;
    let intake = 0;
    for (let i = 0; i < t.offer.steps.length && intake < heartbeat() - EPS; i++) {
      const s = t.offer.steps[i];
      if (spawnUsed + s.cost.spawnTimeEt > input.spawnCapacity + EPS) {
        frontier.push({
          offerId: t.offer.id,
          reason: "spawn capacity",
          detail: `needs ${s.cost.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
        });
        break;
      }
      fund(t.offer, null, i);
      intake += t.capacities[i];
      refill += s.cost.upkeepEt;
      spawnUsed += s.cost.spawnTimeEt;
    }
  }

  // Consumption draws the residual: inflow minus every funded parts bill.
  // Obligations (the bills, the tender) came first by construction; the
  // controller drinks what is left — the ladder as the bank's draw policy.
  let residual = delivered - refill;
  let upgradeEt = 0;
  let standingUpgradeEt = 0;
  for (const sink of input.sinks) {
    if (sink.stages.length === 0) continue;
    const sinkOffer = sink.stages[sink.stages.length - 1].offer;
    const incs = chainIncrements({ id: `sink:${sinkOffer.id}`, sourceId: null, stages: sink.stages });
    for (const inc of incs) {
      const draw = inc.delivered + inc.upkeepEt;
      if (spawnUsed + inc.spawnTimeEt > input.spawnCapacity + EPS) {
        frontier.push({
          offerId: sinkOffer.id,
          reason: "spawn capacity",
          detail: `needs ${inc.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
        });
        break;
      }
      if (draw > residual + EPS) {
        frontier.push({
          offerId: sinkOffer.id,
          reason: "energy residual",
          detail: `step needs ${draw.toFixed(2)} e/t, residual ${residual.toFixed(2)} e/t`
        });
        break;
      }
      for (const ref of inc.steps) fund(sink.stages[ref.stage].offer, null, ref.step);
      for (const stage of sink.stages) allocAdd(stage.offer.id, inc.delivered);
      residual -= draw;
      refill += inc.upkeepEt;
      spawnUsed += inc.spawnTimeEt;
      upgradeEt += inc.delivered;
      if (inc.backed) standingUpgradeEt += inc.delivered;
    }
  }

  const corps: CorpInstance[] = [];
  let minedEt = 0;
  for (const f of funded.values()) {
    // Utilization: allocated flow over quoted capacity. The rows state the
    // trade that actually MATCHES — a whole body bought for a partial flow
    // shows the flow; the idle capacity is the corp's own business. Bills
    // and machine time stay full: the body is owned entirely either way.
    let quoted = 0;
    for (const i of f.steps) quoted += flowMagnitude(f.offer.steps[i].provides);
    const u = quoted > EPS ? Math.min((alloc.get(f.offer.id) ?? quoted) / quoted, 1) : 0;
    let gross = 0;
    let cost = 0;
    let backed = 0;
    let body: Step["buys"] | null = null;
    const inputs: Flows = {};
    const outputs: Flows = {};
    for (const i of f.steps) {
      const s = f.offer.steps[i];
      gross += flowMagnitude(s.provides) * u;
      cost += s.cost.upkeepEt;
      addFlows(outputs, s.provides, u);
      addFlows(inputs, s.requires, u);
      // Ownership is an input too: machine time, and the parts bill drawn
      // at the bank branch.
      if (s.cost.spawnTimeEt > 0) addFlows(inputs, { spawnTime: s.cost.spawnTimeEt });
      if (s.cost.upkeepEt > 0) addFlows(inputs, { energyAt: { [input.bank]: s.cost.upkeepEt } });
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
      pnl: { grossEt: gross, costEt: cost, netEt: gross - cost },
      inputs,
      outputs
    });
  }
  corps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // The position book (piece 1's second view), netted from the instances'
  // own allocated rows: supply and demand per place, energy column. The
  // bank is the counterparty and nets the leftover; any OTHER place with a
  // residue means the plan funded a match that does not exist — the exact
  // bug class this book exists to make impossible to miss.
  const book: Record<string, { supply: number; demand: number }> = {};
  const bookAt = (p: string): { supply: number; demand: number } => book[p] ?? (book[p] = { supply: 0, demand: 0 });
  bookAt(input.bank);
  for (const c of corps) {
    const out = c.outputs.energyAt ?? {};
    for (const p of Object.keys(out)) bookAt(p).supply += out[p];
    const inn = c.inputs.energyAt ?? {};
    for (const p of Object.keys(inn)) bookAt(p).demand += inn[p];
  }
  const positions = Object.keys(book)
    .sort()
    .map(place => ({
      place,
      supplyEt: book[place].supply,
      demandEt: book[place].demand,
      netEt: book[place].supply - book[place].demand
    }));
  const violations: string[] = [];
  for (const row of positions) {
    if (row.place === input.bank || Math.abs(row.netEt) <= 0.01) continue;
    violations.push(
      row.netEt < 0
        ? `unmatched demand at ${row.place}: ${row.demandEt.toFixed(2)} e/t required, ${row.supplyEt.toFixed(
            2
          )} provided`
        : `stranded supply at ${row.place}: ${row.supplyEt.toFixed(2)} e/t provided, ${row.demandEt.toFixed(2)} drawn`
    );
  }

  return {
    tick: input.tick,
    corps,
    frontier,
    positions,
    violations,
    expected: {
      minedEt,
      deliveredEt: delivered,
      refillEt: refill,
      upgradeEt,
      standingEt,
      standingUpgradeEt,
      standingRefillEt: input.standingBills ?? 0
    }
  };
}
