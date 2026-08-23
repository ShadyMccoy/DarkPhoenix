/**
 * market.ts — the kind-agnostic clearing core: offers in, funded plan +
 * blocked frontier out. It holds NO domain knowledge — it never sees a
 * body, a route, or a source, only schedules of options with capacities
 * and costs — so it cannot accumulate case logic (piece 6: the engine is
 * too small to hide anything in). The corp kinds price; this combines.
 *
 * A stage is an ORDER BOOK: options from any number of offers, sorted by
 * the broker cheapest-marginal-first, consumed in order by the zipper. A
 * haul body and a link volley compete inside one stage — "the engine
 * funds whichever wins the edge" (piece 5) is literally the sort order.
 *
 * Depth-0 clearing runs in two phases. Phase 1: standing capital holds
 * its funding — every chain's leading fully-backed increments fund first.
 * Phase 2: chains BID THEIR BEST MARGINAL PREFIX of remaining increments
 * (the best scale, not the next lump), highest net funds, and a bid that
 * fails a constraint closes its chain with the frontier line saying which
 * arithmetic stopped it. Ramp solvency (piece 8's heartbeat constraint)
 * binds at bid time: with no standing income a bid is only as big as the
 * stock that can buy it — the workman root emerges as the largest
 * affordable prefix, and a candidate structure's capex gates the same
 * way. The tender then covers the whole heartbeat, and consumption draws
 * the residual, ladder-style.
 *
 * Costs split three ways: upkeepEt is the parts bill (the heartbeat's
 * column, what the tender carries); feeEt is an operating charge that is
 * NOT a spawn bill (the link's tax, a candidate's capex over HORIZON) —
 * it enters net, P&L and the bank's demand column, never the refill
 * obligation; upfront is cash at purchase, checked by solvency and paid
 * by the believer's bank.
 */
import { PROJECT_RATE_WINDOW } from "../primitives";
import { CorpInstance, EnginePlan, Flows, FrontierLine, Offer, PlaceId, Step, addFlows } from "./vocabulary";

/** How far ahead ramp solvency may count standing accumulation — one
 * project window: the same near-term the build corp plans in. */
const RAMP_WINDOW = PROJECT_RATE_WINDOW;

/** One tradable unit on a stage's order book: a step of some offer, with
 * its capacity in the chain's delivered currency (e/t). */
export interface StageOption {
  offer: Offer;
  step: number;
  capacity: number;
}

export interface ChainStage {
  /** Sorted by the broker: standing capital first, then cheapest marginal
   * cost per unit — who wins the edge is decided here. */
  options: StageOption[];
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
 * The whole chain draws the residual — burn plus every stage's bill. */
export interface SinkChain {
  stages: ChainStage[];
  /** CAPITAL sinks (construction) draw their burn from STOCK — the
   * approval already reserved it (piece 9: investments draw from stock,
   * not live flow) — so only their BILLS ride the residual, and they fund
   * before the controller drinks (the bank's draw policy). */
  capital?: boolean;
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
   * per-step capacity (e/t into the estate). */
  tender?: { offer: Offer; capacities: number[] } | null;
  /** The live fleet's sustain bill (Σ amortized body costs), from the
   * broker. Backed steps quote zero (sunk pricing), so the funded-step
   * refill line alone understates the heartbeat. */
  standingBills?: number;
  /** The live fleet's sustain machine time (Σ spawnTimeEt over live
   * bodies) — seeds spawnUsed so the capacity constraint holds across
   * replans instead of eroding as steps become backed. */
  standingSpawnEt?: number;
  /** The bank branch's holding cost at today's stock, from the broker
   * (the market never sees branches — just the bill). Off the top of
   * the residual: rot happens whether or not anything funds. */
  holdingEt?: number;
  /** Stock the bank must hold or accumulate: open sites' remaining capex
   * plus every `awaiting stock` candidate's. While bankStock sits below
   * this, the residual BANKS instead of burning — the warchest as the
   * reserve band (piece 9), production over consumption made structural. */
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
  /** Every option already embodied — standing capital. */
  backed: boolean;
}

function stepOf(stages: ChainStage[], ref: OptRef): Step {
  const o = stages[ref.stage].options[ref.option];
  return o.offer.steps[o.step];
}

/**
 * Zip a chain's stages into delivered increments: repeatedly extend the
 * bottleneck stage (lowest cumulative capacity) one option; each rise of
 * the cross-stage minimum emits an increment carrying the options that
 * produced it. A miner option waits inside `pending` until a transport
 * option makes its energy deliverable — increments price END-TO-END.
 */
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
    f.steps.push(stepIdx);
  };

  // Allocated end-to-end flow per offer: assigned to a stage's funded
  // options IN BOOK ORDER after funding settles, so every offer carries
  // its realized share, whatever its quoted capacity. The position book
  // nets these — idle capacity is a corp's own business; unmatched flow
  // is a plan bug.
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
  // Machine time starts at the LIVE fleet's sustain draw, not zero:
  // backed steps quote sunk spawnTimeEt, so without this seed the
  // capacity constraint eroded to nothing across replans — each replan
  // saw a free spawn and funded more, without bound (stress-hunt
  // confirmed finding, 2026-08-23; the standingBills pattern, applied to
  // the spawnTime currency).
  let spawnUsed = input.standingSpawnEt ?? 0;
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
    for (const ref of inc.refs) {
      const o = lc.chain.stages[ref.stage].options[ref.option];
      fund(o.offer, lc.chain.id, o.step);
      lc.fundedPerStage[ref.stage] = Math.max(lc.fundedPerStage[ref.stage], ref.option + 1);
    }
    spawnUsed += inc.spawnTimeEt;
    refill += inc.upkeepEt;
    fees += inc.feeEt;
    delivered += eff;
    lc.flow += eff;
    if (inc.backed) {
      standingEt += eff;
      standingFees += inc.feeEt;
    }
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

  /** A chain's bid: the best PREFIX of its remaining increments, trimmed
   * to the source room left. Bidding whole bundles keeps a degenerate
   * sliver increment (a quantization artifact) from hiding the profitable
   * scale behind it. Still depth-0: a candidate structure in an option is
   * one build ahead, priced at full cost — nothing deeper. */
  interface Bid {
    lc: LiveChain;
    count: number;
    eff: number;
    costEt: number;
    spawnTimeEt: number;
    upfront: number;
    net: number;
    /** Set when every prefix was unaffordable under the ramp bound. */
    rampBlocked?: boolean;
  }
  // The ramp-solvency ceiling, CONTINUOUS: a bid's upfront must be
  // buyable from stock plus ONE PROJECT WINDOW of standing accumulation
  // (income net of the fleet's bills and the branch's rot). The old
  // binary rule — any standing income lifts the bound entirely — let one
  // 1.25 e/t workman authorize a 950e specialist chain the executor
  // could not buy for a hundred chunks, while the plan refused the
  // affordable workmen that would have grown the income (session
  // finding 2026-08-23: the bootstrap stalled at one body forever).
  // Cold start reduces to the old rule: no income, stock alone.
  const accumulationEt = Math.max(standingIncome - (input.standingBills ?? 0) - (input.holdingEt ?? 0), 0);
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

  for (const lc of live) if (lc.flow > EPS) allocateChain(lc.chain.stages, lc.fundedPerStage, lc.flow);

  // The heartbeat's carrier funds BEFORE the controller drinks (the
  // ladder: obligations first — piece 9): tender intake to cover the
  // whole refill obligation (owner 2026-08-23 — the spawning corp's own
  // bodies, never a haul job).
  const heartbeat = (): number => refill + (input.standingBills ?? 0);
  if (input.tender && heartbeat() > EPS) {
    const t = input.tender;
    let intake = 0;
    let blocked = false;
    for (let i = 0; i < t.offer.steps.length && intake < heartbeat() - EPS; i++) {
      const s = t.offer.steps[i];
      if (spawnUsed + s.cost.spawnTimeEt > input.spawnCapacity + EPS) {
        frontier.push({
          offerId: t.offer.id,
          reason: "spawn capacity",
          detail: `needs ${s.cost.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
        });
        blocked = true;
        break;
      }
      fund(t.offer, null, i);
      intake += t.capacities[i];
      refill += s.cost.upkeepEt;
      spawnUsed += s.cost.spawnTimeEt;
    }
    // An uncovered heartbeat is NEVER silent (the axiom, printed): the
    // schedule ran out below the obligation — v1's silent under-coverage
    // class, closed at the chokepoint.
    if (!blocked && intake < heartbeat() - EPS) {
      frontier.push({
        offerId: t.offer.id,
        reason: "tender short",
        detail: `schedule exhausted at ${intake.toFixed(2)} e/t intake vs ${heartbeat().toFixed(2)} e/t obligation`
      });
    }
  }

  // Consumption draws the residual: inflow minus every funded bill and
  // fee AND the live fleet's sustain stream. Backed steps quote
  // sunk-zero, so `refill` alone understates the heartbeat by exactly
  // the standing fleet's amortized replacement — omitting it here let
  // the controller drink bills the bank still owed, draining it at
  // standingBills e/t until pinned (stress-hunt confirmed finding,
  // 2026-08-23). Obligations come off the top; capital formation funds
  // next (its BURN drawing stock, only its bills riding the residual);
  // the warchest banks toward blocked investments; the controller drinks
  // what is left — the ladder as the bank's draw policy (piece 9).
  let residual = delivered - refill - fees - (input.standingBills ?? 0) - (input.holdingEt ?? 0);
  let upgradeEt = 0;
  let standingUpgradeEt = 0;
  let buildEt = 0;
  let standingBuildEt = 0;
  const drawSink = (sink: SinkChain): void => {
    if (sink.stages.length === 0) return;
    const lastStage = sink.stages[sink.stages.length - 1];
    const sinkOffer = lastStage.options.length > 0 ? lastStage.options[0].offer : null;
    if (!sinkOffer) return;
    const incs = chainIncrements(sink.stages);
    const fundedPerStage = sink.stages.map(() => 0);
    let flow = 0;
    for (const inc of incs) {
      // A capital burn is a stock draw the approval already reserved;
      // only the bills are a claim on this tick's flow.
      const draw = (sink.capital ? 0 : inc.delivered) + inc.upkeepEt + inc.feeEt;
      if (spawnUsed + inc.spawnTimeEt > input.spawnCapacity + EPS) {
        frontier.push({
          offerId: sinkOffer.id,
          reason: "spawn capacity",
          detail: `needs ${inc.spawnTimeEt.toFixed(4)} p/t, ${(input.spawnCapacity - spawnUsed).toFixed(4)} p/t free`
        });
        break;
      }
      if (draw > residual + EPS) {
        // The last increment funds PARTIALLY: the burner scales to what
        // is left (utilization < 1 — allocation machinery, first-class).
        // Whole-step-only funding stranded the sub-quantum residual as
        // stock forever, and quantization noise swallowed counterfactual
        // deltas whole (session finding 2026-08-23).
        const partial = residual - inc.upkeepEt - inc.feeEt;
        if (!sink.capital && partial > EPS) {
          for (const ref of inc.refs) {
            const o = sink.stages[ref.stage].options[ref.option];
            fund(o.offer, null, o.step);
            fundedPerStage[ref.stage] = Math.max(fundedPerStage[ref.stage], ref.option + 1);
          }
          flow += partial;
          residual = 0;
          refill += inc.upkeepEt;
          fees += inc.feeEt;
          spawnUsed += inc.spawnTimeEt;
          upgradeEt += partial;
          if (inc.backed) standingUpgradeEt += partial;
          frontier.push({
            offerId: sinkOffer.id,
            reason: "energy residual",
            detail: `last step trims to ${partial.toFixed(2)} of ${inc.delivered.toFixed(2)} e/t — residual drained`
          });
        } else {
          frontier.push({
            offerId: sinkOffer.id,
            reason: "energy residual",
            detail: `step needs ${draw.toFixed(2)} e/t, residual ${residual.toFixed(2)} e/t`
          });
        }
        break;
      }
      for (const ref of inc.refs) {
        const o = sink.stages[ref.stage].options[ref.option];
        fund(o.offer, null, o.step);
        fundedPerStage[ref.stage] = Math.max(fundedPerStage[ref.stage], ref.option + 1);
      }
      flow += inc.delivered;
      residual -= draw;
      refill += inc.upkeepEt;
      fees += inc.feeEt;
      spawnUsed += inc.spawnTimeEt;
      if (inc.backed) standingFees += inc.feeEt;
      if (sink.capital) {
        buildEt += inc.delivered;
        if (inc.backed) standingBuildEt += inc.delivered;
      } else {
        upgradeEt += inc.delivered;
        if (inc.backed) standingUpgradeEt += inc.delivered;
      }
    }
    if (flow > EPS) allocateChain(sink.stages, fundedPerStage, flow);
  };

  for (const sink of input.sinks) if (sink.capital) drawSink(sink);

  // The warchest diversion: while the bank sits below its reserve target
  // (open capex plus awaiting candidates), the residual BANKS instead of
  // burning. All of it — v1's macro doctrine ("fund producers, bank to
  // the warchest, consumers burn the residual") as arithmetic. The lab
  // will show the upgrade fleet lapse during accumulation; whether
  // standing burners should keep drinking is a recorded open finding.
  let warchestEt = 0;
  if ((input.warchestTarget ?? 0) > input.bankStock + EPS && residual > EPS) {
    warchestEt = residual;
    residual = 0;
  }

  for (const sink of input.sinks) if (!sink.capital) drawSink(sink);

  const corps: CorpInstance[] = [];
  let minedEt = 0;
  for (const f of funded.values()) {
    // Utilization: allocated flow over quoted capacity. The rows state the
    // trade that actually MATCHES — a whole body bought for a partial flow
    // shows the flow; idle capacity is the corp's own business. Bills,
    // fees and machine time stay full: they are owed either way.
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
      const fee = s.cost.feeEt ?? 0;
      gross += flowMagnitude(s.provides) * u;
      cost += s.cost.upkeepEt + fee;
      addFlows(outputs, s.provides, u);
      addFlows(inputs, s.requires, u);
      // Ownership and operation are inputs too: machine time, the parts
      // bill at the bank, and fees the bank pays.
      if (s.cost.spawnTimeEt > 0) addFlows(inputs, { spawnTime: s.cost.spawnTimeEt });
      if (s.cost.upkeepEt + fee > 0) addFlows(inputs, { energyAt: { [input.bank]: s.cost.upkeepEt + fee } });
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
  // bank is the counterparty and nets the leftover; any OTHER place with
  // a residue means the plan funded a match that does not exist.
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
