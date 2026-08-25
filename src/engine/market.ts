import { PROJECT_RATE_WINDOW } from "../primitives";
import {
  CorpInstance,
  EnginePlan,
  Flows,
  FrontierLine,
  Offer,
  PlaceId,
  Step,
  addFlows,
  stepBillEt,
  stepMachineEt
} from "./vocabulary";

const RAMP_WINDOW = PROJECT_RATE_WINDOW;

export interface StageOption {
  offer: Offer;
  step: number;
  capacity: number;
}

export interface ChainStage {
  options: StageOption[];
}

export interface ChainCandidate {
  id: string;
  sourceId: string | null;
  stages: ChainStage[];
}

export interface SinkChain {
  stages: ChainStage[];
  capital?: boolean;
}

export interface MarketInput {
  tick: number;
  bank: PlaceId;
  chains: ChainCandidate[];
  sinks: SinkChain[];
  spawnCapacity: number;
  bankStock: number;
  sourceCaps: Record<string, number>;
  tender?: { offer: Offer; capacities: number[] } | null;
  standingBills?: number;
  standingSpawnEt?: number;
  holdingEt?: number;
  warchestTarget?: number;
}

interface OptRef {
  stage: number;
  option: number;
}

interface Inc {
  delivered: number;
  refs: OptRef[];
  upkeepEt: number;
  feeEt: number;
  spawnTimeEt: number;
  upfront: number;
  backed: boolean;
}

function stepOf(stages: ChainStage[], ref: OptRef): Step {
  const o = stages[ref.stage].options[ref.option];
  return o.offer.steps[o.step];
}

function chainIncrements(stages: ChainStage[]): Inc[] {
  const n = stages.length;
  const cum: number[] = new Array<number>(n).fill(0);
  const ptr: number[] = new Array<number>(n).fill(0);
  let lastMin = 0;
  let pending: OptRef[] = [];
  const incs: Inc[] = [];
  for (;;) {
    let minIdx = 0;
    for (let i = 1; i < n; i++) if (cum[i] < cum[minIdx]) minIdx = i;
    const stage = stages[minIdx];
    if (ptr[minIdx] >= stage.options.length) break;
    const optionIdx = ptr[minIdx];
    ptr[minIdx] += 1;
    cum[minIdx] += stage.options[optionIdx].capacity;
    pending.push({ stage: minIdx, option: optionIdx });
    const m = Math.min(...cum);
    if (m > lastMin) {
      const inc: Inc = {
        delivered: m - lastMin,
        refs: pending,
        upkeepEt: 0,
        feeEt: 0,
        spawnTimeEt: 0,
        upfront: 0,
        backed: true
      };
      for (const ref of pending) {
        const s = stepOf(stages, ref);
        inc.upkeepEt += s.cost.upkeepEt;
        inc.feeEt += s.cost.feeEt ?? 0;
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
  let m = (f.controlPoints ?? 0) + (f.progress ?? 0);
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
    if (f.offer === offer && f.steps.indexOf(stepIdx) >= 0) return;
    f.steps.push(stepIdx);
  };

  const charged = new Map<Offer, Set<number>>();
  const chargeOf = (
    stages: ChainStage[],
    refs: OptRef[],
    commit: boolean
  ): { upkeepEt: number; feeEt: number; spawnTimeEt: number } => {
    const out = { upkeepEt: 0, feeEt: 0, spawnTimeEt: 0 };
    for (const ref of refs) {
      const o = stages[ref.stage].options[ref.option];
      let set = charged.get(o.offer);
      if (set && set.has(o.step)) continue;
      const s = o.offer.steps[o.step];
      out.upkeepEt += s.cost.upkeepEt;
      out.feeEt += s.cost.feeEt ?? 0;
      out.spawnTimeEt += s.cost.spawnTimeEt;
      if (commit) {
        if (!set) {
          set = new Set<number>();
          charged.set(o.offer, set);
        }
        set.add(o.step);
      }
    }
    return out;
  };

  const alloc = new Map<string, number>();
  const allocateChain = (stages: ChainStage[], fundedPerStage: number[], flow: number): void => {
    for (let si = 0; si < stages.length; si++) {
      let rem = flow;
      for (let oi = 0; oi < fundedPerStage[si]; oi++) {
        const o = stages[si].options[oi];
        const take = Math.min(rem, o.capacity);
        alloc.set(o.offer.id, (alloc.get(o.offer.id) ?? 0) + take);
        rem -= take;
      }
    }
  };

  interface LiveChain {
    chain: ChainCandidate;
    incs: Inc[];
    next: number;
    flow: number;
    fundedPerStage: number[];
  }
  const live: LiveChain[] = input.chains.map(c => ({
    chain: c,
    incs: chainIncrements(c.stages),
    next: 0,
    flow: 0,
    fundedPerStage: c.stages.map(() => 0)
  }));

  const srcUsed: Record<string, number> = {};
  const srcFundedBy: Record<string, string[]> = {};
  const closed = new Set<string>();
  let spawnUsed = input.standingSpawnEt ?? 0;
  if (spawnUsed > input.spawnCapacity + EPS) {
    frontier.push({
      offerId: "spawning:capacity",
      reason: "spawn capacity",
      detail:
        `standing sustain ${spawnUsed.toFixed(4)} p/t exceeds the machine's ` +
        `${input.spawnCapacity.toFixed(4)} p/t — fleet unsustainable; new bodies blocked`
    });
  }
  const sinkIncs = input.sinks.map(s => chainIncrements(s.stages));
  let capitalReserve = 0;
  input.sinks.forEach((sink, i) => {
    if (!sink.capital) return;
    for (const inc of sinkIncs[i]) capitalReserve += inc.spawnTimeEt;
  });
  capitalReserve = Math.min(capitalReserve, Math.max(input.spawnCapacity - spawnUsed, 0));
  let delivered = 0;
  let refill = 0;
  let fees = 0;
  let standingEt = 0;
  let standingFees = 0;

  const remainingOn = (sourceId: string | null): number => {
    if (sourceId === null) return Infinity;
    return (input.sourceCaps[sourceId] ?? Infinity) - (srcUsed[sourceId] ?? 0);
  };

  const fundInc = (lc: LiveChain, inc: Inc): void => {
    const eff = Math.min(inc.delivered, Math.max(remainingOn(lc.chain.sourceId), 0));
    const c = chargeOf(lc.chain.stages, inc.refs, true);
    for (const ref of inc.refs) {
      const o = lc.chain.stages[ref.stage].options[ref.option];
      fund(o.offer, lc.chain.id, o.step);
      lc.fundedPerStage[ref.stage] = Math.max(lc.fundedPerStage[ref.stage], ref.option + 1);
    }
    spawnUsed += c.spawnTimeEt;
    refill += c.upkeepEt;
    fees += c.feeEt;
    delivered += eff;
    lc.flow += eff;
    if (inc.backed) {
      standingEt += eff;
      standingFees += c.feeEt;
    }
    const srcId = lc.chain.sourceId;
    if (srcId !== null) {
      srcUsed[srcId] = (srcUsed[srcId] ?? 0) + eff;
      const by = srcFundedBy[srcId] ?? (srcFundedBy[srcId] = []);
      if (!by.includes(lc.chain.id)) by.push(lc.chain.id);
    }
    lc.next += 1;
  };

  for (const lc of live) {
    while (lc.next < lc.incs.length && lc.incs[lc.next].backed) {
      if (Math.min(lc.incs[lc.next].delivered, Math.max(remainingOn(lc.chain.sourceId), 0)) <= EPS) break;
      fundInc(lc, lc.incs[lc.next]);
    }
  }

  interface Bid {
    lc: LiveChain;
    count: number;
    eff: number;
    costEt: number;
    spawnTimeEt: number;
    upfront: number;
    net: number;
    rampBlocked?: boolean;
  }
  const accumulationEt = Math.max(standingEt - (input.standingBills ?? 0) - (input.holdingEt ?? 0), 0);
  const affordCeiling = input.bankStock + accumulationEt * RAMP_WINDOW;
  const bestBid = (lc: LiveChain): Bid | null => {
    if (closed.has(lc.chain.id) || lc.next >= lc.incs.length) return null;
    const room = Math.max(remainingOn(lc.chain.sourceId), 0);
    let dCum = 0;
    let cost = 0;
    let spawn = 0;
    let upfront = 0;
    let bid: Bid | null = null;
    for (let k = lc.next; k < lc.incs.length; k++) {
      const inc = lc.incs[k];
      dCum += inc.delivered;
      cost += inc.upkeepEt + inc.feeEt;
      spawn += inc.spawnTimeEt;
      upfront += inc.upfront;
      if (upfront > affordCeiling + EPS) break;
      const eff = Math.min(dCum, room);
      const net = eff - cost;
      if (!bid || net > bid.net + EPS) {
        bid = { lc, count: k - lc.next + 1, eff, costEt: cost, spawnTimeEt: spawn, upfront, net };
      }
    }
    if (!bid) {
      return { lc, count: 0, eff: 0, costEt: 0, spawnTimeEt: 0, upfront, net: -Infinity, rampBlocked: true };
    }
    return bid;
  };

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
        detail:
          `needs ${best.upfront}e up front, ${input.bankStock}e on hand ` +
          `+ ${(affordCeiling - input.bankStock).toFixed(0)}e of near-term accumulation`
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
    if (best.spawnTimeEt > EPS && spawnUsed + best.spawnTimeEt > input.spawnCapacity - capitalReserve + EPS) {
      frontier.push({
        offerId: cid,
        reason: "spawn capacity",
        detail:
          `needs ${best.spawnTimeEt.toFixed(4)} p/t, ` +
          `${Math.max(input.spawnCapacity - capitalReserve - spawnUsed, 0).toFixed(4)} p/t free` +
          (capitalReserve > EPS ? ` (${capitalReserve.toFixed(4)} reserved for construction)` : "")
      });
      closed.add(cid);
      continue;
    }
    for (let k = 0; k < best.count; k++) fundInc(best.lc, best.lc.incs[best.lc.next]);
  }

  for (const lc of live) if (lc.flow > EPS) allocateChain(lc.chain.stages, lc.fundedPerStage, lc.flow);

  const heartbeat = (): number => refill + (input.standingBills ?? 0);
  let tenderIntake = 0;
  let tenderBlocked = false;
  if (input.tender && heartbeat() > EPS) {
    const t = input.tender;
    for (let i = 0; i < t.offer.steps.length && tenderIntake < heartbeat() - EPS; i++) {
      const s = t.offer.steps[i];
      if (s.cost.spawnTimeEt > EPS && spawnUsed + s.cost.spawnTimeEt > input.spawnCapacity + EPS) {
        frontier.push({
          offerId: t.offer.id,
          reason: "spawn capacity",
          detail: `needs ${s.cost.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
        });
        tenderBlocked = true;
        break;
      }
      fund(t.offer, null, i);
      tenderIntake += t.capacities[i];
      refill += s.cost.upkeepEt;
      spawnUsed += s.cost.spawnTimeEt;
    }
  }

  let residual = delivered - refill - fees - (input.standingBills ?? 0) - (input.holdingEt ?? 0);
  let upgradeEt = 0;
  let standingUpgradeEt = 0;
  let buildEt = 0;
  let standingBuildEt = 0;
  const drawSink = (sink: SinkChain, incs: Inc[]): void => {
    if (sink.stages.length === 0) return;
    const lastStage = sink.stages[sink.stages.length - 1];
    const sinkOffer = lastStage.options.length > 0 ? lastStage.options[0].offer : null;
    if (!sinkOffer) return;
    const fundedPerStage = sink.stages.map(() => 0);
    let flow = 0;
    for (const inc of incs) {
      const c = chargeOf(sink.stages, inc.refs, false);
      if (c.spawnTimeEt > EPS && spawnUsed + c.spawnTimeEt > input.spawnCapacity + EPS) {
        frontier.push({
          offerId: sinkOffer.id,
          reason: "spawn capacity",
          detail: `needs ${c.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
        });
        break;
      }
      const bills = c.upkeepEt + c.feeEt;
      const wanted = sink.capital ? 0 : inc.delivered;
      const grant = Math.min(wanted, Math.max(residual - bills, 0));
      if (bills > residual + EPS || (!sink.capital && grant <= EPS)) {
        frontier.push({
          offerId: sinkOffer.id,
          reason: "energy residual",
          detail: `step needs ${(wanted + bills).toFixed(2)} e/t, residual ${residual.toFixed(2)} e/t`
        });
        break;
      }
      chargeOf(sink.stages, inc.refs, true);
      for (const ref of inc.refs) {
        const o = sink.stages[ref.stage].options[ref.option];
        fund(o.offer, null, o.step);
        fundedPerStage[ref.stage] = Math.max(fundedPerStage[ref.stage], ref.option + 1);
      }
      residual -= bills + grant;
      refill += c.upkeepEt;
      fees += c.feeEt;
      spawnUsed += c.spawnTimeEt;
      if (inc.backed) standingFees += c.feeEt;
      const produced = sink.capital ? inc.delivered : grant;
      flow += produced;
      if (sink.capital) {
        buildEt += produced;
        if (inc.backed) standingBuildEt += produced;
      } else {
        upgradeEt += produced;
        if (inc.backed) standingUpgradeEt += produced;
      }
      if (grant < wanted - EPS) {
        residual = 0;
        frontier.push({
          offerId: sinkOffer.id,
          reason: "energy residual",
          detail: `last step trims to ${grant.toFixed(2)} of ${inc.delivered.toFixed(2)} e/t — residual drained`
        });
        break;
      }
    }
    if (flow > EPS) allocateChain(sink.stages, fundedPerStage, flow);
  };

  capitalReserve = 0;
  input.sinks.forEach((sink, i) => {
    if (sink.capital) drawSink(sink, sinkIncs[i]);
  });

  let warchestEt = 0;
  if ((input.warchestTarget ?? 0) > input.bankStock + EPS && residual > EPS) {
    warchestEt = residual;
    residual = 0;
  }

  input.sinks.forEach((sink, i) => {
    if (!sink.capital) drawSink(sink, sinkIncs[i]);
  });

  if (input.tender && !tenderBlocked && tenderIntake < heartbeat() - EPS) {
    frontier.push({
      offerId: input.tender.offer.id,
      reason: "tender short",
      detail: `intake covers ${tenderIntake.toFixed(2)} of the ${heartbeat().toFixed(2)} e/t obligation`
    });
  }

  const corps: CorpInstance[] = [];
  let minedEt = 0;
  for (const f of funded.values()) {
    let quoted = 0;
    for (const i of f.steps) quoted += flowMagnitude(f.offer.steps[i].provides);
    const u = quoted > EPS ? Math.min((alloc.get(f.offer.id) ?? quoted) / quoted, 1) : 0;
    let gross = 0;
    let cost = 0;
    let backed = 0;
    const staff: CorpInstance["staff"] = [];
    const inputs: Flows = {};
    const outputs: Flows = {};
    for (const i of f.steps) {
      const s = f.offer.steps[i];
      const bill = stepBillEt(s);
      const machine = stepMachineEt(s);
      gross += flowMagnitude(s.provides) * u;
      cost += bill;
      addFlows(outputs, s.provides, u);
      addFlows(inputs, s.requires, u);
      if (machine > 0) addFlows(inputs, { spawnTime: machine });
      if (bill > 0) addFlows(inputs, { energyAt: { [input.bank]: bill } });
      if (s.backedBy) backed += 1;
      if (s.body) staff.push({ body: s.body, live: s.backedBy ?? null });
    }
    if (f.offer.kind === "mine" || f.offer.kind === "workman") minedEt += gross;
    corps.push({
      id: f.offer.id,
      kind: f.offer.kind,
      staff,
      target: f.steps.length,
      backed,
      chain: f.chain,
      pnl: { grossEt: gross, costEt: cost, netEt: gross - cost },
      inputs,
      outputs
    });
  }
  corps.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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
    approvals: [],
    positions,
    violations,
    expected: {
      minedEt,
      deliveredEt: delivered,
      refillEt: refill,
      feesEt: fees,
      upgradeEt,
      buildEt,
      warchestEt,
      holdingEt: input.holdingEt ?? 0,
      standingEt,
      standingUpgradeEt,
      standingBuildEt,
      standingRefillEt: input.standingBills ?? 0,
      standingFeesEt: standingFees
    }
  };
}
