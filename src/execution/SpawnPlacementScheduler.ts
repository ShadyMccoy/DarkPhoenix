/**
 * SpawnPlacementScheduler - drive the fine-grained spawn sweep across ticks.
 *
 * The placement sweep (see planning/SpawnPlacement) can evaluate hundreds of
 * candidate tiles, far too many for one tick. This module is the impure shell
 * around that pure job: it holds the in-progress job in module memory, and each
 * tick processes as many candidates as the CPU budget allows before yielding.
 * It mirrors IncrementalAnalysis - start a job, then `runStep` every tick until
 * it finishes - and writes the winning tile per node to Memory.spawnPlacements.
 *
 * Budgeting is twofold: a soft CPU budget (stop once this tick has spent its
 * share, re-checked every few evaluations) and a hard per-tick evaluation cap
 * (so a flat CPU clock - e.g. a test stub - still yields). The bucket guard
 * defers the whole sweep when CPU reserves are low.
 */

import "../types/Memory";
import { Position } from "../types/Position";
import { Node } from "../nodes/Node";
import {
  PlacementJob,
  SpawnPlacement,
  buildPlacementContexts,
  createPlacementJob,
  placementResults,
  stepPlacementJob,
} from "../planning/SpawnPlacement";

/** Fraction of the tick's CPU limit the sweep may spend. */
const CPU_FRACTION = 0.3;
/** Re-check the CPU clock after this many evaluations. */
const EVAL_CHUNK = 4;
/** Hard cap on evaluations per tick (bounds work when the CPU clock is flat). */
const MAX_EVAL_PER_TICK = 40;
/** Defer the sweep until the bucket has at least this much CPU banked. */
const MIN_BUCKET = 2000;

/** The sweep in progress, or null when idle. */
let job: PlacementJob | null = null;

/** Whether a placement sweep is currently running. */
export function isSpawnPlacementInProgress(): boolean {
  return job !== null;
}

/** Abandon any in-progress sweep (e.g. on respawn / forced replan). */
export function resetSpawnPlacement(): void {
  job = null;
}

/**
 * Begin a sweep over the top `topN` nodes by economic value. Returns false (and
 * starts nothing) when no node qualifies. Replaces any sweep already running.
 */
export function startSpawnPlacement(
  nodes: Node[],
  territoriesByNode: Map<string, Position[]>,
  topN = 5
): boolean {
  const contexts = buildPlacementContexts(nodes, territoriesByNode, topN);
  if (contexts.length === 0) {
    job = null;
    return false;
  }
  job = createPlacementJob(contexts);
  return true;
}

/** Current CPU used this tick (0 when no Game/cpu, e.g. in pure tests). */
function cpuUsed(): number {
  return typeof Game !== "undefined" && Game.cpu ? Game.cpu.getUsed() : 0;
}

/** This tick's soft CPU budget for the sweep. */
function cpuBudget(): number {
  if (typeof Game !== "undefined" && Game.cpu && Game.cpu.limit) {
    return Game.cpu.limit * CPU_FRACTION;
  }
  return Number.POSITIVE_INFINITY;
}

/** Whether the CPU bucket has enough banked to run the sweep this tick. */
function bucketHealthy(): boolean {
  if (typeof Game === "undefined" || !Game.cpu) return true;
  return Game.cpu.bucket >= MIN_BUCKET;
}

/**
 * Advance the in-progress sweep within this tick's CPU budget. Returns the
 * per-node results when the sweep finishes on this tick (also persisted to
 * Memory), or null while it is still running, idle, or deferred for CPU.
 */
export function runSpawnPlacementStep(): SpawnPlacement[] | null {
  if (!job) return null;
  if (!bucketHealthy()) return null;

  const start = cpuUsed();
  const budget = cpuBudget();
  const startedAt = job.evaluated;

  while (
    !job.done &&
    job.evaluated - startedAt < MAX_EVAL_PER_TICK &&
    cpuUsed() - start < budget
  ) {
    stepPlacementJob(job, EVAL_CHUNK);
  }

  if (!job.done) return null;

  const results = placementResults(job);
  persist(results);
  job = null;
  return results;
}

/** Write the winning tile per node to Memory.spawnPlacements. */
function persist(results: SpawnPlacement[]): void {
  if (typeof Memory === "undefined") return;
  const out: NonNullable<Memory["spawnPlacements"]> = {};
  for (const r of results) {
    if (!r.pos) continue;
    out[r.nodeId] = { x: r.pos.x, y: r.pos.y, roomName: r.pos.roomName, value: r.value };
  }
  Memory.spawnPlacements = out;
}
