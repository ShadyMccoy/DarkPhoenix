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
 * place, spawn machine time in parts/tick, control points in CP/t. */
export interface Flows {
  energyAt?: Record<PlaceId, number>;
  spawnTime?: number;
  controlPoints?: number;
}

/** The ownership bill of one step. Backed steps carry zeros: sunk capital
 * prices as sunk (the books keeping capex history are the ledger's job,
 * never the quote's — REBOOT.md piece 5). */
export interface StepCost {
  /** Energy to buy the body today — what ramp solvency checks. */
  upfront: number;
  /** Parts bill, e/t amortized over a creep life, owed at the bank. */
  upkeepEt: number;
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

export type CorpKindName = "workman" | "mine" | "haul" | "upgrade" | "spawning";

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
  body: BodyShape | null;
  target: number;
  /** Of `target`, how many are already-living handed assets. */
  backed: number;
  /** Chain this instance serves — end-to-end fidelity audits without
   * ownership (piece 1's flow edges). */
  chain: string | null;
  pnl: CorpPnl;
}

export type FrontierReason =
  | "net<0"
  | "spawn capacity"
  | "energy residual"
  | "ramp insolvent"
  | "source saturated"
  | "outcompeted";

/** The blocked frontier, always printed WITH reasons (piece 6): the first
 * unfunded step of an offer and the arithmetic that stopped it. */
export interface FrontierLine {
  offerId: string;
  reason: FrontierReason;
  detail: string;
}

export interface EnginePlan {
  tick: number;
  corps: CorpInstance[];
  frontier: FrontierLine[];
  expected: {
    minedEt: number;
    deliveredEt: number;
    /** Σ funded parts bills — the tender heartbeat's obligation. */
    refillEt: number;
    upgradeEt: number;
    /** The LIVE fleet's share of deliveredEt: funded increments whose every
     * step is backed. The plan side above assumes full staffing; this is
     * what stands today — the believer's cash accounting reads it, and the
     * fidelity line will print the pair side by side. */
    standingEt: number;
    /** The live fleet's share of upgradeEt — burns of funded backed steps. */
    standingUpgradeEt: number;
  };
}
