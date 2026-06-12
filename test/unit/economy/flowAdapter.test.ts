import { expect } from "chai";
import { FlowGraph } from "../../../src/flow/FlowGraph";
import { NodeNavigator } from "../../../src/nodes/NodeNavigator";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";
import {
  solveWithCorpPlanner,
  constructionAbsorbForFill,
  CONSTRUCTION_ABSORB_RATE,
  CONSTRUCTION_ABSORB_MAX
} from "../../../src/economy/flowAdapter";
import { netEnergy } from "../../../src/economy/primitives";
import { PlannerSource, INCOME_THROTTLE_LOW, INCOME_THROTTLE_HIGH } from "../../../src/economy/CorpPlanner";
import { Position } from "../../../src/types/Position";

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

// The adapter is the drop-in seam: CorpPlanner over a live FlowGraph, emitting the
// FlowSolution the materialiser consumes. These tests pin the integration-critical
// behaviors from first principles (deterministic manhattan distance, no sim).
describe("economy/flowAdapter - CorpPlanner as the FlowSolution authority", () => {
  const g = globalThis as unknown as { Game?: unknown };
  let savedGame: unknown;

  beforeEach(() => {
    savedGame = g.Game;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
  });
  afterEach(() => {
    g.Game = savedGame;
  });

  it("mines profitable sources and feeds the spawn its overhead, controller the rest", () => {
    // spawn+controller at x=5; sources at x=15 (d=10) and x=25 (d=20)
    const graph = graphOf([homeNode(5), sourceNode("s1", 15), sourceNode("s2", 25)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    // both sources mined
    expect(sol.miners.map(m => m.sourceId).sort()).to.deep.equal(["source-s1", "source-s2"]);
    expect(sol.totalHarvest).to.be.closeTo(20, 1e-9);

    // spawn sink fed up to its demand (~10), NOT the whole 20 - controller gets the surplus
    const spawnAlloc = sol.sinkAllocations.find(a => a.sinkType === "spawn")!;
    const ctrlAlloc = sol.sinkAllocations.find(a => a.sinkType === "controller")!;
    expect(spawnAlloc.allocated).to.be.closeTo(10, 1e-9);
    expect(ctrlAlloc.allocated).to.be.closeTo(10, 1e-9);

    // every mined source has at least one hauler carrying its energy somewhere
    expect(sol.haulers.filter(h => h.fromId === "source-s1").length).to.be.greaterThan(0);
    expect(sol.haulers.filter(h => h.fromId === "source-s2").length).to.be.greaterThan(0);
    expect(sol.isSustainable).to.equal(true);
  });

  it("skips a source whose real distance makes it unprofitable", () => {
    expect(netEnergy(10, 320)).to.be.lessThan(0);
    // s_far at x=325 is manhattan 320 from the spawn at x=5
    const graph = graphOf([homeNode(5), sourceNode("s_near", 15), sourceNode("s_far", 325)]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const mined = sol.miners.map(m => m.sourceId);
    expect(mined).to.include("source-s_near");
    expect(mined).to.not.include("source-s_far");
  });

  it("fields a scavenger (hauler, no miner) for an injected ground stock", () => {
    const graph = graphOf([homeNode(5), sourceNode("s1", 15)]);
    // a 1500-energy stock at x=30 (distance 25 from the spawn), as a transient source
    const stock: PlannerSource = {
      id: "scavenge-W0N0-30-25",
      nodeId: "W0N0-scavenge",
      pos: at(30),
      rate: 8,
      maxMiners: 0,
      transient: true
    };
    const sol = solveWithCorpPlanner(graph, 0, manhattan, [stock]);

    // the real source is mined; the stock is scavenged with NO miner of its own
    expect(sol.miners.map(m => m.sourceId)).to.deep.equal(["source-s1"]);
    const scavHaulers = sol.haulers.filter(h => h.fromId === "scavenge-W0N0-30-25");
    expect(scavHaulers.length, "a scavenger hauls the stock").to.be.greaterThan(0);
    // the stock's energy reaches a sink
    expect(sol.totalHarvest).to.be.closeTo(10 + 8, 1e-9);
  });

  it("honors the controller's anti-downgrade reserve under scarce supply", () => {
    // one thin source: the spawn (value 100) would take it all, but the controller
    // keeps its reserve trickle.
    const thin = createNode("s1", ROOM, at(15), 50, [ROOM], 0);
    thin.resources = [{ type: "source", id: "s1", position: at(15), capacity: 3000 }];
    // shrink supply by overriding capacity via a low-rate source node
    const lowRate = createNode("s1", ROOM, at(15), 50, [ROOM], 0);
    lowRate.resources = [{ type: "source", id: "s1", position: at(15), capacity: 900 } as NodeResource]; // 3/tick
    const graph = graphOf([homeNode(5), lowRate]);
    const sol = solveWithCorpPlanner(graph, 0, manhattan);

    const ctrlAlloc = sol.sinkAllocations.find(a => a.sinkType === "controller");
    expect(ctrlAlloc, "controller is present").to.not.be.undefined;
    expect(ctrlAlloc!.allocated).to.be.greaterThan(1.9); // reserve protected even vs the spawn
  });
});

describe("constructionAbsorbForFill (Lever 2)", () => {
  it("stays at the modest base while energy is scarce (cold start unchanged)", () => {
    expect(constructionAbsorbForFill(0)).to.equal(CONSTRUCTION_ABSORB_RATE);
    expect(constructionAbsorbForFill(INCOME_THROTTLE_LOW)).to.equal(CONSTRUCTION_ABSORB_RATE);
  });

  it("opens up to the max once stores are full (building soaks the surplus)", () => {
    expect(constructionAbsorbForFill(INCOME_THROTTLE_HIGH)).to.equal(CONSTRUCTION_ABSORB_MAX);
    expect(constructionAbsorbForFill(1)).to.equal(CONSTRUCTION_ABSORB_MAX);
  });

  it("ramps monotonically up over the same band the income throttle uses", () => {
    let prev = CONSTRUCTION_ABSORB_RATE - 1e-9;
    for (let f = 0; f <= 1.0001; f += 0.05) {
      const a = constructionAbsorbForFill(f);
      expect(a).to.be.at.least(prev - 1e-9); // non-decreasing
      expect(a).to.be.within(CONSTRUCTION_ABSORB_RATE, CONSTRUCTION_ABSORB_MAX);
      prev = a;
    }
    // The base is below a single 2-WORK builder's 10/tick - that throttle is why
    // building stalled; the full-reservoir cap clears two builders' worth.
    expect(CONSTRUCTION_ABSORB_RATE).to.be.lessThan(10);
    expect(CONSTRUCTION_ABSORB_MAX).to.be.at.least(20);
  });
});
