/**
 * vocabulary.ts — the engine's frozen trade vocabulary and the corp
 * contract's data shapes (REBOOT.md "The corp contract", 2026-08-22).
 *
 * A corp kind's plan-side face is one pure function — quote(handoff) →
 * Offer — and the Offer is the kind's scaling behavior AS DATA: a list of
 * steps, one step = one body (or structure), each declaring the marginal
 * rates it requires and provides. Saturation is the schedule ending;
 * diminishing returns are declining marginal provides; a `backedBy` step is
 * already embodied and quotes free — incumbency with no engine machinery.
 *
 * Trade vs cost: `requires`/`provides` are the ECONOMY flows a step moves
 * (harvested energy, hauled energy, upgrade burn); `cost` is the ownership
 * column — upfront body price, the amortized parts bill (upkeepEt, owed at
 * the spawn's bank branch: the tender heartbeat is Σ funded upkeepEt), and
 * spawn machine time. Splitting them keeps P&L a column, not a derivation.
 * Growing the flow vocabulary is a constitutional event (piece 6).
 */
import { BodyShape } from "../sizing";

export type PlaceId = string;

/** Marginal flow rates, in the frozen vocabulary: energy in e/t keyed by
 * place, spawn machine time in parts/tick, control points in CP/t, and
 * construction progress in points/t (1 point == 1 energy). `progress` is
 * the flow whose accumulated stock is a STANDING ASSET — instantiating the
 * owner's own commodity list (REBOOT: "energy; spawnTime; safety; intel
 * coverage; standing assets; control points"), not growing it. */
export interface Flows {
  energyAt?: Record<PlaceId, number>;
  spawnTime?: number;
  controlPoints?: number;
  progress?: number;
}

/** Merge marginal flows, optionally scaled — the market sums a corp's
 * funded steps with this, scaling trade by allocation (utilization). */
export function addFlows(into: Flows, from: Flows, scale = 1): void {
  if (from.spawnTime) into.spawnTime = (into.spawnTime ?? 0) + from.spawnTime * scale;
  if (from.controlPoints) into.controlPoints = (into.controlPoints ?? 0) + from.controlPoints * scale;
  if (from.progress) into.progress = (into.progress ?? 0) + from.progress * scale;
  for (const place of Object.keys(from.energyAt ?? {})) {
    const at = into.energyAt ?? (into.energyAt = {});
    at[place] = (at[place] ?? 0) + (from.energyAt as Record<PlaceId, number>)[place] * scale;
  }
}

/** The ownership bill of one step. Backed steps carry zeros for ownership
 * (upfront, upkeep): sunk capital prices as sunk (the books keeping capex
 * history are the ledger's job, never the quote's — REBOOT.md piece 5).
 * Operating fees are NOT ownership and survive backing. */
export interface StepCost {
  /** Energy to buy the body or structure today — what ramp solvency
   * checks and the believer's bank pays at purchase. */
  upfront: number;
  /** Parts bill, e/t amortized over a creep life, owed at the bank — the
   * heartbeat's column; the tender carries exactly this. */
  upkeepEt: number;
  /** Operating charge, e/t, that is NOT a spawn bill: the link's 3% tax,
   * and a CANDIDATE structure's capex amortized over HORIZON (full-cost
   * pricing; a standing structure's capexEt is sunk to zero — piece 5's
   * full-vs-marginal repricing in one field). Enters net and P&L, never
   * the refill obligation. */
  feeEt?: number;
  /** Spawn machine time to keep the body alive, parts/tick. */
  spawnTimeEt: number;
}

export interface Step {
  /** What funding this step purchases; absent when the step is backed. */
  buys?: BodyShape;
  /** Live creep (or standing structure) already embodying this step. */
  backedBy?: string;
  provides: Flows;
  requires: Flows;
  cost: StepCost;
  /** Audit terms, human-readable — a quote must explain itself; the lab
   * renders these (graph-lab requirement #1). */
  note?: string;
}

export type CorpKindName = "workman" | "mine" | "haul" | "link" | "upgrade" | "spawning" | "build";

export type StructureKind = "link" | "extension" | "container" | "storage" | "road";

/**
 * An APPROVED investment: capital formation the plan commits to, distinct
 * from transport (a candidate structure cannot move energy today, so it
 * never sits on an order book — it would crowd out the workable option
 * behind it and strand the edge's flow for the whole construction window).
 * The executor places the site; the build corp then burns the capex into
 * it as flow, drawn from STOCK (piece 9: investments draw from stock).
 */
export interface Approval {
  structure: StructureKind;
  /** The edge this investment serves, when it serves one (links, roads). */
  edge?: { from: PlaceId; to: PlaceId };
  /** Where the site belongs. */
  at: PlaceId;
  capex: number;
  /** The arithmetic that cleared it — a quote must explain itself. */
  detail: string;
}

export interface Offer {
  /** Deterministic — `kind:anchor` — stable across replans so instances
   * keep identity and ledger history. */
  id: string;
  kind: CorpKindName;
  steps: Step[];
}

export interface CorpPnl {
  grossEt: number;
  costEt: number;
  netEt: number;
}

/** A corp INSTANCE: plain data in the plan, never an object with a
 * lifecycle (law 2). `target` counts bodies wanted, spawn pipe included in
 * the census, exactly as plan.ts counts today. */
export interface CorpInstance {
  id: string;
  kind: CorpKindName;
  /** The bodies still to hire, in funded-step order — the fleet's tail
   * after its backed heads. A quote may size the LAST body to the flow
   * remainder (sizing law), so one body field cannot describe the fleet:
   * an executor hiring `target − live` copies of the first overshoots the
   * quoted machine time by the runt difference — enough, at a saturated
   * spawn, to tip the seed over capacity and cull the very fleet the plan
   * re-buys next round (the forest stall, session finding 2026-08-24). */
  hires: BodyShape[];
  target: number;
  /** Of `target`, how many are already-living handed assets. */
  backed: number;
  /** Chain this instance serves — end-to-end fidelity audits without
   * ownership (piece 1's flow edges). */
  chain: string | null;
  pnl: CorpPnl;
  /** The corp's traded flows, summed over funded steps — every commodity,
   * not just energy. Inputs fold the ownership bill in (machine time, and
   * the parts bill drawn at the bank), so a row's in/out IS its contract. */
  inputs: Flows;
  outputs: Flows;
}

export type FrontierReason =
  | "net<0"
  | "spawn capacity"
  | "energy residual"
  | "ramp insolvent"
  | "source saturated"
  | "outcompeted"
  /** An investment that wins its edge but outruns the bank's spendable
   * stock — the warchest accumulates toward exactly these lines. */
  | "awaiting stock"
  /** The tender schedule exhausted below the heartbeat obligation. An
   * uncovered heartbeat is never silent (the axiom, printed). */
  | "tender short"
  /** A wire that clears its hurdle but would exceed the estate's link
   * allowance (the per-RCL scarcity, staged as a budget) — the network
   * plan must consolidate instead of wiring every edge privately. */
  | "link budget"
  /** A cleared investment whose capex lies beyond what this bank branch
   * can physically accumulate — pile decay grows with the stock until it
   * eats the whole saving stream (the asymptote at ~1000·stream). Never
   * added to the warchest target: chasing it would pause the dividend
   * forever. The printed line IS the case for the next branch. */
  | "capex unreachable";

/** The blocked frontier, always printed WITH reasons (piece 6): the first
 * unfunded step of an offer and the arithmetic that stopped it. */
export interface FrontierLine {
  offerId: string;
  reason: FrontierReason;
  detail: string;
}

/** One row of the position book: a place's energy column, netted over the
 * funded plan's ALLOCATED flows. The bank is the counterparty and may net
 * (its net IS the leftover); every other place must clear to ~zero, or the
 * plan funded a match that does not exist. */
export interface PositionRow {
  place: PlaceId;
  supplyEt: number;
  demandEt: number;
  netEt: number;
}

export interface EnginePlan {
  tick: number;
  corps: CorpInstance[];
  frontier: FrontierLine[];
  /** Capital formation this replan commits to — the plan's investment
   * section, separate from the funded flow ledger. */
  approvals: Approval[];
  /** The position matrix (REBOOT's second view), energy column per place. */
  positions: PositionRow[];
  /** Non-bank places that failed to clear: unmatched demand (funded
   * consumption with no supply at that place) or stranded supply. A
   * violation is an ENGINE BUG by construction — the suites pin this
   * empty; the lab prints it in red. */
  violations: string[];
  expected: {
    minedEt: number;
    deliveredEt: number;
    /** Σ funded parts bills — the tender heartbeat's obligation. */
    refillEt: number;
    /** Σ funded operating fees (link tax, candidate capex over HORIZON) —
     * the bank pays these; they are not spawn bills. */
    feesEt: number;
    upgradeEt: number;
    /** Funded construction burn, e/t — capex leaving the bank as flow.
     * A STOCK draw, never a residual draw: the bank's rate column goes
     * negative by exactly this much while a project runs (piece 9's
     * Δbalance — buffers absorb, flows just do their jobs). */
    buildEt: number;
    /** The residual diverted to the bank's reserve while a cleared
     * investment awaits stock (the `awaiting stock` frontier lines ARE
     * the warchest's target). Production over consumption, structural:
     * the controller's dividend pauses while the bank accumulates. */
    warchestEt: number;
    /** The bank branch's holding cost at today's stock — pile decay
     * (convex), container upkeep, overflow rot. Piece 9's "the bank's
     * own cost line", off the top of the residual and debited by every
     * cash reader. */
    holdingEt: number;
    /** The LIVE fleet's share of deliveredEt: funded increments whose every
     * step is backed. The plan side above assumes full staffing; this is
     * what stands today — the believer's cash accounting reads it, and the
     * fidelity line will print the pair side by side. */
    standingEt: number;
    /** The live fleet's share of upgradeEt — burns of funded backed steps. */
    standingUpgradeEt: number;
    /** The live fleet's share of buildEt — what construction actually
     * progresses today, and what the believer's bank pays out. */
    standingBuildEt: number;
    /** Cash to SUSTAIN the live fleet: every live body's amortized
     * replacement bill. Steady state has no expiry event — replacement is
     * this bill, paid continuously; the believer's cash flow reads it. */
    standingRefillEt: number;
    /** Operating fees of BACKED funded steps — the standing link's tax,
     * paid on flow that runs today. Without this line the tax vanished
     * between the plan book and any cash reader: standingEt is gross of
     * it (stress-hunt confirmed finding, 2026-08-23 — the full fix,
     * loss-as-a-flow in the vocabulary, awaits an owner ruling). */
    standingFeesEt: number;
  };
}
