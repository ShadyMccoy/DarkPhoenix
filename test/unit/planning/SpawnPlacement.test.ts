import { expect } from "chai";
import {
  SpawnCandidateContext,
  createPlacementJob,
  stepPlacementJob,
  placementResults,
  buildPlacementContexts,
  MAX_CANDIDATES_PER_NODE,
} from "../../../src/planning/SpawnPlacement";
import { evaluateSpawnChain } from "../../../src/corps/ChainEvaluator";
import { Node, NodeResource, NodeROI, createNode } from "../../../src/nodes/Node";
import { Position } from "../../../src/types/Position";

const ROOM = "W0N0";
function at(x: number, y: number): Position {
  return { x, y, roomName: ROOM };
}

/** One node context: a source + controller, and a few candidate spawn tiles. */
function context(candidates: Position[]): SpawnCandidateContext {
  return {
    nodeId: "node-A",
    localSources: [{ id: "source-A", capacity: 3000, pos: at(25, 30) }],
    controllerPos: at(25, 20),
    candidates,
  };
}

describe("SpawnPlacement", () => {
  describe("stepPlacementJob", () => {
    it("picks the candidate tile with the highest spawn value", () => {
      const candidates = [at(25, 25), at(25, 29), at(5, 5)];
      const ctx = context(candidates);

      // Independently compute the expected best tile.
      const expected = candidates
        .map((pos) => ({
          pos,
          value: evaluateSpawnChain({
            spawnPos: pos,
            sources: ctx.localSources,
            controllerPos: ctx.controllerPos,
          }),
        }))
        .reduce((a, b) => (b.value > a.value ? b : a));

      const job = createPlacementJob([ctx]);
      stepPlacementJob(job, 100);

      expect(job.done).to.equal(true);
      const best = placementResults(job)[0];
      expect(best.pos).to.deep.equal(expected.pos);
      expect(best.value).to.be.closeTo(expected.value, 1e-9);
    });

    it("resumes across calls and respects the per-step evaluation budget", () => {
      const candidates = [at(25, 25), at(24, 25), at(26, 25), at(25, 24), at(25, 26)];
      const job = createPlacementJob([context(candidates)]);

      stepPlacementJob(job, 2);
      expect(job.evaluated).to.equal(2);
      expect(job.done).to.equal(false);

      stepPlacementJob(job, 2);
      expect(job.evaluated).to.equal(4);
      expect(job.done).to.equal(false);

      stepPlacementJob(job, 2); // only 1 candidate left
      expect(job.evaluated).to.equal(5);
      expect(job.done).to.equal(true);
    });

    it("sweeps multiple node contexts in one job", () => {
      const ctxA = context([at(25, 25)]);
      const ctxB: SpawnCandidateContext = {
        nodeId: "node-B",
        localSources: [{ id: "source-B", capacity: 3000, pos: at(10, 15) }],
        controllerPos: at(10, 20),
        candidates: [at(10, 17), at(10, 18)],
      };
      const job = createPlacementJob([ctxA, ctxB]);
      stepPlacementJob(job, 100);

      expect(job.done).to.equal(true);
      const results = placementResults(job);
      expect(results.map((r) => r.nodeId)).to.deep.equal(["node-A", "node-B"]);
      expect(results.every((r) => r.pos !== null)).to.equal(true);
    });

    it("leaves pos null for a context whose candidates never score positively", () => {
      // No controller -> every candidate is worth zero.
      const ctx: SpawnCandidateContext = {
        nodeId: "node-A",
        localSources: [{ id: "source-A", capacity: 3000, pos: at(25, 30) }],
        controllerPos: undefined,
        candidates: [at(25, 25), at(25, 26)],
      };
      const job = createPlacementJob([ctx]);
      stepPlacementJob(job, 100);

      const best = placementResults(job)[0];
      expect(best.pos).to.equal(null);
      expect(best.value).to.equal(0);
    });
  });

  describe("buildPlacementContexts", () => {
    const roi = (economicValue: number): NodeROI => ({
      score: economicValue,
      expansionScore: economicValue,
      rawCorpROI: 0,
      economicValue,
      potentialCorps: [],
      openness: 0,
      distanceFromOwned: 0,
      isOwned: true,
      sourceCount: 1,
      hasController: true,
    });

    function nodeWith(id: string, economicValue: number, resources: NodeResource[]): Node {
      const n = createNode(id, ROOM, at(25, 25), 100, [ROOM], 0);
      n.resources = resources;
      n.roi = roi(economicValue);
      return n;
    }

    const source = (id: string, pos: Position): NodeResource => ({ type: "source", id, position: pos, capacity: 3000 });
    const controller = (pos: Position): NodeResource => ({ type: "controller", id: "c", position: pos });

    it("selects the top-N nodes by economic value and skips zero-value ones", () => {
      const nodes = [
        nodeWith("low", 5, [source("s1", at(25, 30)), controller(at(25, 20))]),
        nodeWith("high", 50, [source("s2", at(25, 30)), controller(at(25, 20))]),
        nodeWith("zero", 0, [source("s3", at(25, 30)), controller(at(25, 20))]),
      ];
      const territories = new Map<string, Position[]>([
        ["low", [at(25, 25)]],
        ["high", [at(25, 25)]],
        ["zero", [at(25, 25)]],
      ]);

      const contexts = buildPlacementContexts(nodes, territories, 2);
      expect(contexts.map((c) => c.nodeId)).to.deep.equal(["high", "low"]);
    });

    it("excludes resource tiles and caps the candidate count", () => {
      const sourcePos = at(25, 30);
      const ctrlPos = at(25, 20);
      // A big territory including the source and controller tiles.
      const tiles: Position[] = [];
      for (let y = 1; y < 49; y++) for (let x = 1; x < 49; x++) tiles.push(at(x, y));

      const node = nodeWith("big", 50, [source("s", sourcePos), controller(ctrlPos)]);
      const contexts = buildPlacementContexts(node ? [node] : [], new Map([["big", tiles]]), 5);

      expect(contexts).to.have.length(1);
      const cands = contexts[0].candidates;
      expect(cands.length).to.be.lessThanOrEqual(MAX_CANDIDATES_PER_NODE);
      // Resource tiles are not candidates.
      const hasSource = cands.some((p) => p.x === sourcePos.x && p.y === sourcePos.y);
      const hasCtrl = cands.some((p) => p.x === ctrlPos.x && p.y === ctrlPos.y);
      expect(hasSource).to.equal(false);
      expect(hasCtrl).to.equal(false);
    });
  });
});
