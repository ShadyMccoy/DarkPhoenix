/**
 * SpawnPlacement - find the best spawn tile within a node's territory.
 *
 * Picking which node to expand to is a coarse decision (one valuation per node,
 * at its peak - see calculateNodeROI). Picking WHERE in that node's territory to
 * drop the spawn is a fine one: every buildable tile is a candidate, and each is
 * scored by the chain of corps a spawn there would run (evaluateSpawnChain).
 * A spawn closer to the sources and controller wastes less energy on hauling, so
 * the best tile is the one that maximises that productive value.
 *
 * Evaluating every tile of several territories is too much for one tick, so the
 * work is modelled as a resumable JOB: a cursor over (node, candidate) pairs and
 * a running best per node. This module is pure - it does the valuations and
 * advances the cursor, but knows nothing about ticks or CPU. The driver decides
 * how many candidates to process per tick (see execution/SpawnPlacementScheduler).
 */

import { Position, chebyshevDistance } from "../types/Position";
import { Node } from "../nodes/Node";
import {
  ChainSource,
  ReachableChainSource,
  evaluateSpawnChain,
} from "../corps/ChainEvaluator";

/** The economy facts shared by every candidate tile in one node. */
export interface SpawnCandidateContext {
  nodeId: string;
  /** Sources inside this node's territory (fixed across candidates). */
  localSources: ChainSource[];
  /** The controller this node would upgrade. */
  controllerPos?: Position;
  /** Reachable adjacent-node sources, if the caller wants them folded in. */
  reachableSources?: ReachableChainSource[];
  /** Buildable tiles to consider for the spawn. */
  candidates: Position[];
}

/** The best spawn tile found for a node (pos null if none scored positively). */
export interface SpawnPlacement {
  nodeId: string;
  pos: Position | null;
  value: number;
}

/** A resumable sweep over several nodes' candidate tiles. */
export interface PlacementJob {
  contexts: SpawnCandidateContext[];
  /** Context currently being swept. */
  contextIndex: number;
  /** Next candidate within the current context. */
  candidateIndex: number;
  /** Best placement found so far, keyed by node id. */
  best: Record<string, SpawnPlacement>;
  /** Total candidate valuations performed (for budgeting/telemetry). */
  evaluated: number;
  done: boolean;
}

/** Cap on candidates per node; larger territories are evenly subsampled. */
export const MAX_CANDIDATES_PER_NODE = 80;

/** Create a job that will sweep the given contexts. */
export function createPlacementJob(contexts: SpawnCandidateContext[]): PlacementJob {
  const best: Record<string, SpawnPlacement> = {};
  for (const ctx of contexts) {
    best[ctx.nodeId] = { nodeId: ctx.nodeId, pos: null, value: 0 };
  }
  return {
    contexts,
    contextIndex: 0,
    candidateIndex: 0,
    best,
    evaluated: 0,
    done: contexts.length === 0,
  };
}

/**
 * Advance the job by up to `maxEvaluations` candidate valuations, updating the
 * running best for each node. Mutates and returns the job (Screeps-friendly: no
 * per-step allocations). Call repeatedly across ticks until `job.done`.
 */
export function stepPlacementJob(
  job: PlacementJob,
  maxEvaluations: number,
  dist: (a: Position, b: Position) => number = chebyshevDistance
): PlacementJob {
  let budget = maxEvaluations;

  while (budget > 0 && !job.done) {
    // Skip past contexts whose candidates are exhausted (not an evaluation).
    if (job.contextIndex >= job.contexts.length) {
      job.done = true;
      break;
    }
    const ctx = job.contexts[job.contextIndex];
    if (job.candidateIndex >= ctx.candidates.length) {
      job.contextIndex++;
      job.candidateIndex = 0;
      continue;
    }

    const pos = ctx.candidates[job.candidateIndex];
    const value = evaluateSpawnChain({
      spawnPos: pos,
      sources: ctx.localSources,
      controllerPos: ctx.controllerPos,
      reachableSources: ctx.reachableSources,
      dist,
    });

    const current = job.best[ctx.nodeId];
    if (value > current.value) {
      current.value = value;
      current.pos = pos;
    }

    job.candidateIndex++;
    job.evaluated++;
    budget--;
  }

  return job;
}

/** The best placement for every node in the job (in context order). */
export function placementResults(job: PlacementJob): SpawnPlacement[] {
  return job.contexts.map((ctx) => job.best[ctx.nodeId]);
}

/**
 * Build sweep contexts for the top `topN` nodes by economic value. Each context
 * draws its candidate tiles from the node's territory (resource tiles excluded,
 * large territories evenly subsampled to MAX_CANDIDATES_PER_NODE).
 *
 * The fine sweep scores the spawn over the node's OWN sources and controller -
 * the inter-node reachable sources that decide WHICH node to expand to barely
 * shift the best tile WITHIN a territory, so they are left to the coarse ROI.
 */
export function buildPlacementContexts(
  nodes: Node[],
  territoriesByNode: Map<string, Position[]>,
  topN = 5
): SpawnCandidateContext[] {
  const ranked = nodes
    .filter((n) => (n.roi?.economicValue ?? 0) > 0)
    .sort((a, b) => (b.roi!.economicValue ?? 0) - (a.roi!.economicValue ?? 0))
    .slice(0, topN);

  const contexts: SpawnCandidateContext[] = [];
  for (const node of ranked) {
    const controller = node.resources.find((r) => r.type === "controller");
    if (!controller) continue;

    const localSources: ChainSource[] = node.resources
      .filter((r) => r.type === "source")
      .map((r) => ({ id: r.id, capacity: r.capacity ?? 3000, pos: r.position }));

    const tiles = territoriesByNode.get(node.id) ?? [];
    const candidates = selectCandidates(tiles, node.resources.map((r) => r.position));
    if (candidates.length === 0) continue;

    contexts.push({
      nodeId: node.id,
      localSources,
      controllerPos: controller.position,
      candidates,
    });
  }
  return contexts;
}

/** Drop tiles occupied by resources, then evenly subsample to the cap. */
function selectCandidates(tiles: Position[], occupied: Position[]): Position[] {
  const blocked = new Set(occupied.map((p) => `${p.roomName}:${p.x},${p.y}`));
  const free = tiles.filter((t) => !blocked.has(`${t.roomName}:${t.x},${t.y}`));
  if (free.length <= MAX_CANDIDATES_PER_NODE) return free;

  const stride = Math.ceil(free.length / MAX_CANDIDATES_PER_NODE);
  const sampled: Position[] = [];
  for (let i = 0; i < free.length; i += stride) sampled.push(free[i]);
  return sampled;
}
