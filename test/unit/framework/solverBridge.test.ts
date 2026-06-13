/**
 * Solver bridge equivalence (rung 4.5 - the live boundary). Proves that the
 * commissions surfaced from a real solve (flowAdapter.solveColony) reconstruct
 * the SAME assignments the live FlowMaterializer sets onto corps from the
 * FlowSolution. This is what de-risks the rung-5 cutover: if the commission
 * path is faithful to the FlowSolution path over a realistic graph, swapping
 * the materializer for the commission host cannot change what corps do.
 *
 * Pure: a hand-built FlowGraph + manhattan distance, mocked empty Game (so the
 * transient/link detectors no-op), no sim.
 */

import { expect } from "chai";
import { FlowGraph } from "../../../src/flow/FlowGraph";
import { NodeNavigator } from "../../../src/nodes/NodeNavigator";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";
import { solveColony } from "../../../src/economy/flowAdapter";
import { Position } from "../../../src/types/Position";
import { CommissionedMiner, CommissionedHauler, CommissionedSink } from "../../../src/economy/CorpPlanner";
import { ConsumeAssignment } from "../../../src/economy/commissionPlan";
import { minerAssignmentFromCommissioned } from "../../../src/corps/kinds/harvestKind";
import { haulerAssignmentFromCommissioned } from "../../../src/corps/kinds/carryKind";
import { sinkAllocationFromCommissioned, upgradeKind } from "../../../src/corps/kinds/upgradeKind";

const ROOM = "W0N0";
const at = (x: number, y = 25): Position => ({ x, y, roomName: ROOM });
const manhattan = (a: Position, b: Position): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function sourceNode(id: string, x: number): Node {
  const n = createNode(id, ROOM, at(x), 50, [ROOM], 0);
  const res: NodeResource = { type: "source", id, position: at(x), capacity: 3000 };
  n.resources = [res];
  return n;
}

function homeNode(spawnX: number): Node {
  const n = createNode("home", ROOM, at(spawnX), 100, [ROOM], 0);
  n.resources = [
    { type: "spawn", id: "spawn-0", position: at(spawnX) },
    { type: "controller", id: "ctrl-0", position: at(spawnX), isOwned: true } as NodeResource
  ];
  return n;
}

function graphOf(nodes: Node[]): FlowGraph {
  return new FlowGraph(nodes, new NodeNavigator(nodes, []));
}

describe("solver bridge: commissions reconstruct the FlowSolution's assignments", () => {
  const g = globalThis as unknown as { Game?: unknown };
  let savedGame: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  it("HARVEST: each miner commission reconstructs its FlowSolution MinerAssignment", () => {
    const { solution, commissions } = solveColony(graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]), 0, manhattan);

    const harvest = commissions.filter(c => c.kind === "harvest");
    expect(harvest.length).to.equal(solution.miners.length);
    expect(harvest.length).to.be.greaterThan(0);

    for (const c of harvest) {
      const rebuilt = minerAssignmentFromCommissioned(c.assignment as CommissionedMiner);
      const live = solution.miners.find(m => m.sourceId === rebuilt.sourceId);
      expect(live, `live miner for ${rebuilt.sourceId}`).to.not.equal(undefined);
      expect(rebuilt).to.deep.equal(live);
    }
  });

  it("CARRY: each source's route commissions reconstruct its FlowSolution HaulerAssignments", () => {
    const { solution, commissions } = solveColony(graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]), 0, manhattan);

    const carry = commissions.filter(c => c.kind === "carry");
    expect(carry.length).to.be.greaterThan(0);

    // every reconstructed hauler must equal exactly one live hauler (by edge), and
    // together they cover all of the FlowSolution's haulers.
    const rebuiltAll = carry.reduce<ReturnType<typeof haulerAssignmentFromCommissioned>[]>(
      (acc, c) => acc.concat((c.assignment as CommissionedHauler[]).map(haulerAssignmentFromCommissioned)),
      []
    );
    expect(rebuiltAll.length).to.equal(solution.haulers.length);
    for (const r of rebuiltAll) {
      const live = solution.haulers.find(h => h.edgeId === r.edgeId);
      expect(live, `live hauler for edge ${r.edgeId}`).to.not.equal(undefined);
      expect(r).to.deep.equal(live);
    }
  });

  it("UPGRADE: the controller commission reconstructs its FlowSolution SinkAllocation", () => {
    const { solution, commissions } = solveColony(graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]), 0, manhattan);

    const upgrade = commissions.filter(c => c.kind === "upgrade");
    expect(upgrade.length).to.be.greaterThan(0);

    for (const c of upgrade) {
      const { sink } = c.assignment as ConsumeAssignment;
      const rebuilt = sinkAllocationFromCommissioned(sink as CommissionedSink);
      const live = solution.sinkAllocations.find(a => a.sinkId === rebuilt.sinkId);
      expect(live, `live allocation for ${rebuilt.sinkId}`).to.not.equal(undefined);
      // priority/sourceFlows/allocated/demand/unmet/type all match the live path
      expect(rebuilt).to.deep.equal({
        sinkId: live!.sinkId,
        sinkType: live!.sinkType,
        allocated: live!.allocated,
        demand: live!.demand,
        unmet: live!.unmet,
        priority: live!.priority,
        sourceFlows: live!.sourceFlows
      });
    }
  });

  it("the consume commission carries the room's serving spawn (flow sink id); the kind strips it to the real id", () => {
    const { commissions } = solveColony(graphOf([homeNode(5), sourceNode("s1", 15)]), 0, manhattan);
    const consume = commissions.filter(c => c.shape === "consume");
    expect(consume.length).to.be.greaterThan(0);
    for (const c of consume) {
      // commissionsFromPlan carries the spawn SINK id (flow-prefixed)
      expect((c.assignment as ConsumeAssignment).spawnId).to.equal("spawn-spawn-0");
      // ...and materialize strips it to the real game id the scheduler matches on
      expect(upgradeKind.materialize(c, undefined).getSpawnId()).to.equal("spawn-0");
    }
  });
});
