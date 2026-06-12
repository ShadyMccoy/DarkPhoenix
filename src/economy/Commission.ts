/**
 * @fileoverview Commission - the ONE envelope the planner emits per corp.
 *
 * A commission is the planner's output for a single corp: what the corp
 * consumes (energy-at-a-place, spawn build-time), what it produces
 * (energy-at-a-place, or colony value), and an opaque kind-specific assignment
 * payload that materialization hands to the runtime corp. The plumbing
 * (materializer, runner, persistence, telemetry) sees only this envelope -
 * never a kind-specific shape - which is what lets new corp kinds plug in
 * without core edits. See docs/specs/00-corp-framework.md.
 *
 * @module economy/Commission
 */

import { Position } from "../types/Position";

/**
 * The four shapes of economic activity:
 * - "produce":   energy appears at a place (mining)
 * - "transport": energy moves place -> place (hauling, links)
 * - "consume":   energy at a place becomes colony value (upgrading, building)
 * - "auxiliary": off the income budget; self-proposing support work
 *                (scouting, reservation, tending, rescue)
 */
export type CommissionShape = "produce" | "transport" | "consume" | "auxiliary";

/** What a commissioned corp draws from the colony. */
export interface CommissionInputs {
  /** Energy/tick consumed (for transport: the rate picked up). */
  energyRate?: number;
  /** Where the input is drawn (a link-served source's haulPos, a sink's pos). */
  at?: Position;
  /** Spawn build-time (parts/tick) the corp's bodies cost - the scarce resource. */
  spawnPartsPerTick: number;
}

/** What a commissioned corp yields to the colony. */
export interface CommissionOutputs {
  /** Energy/tick produced or delivered. */
  energyRate?: number;
  /** Where the output lands. */
  at?: Position;
  /** Direct colony value/tick (consumers: delivered energy x sink value). */
  valuePerTick?: number;
}

/**
 * One commissioned corp: the planner's reasoning (consumes/produces) plus the
 * kind-specific binding payload the runtime corp executes from.
 */
export interface Commission {
  /** Deterministic id: `${kind}-${targetId}` (see corpIdFor). */
  corpId: string;
  /** Registered corp kind, e.g. "harvest", "carry", "upgrade". */
  kind: string;
  shape: CommissionShape;
  consumes: CommissionInputs;
  produces: CommissionOutputs;
  /**
   * Kind-specific payload, OPAQUE to the planner and all plumbing (e.g. a
   * MinerAssignment, HaulerAssignment[], SinkAllocation). Only the kind's
   * materialize() interprets it.
   */
  assignment: unknown;
}

/**
 * Deterministic commission id. NOTE: this is the PLANNER's id space (pure,
 * derived from problem ids only). Legacy runtime corps use Game-derived ids
 * (room names baked in); each kind's materialize() owns the mapping until the
 * port makes the two id spaces one.
 */
export function corpIdFor(kind: string, targetId: string): string {
  return `${kind}-${targetId}`;
}
