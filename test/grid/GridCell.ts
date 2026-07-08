/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GridCell - the declarative unit of the inflection-point grid (docs/specs/08).
 *
 * A cell stages a world AT a decision moment (creep should spawn, creep just
 * spawned, creep arrived at its post, commission churned) and asserts the
 * decision plus its immediate consequence inside a short verdict window,
 * instead of paying a long cold-start sim to reach that moment organically.
 *
 * Many cells run in parallel as separate bot users in ONE mockup world (the
 * engine costs ~233ms/tick flat + ~67ms/tick per bot, so N cells amortize the
 * engine). Isolation invariant: one bot per cell, full border walls, and >= 4
 * rooms of separation between cells (see test/grid/pack.ts).
 */

import { ScenarioRoom } from "../integration/scenario/RoomBuilder";

export type CellStatus = "pass" | "fail" | "timeout" | "error";

/** One per-tick observation of a single cell's world + bot memory. */
export interface CellSample {
  /** Ticks since the batch world started; staging completes before tick 1. */
  tick: number;
  /** Parsed exported Memory of THIS cell's bot ({} if unparsable this tick). */
  memory: any;
  /** This cell's bot user id (creeps and owned structures carry it). */
  userId: string;
  /** Resolve a local room handle ("home", "east") to the packed room name. */
  room(handle?: string): string;
  /** Room objects (cached per tick) for one of this cell's rooms. */
  objects(handle?: string): any[];
  /** Convenience: this cell's creep by name (undefined once dead). */
  creep(name: string, handle?: string): any | undefined;
}

export type CellCheck = (s: CellSample) => boolean;

/**
 * A single assertion inside a cell.
 * - "eventually": must become true at some sample <= window (else TIMEOUT).
 * - "always":     must hold at every sample from `graceTicks` through window
 *                 (a violation is an immediate FAIL).
 * - "atWindow":   evaluated once at the first sample >= window (false = FAIL).
 */
export interface CellAssertion {
  name: string;
  mode: "eventually" | "always" | "atWindow";
  check: CellCheck;
  /** "always" only: ticks before enforcement starts (adoption warm-up etc). */
  graceTicks?: number;
}

export const eventually = (name: string, check: CellCheck): CellAssertion => ({
  name,
  mode: "eventually",
  check,
});
export const always = (name: string, check: CellCheck, graceTicks = 0): CellAssertion => ({
  name,
  mode: "always",
  check,
  graceTicks,
});
export const atWindow = (name: string, check: CellCheck): CellAssertion => ({
  name,
  mode: "atWindow",
  check,
});

/** A creep to inject at staging time (before tick 1). */
export interface StagedCreep {
  name: string;
  x: number;
  y: number;
  /** Body part type strings, e.g. ["work", "work", "move"]. */
  body: string[];
  /** Carried energy (default 0). */
  energy?: number;
  /** Room handle (default "home"). */
  room?: string;
  /**
   * Memory.creeps[name] entry to inject. String values of the form
   * "$id(handle,type,x,y)" are resolved to the fresh game-object id of the
   * object at that position after the world is built.
   */
  memory?: Record<string, unknown>;
}

/** A structure to inject at staging time (schemas per Scenario.applyState). */
export interface StagedStructure {
  type: string;
  x: number;
  y: number;
  energy?: number;
  /** Override hits (default: full for the type) - e.g. a decayed container. */
  hits?: number;
  /** Room handle (default "home"). */
  room?: string;
}

/** Raw-db escape hatch context for staging the infra can't express yet. */
export interface StageCtx {
  db: any;
  C: any;
  userId: string;
  room(handle?: string): string;
  /** World game time at staging (for relative timers like downgradeTime). */
  gameTime: number;
}

/** Context for per-tick harness interventions (see GridCell.onTick). */
export interface TickCtx {
  tick: number;
  db: any;
  userId: string;
  room(handle?: string): string;
  /** Storage env handle - the bot re-reads Memory from env each tick, so
   * env-level Memory rewrites (e.g. backdating spawnDemandFirstSeen) land. */
  env: any;
  /** Current game time (staging gameTime + tick). */
  gameTime: number;
}

export interface GridCell {
  /** Unique kebab-case id, prefixed by avenue (e.g. "churn-canary-readopt"). */
  id: string;
  tier: 0 | 1 | 2 | 3 | 4 | 5;
  avenue: string;
  /** Verdict window in ticks. */
  window: number;
  /**
   * Room builders keyed by local handle; "home" is required. Each receives its
   * packed room name. Every reachable room MUST be border()-sealed except
   * deliberate intra-cell gaps (isolation invariant).
   */
  rooms: Record<string, (roomName: string) => ScenarioRoom>;
  /** Where non-home handles sit relative to home (compass from home). */
  adjacency?: Record<string, "E" | "W" | "N" | "S">;
  /**
   * Absolute room names per handle, for cells whose semantics depend on
   * room-name arithmetic (e.g. Source-Keeper classification). The packer
   * verifies they sit >= 4 rooms from every other cell.
   */
  pinnedRooms?: Record<string, string>;
  /** Bot spawn placement; room is a handle (default "home"). */
  bot: { x: number; y: number; room?: string; gcl?: number };
  /** Controller state staged after addBot (level 2+ enables the flow economy). */
  controller?: { level: number; progress?: number; downgradeTime?: number };
  structures?: StagedStructure[];
  creeps?: StagedCreep[];
  /**
   * Extra keys merged into the bot's injected Memory (Memory.creeps is built
   * from `creeps[].memory` automatically). Same "$id(...)" token resolution.
   */
  memory?: Record<string, unknown>;
  /** Raw-db staging escape hatch, run after declarative staging. */
  stage?(ctx: StageCtx): Promise<void>;
  /**
   * Per-tick harness intervention, run AFTER each server tick while the cell
   * is undecided (e.g. pin the spawn's energy so no decision is energy-gated,
   * or fire a one-shot db tweak when a condition is met). Keep it cheap - it
   * runs every tick.
   */
  onTick?(ctx: TickCtx): Promise<void>;
  /** Engine mod paths; cells only batch with identical mod signatures. */
  mods?: string[];
  assertions: CellAssertion[];
}

/** Per-assertion outcome detail, for calibration and diagnosis. */
export interface AssertionOutcome {
  name: string;
  mode: CellAssertion["mode"];
  /** Tick an "eventually" first became true / "atWindow" was evaluated. */
  satisfiedAt?: number;
  /** Tick an "always"/"atWindow" was violated. */
  violatedAt?: number;
  satisfied: boolean;
}

export interface CellVerdict {
  id: string;
  tier: number;
  avenue: string;
  status: CellStatus;
  /** Tick the verdict was decided (window end for timeout/atWindow cells). */
  decidedTick: number;
  window: number;
  assertions: AssertionOutcome[];
  /** Populated on status "error". */
  error?: string;
}
