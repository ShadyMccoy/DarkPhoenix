import { expect } from "chai";
import {
  SpawnCandidateContext,
  createPlacementJob,
  stepPlacementJob,
  placementResults,
  buildPlacementContexts,
  MAX_CANDIDATES_PER_NODE,
} from "../../../src/planning/SpawnPlacement";
import { spawnSiteValue } from "../../../src/economy/siteValue";
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
          value: spawnSiteValue(pos, ctx.localSources, ctx.controllerPos),
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
    const roi = (economicValue: number, overrides: Partial<NodeROI> = {}): NodeROI => ({
      score: economicValue,
      expansionScore: economicValue,
      economicValue,
      mineralValue: 0,
      openness: 0,
      distanceFromOwned: 0,
      isOwned: true,
      sourceCount: 1,
      hasController: true,
      ...overrides,
    });

    function nodeWith(
      id: string,
      economicValue: number,
      resources: NodeResource[],
      overrides: Partial<NodeROI> = {}
    ): Node {
      const n = createNode(id, ROOM, at(25, 25), 100, [ROOM], 0);
      n.resources = resources;
      n.roi = roi(economicValue, overrides);
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

    // -------------------------------------------------------------------------
    // THE EXPANSION LANE (spec 06's never-fired trigger, diagnosed 2026-08-11):
    // expansionCandidates drops any node without a priced placement, but the
    // sweep selected top-N by ECONOMIC value only - and owned territory always
    // outranks unowned rooms on that axis, so no expansion candidate ever got a
    // placement and shouldExpand starved at candidates=[] forever (live: GCL 32,
    // bank 554k, zero campaigns ever opened). The sweep now runs a second lane:
    // top-N unowned nodes by expansionScore, deduped into the same job.
    // -------------------------------------------------------------------------

    it("prices EXPANSION candidates: top unowned nodes by expansionScore join the sweep", () => {
      const nodes = [
        // The owned lane still wins its slots on economic value.
        nodeWith("home", 50, [source("s1", at(25, 30)), controller(at(25, 20))]),
        // The live starvation shape: marginal economicValue ~0, real
        // expansionScore - invisible to the old selection.
        nodeWith("candidate", 0, [source("s2", at(25, 30)), controller(at(25, 20))], {
          isOwned: false,
          expansionScore: 60,
        }),
        nodeWith("weaker-candidate", 0, [source("s3", at(25, 30)), controller(at(25, 20))], {
          isOwned: false,
          expansionScore: 40,
        }),
      ];
      const territories = new Map<string, Position[]>([
        ["home", [at(25, 25)]],
        ["candidate", [at(25, 25)]],
        ["weaker-candidate", [at(25, 25)]],
      ]);

      const contexts = buildPlacementContexts(nodes, territories, 1);
      expect(contexts.map((c) => c.nodeId), "one slot per lane: best owned + best candidate").to.deep.equal([
        "home",
        "candidate",
      ]);
    });

    it("the expansion lane skips controller-less nodes (highway/SK) and never duplicates the owned lane", () => {
      const nodes = [
        nodeWith("both-lanes", 50, [source("s1", at(25, 30)), controller(at(25, 20))], {
          isOwned: false,
          expansionScore: 90,
        }),
        nodeWith("highway", 0, [source("s2", at(25, 30))], { isOwned: false, expansionScore: 80 }),
      ];
      const territories = new Map<string, Position[]>([
        ["both-lanes", [at(25, 25)]],
        ["highway", [at(25, 25)]],
      ]);

      const contexts = buildPlacementContexts(nodes, territories, 2);
      expect(contexts.map((c) => c.nodeId)).to.deep.equal(["both-lanes"]);
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
