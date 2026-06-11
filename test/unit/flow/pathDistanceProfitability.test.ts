import { expect } from "chai";
import { FlowGraph } from "../../../src/flow/FlowGraph";
import { FlowSolver } from "../../../src/flow/FlowSolver";
import { NodeNavigator, clearPathDistanceCache } from "../../../src/nodes/NodeNavigator";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";
import { DEFAULT_CONSTRAINTS, MinerAssignment } from "../../../src/flow/FlowTypes";
import { Position } from "../../../src/types/Position";

const ROOM = "W0N0";
const at = (x: number, y: number): Position => ({ x, y, roomName: ROOM });

// ---------------------------------------------------------------------------
// A real (8-directional, uniform-cost) BFS standing in for the engine's
// PathFinder, so pathDistance() computes a true walled path instead of falling
// back to the crow-flies estimate. The unit-test MockPathFinder returns an empty
// path; here we want the genuine detour, so we install our own.
// ---------------------------------------------------------------------------
type Pt = { x: number; y: number };

function bfsSteps(start: Pt, target: Pt, isWall: (x: number, y: number) => boolean): Pt[] {
  // Goal is reached at chebyshev range 1 of the target (matches pathDistance's
  // goal range), mirroring a hauler that stops adjacent to the source.
  const within1 = (p: Pt) => Math.max(Math.abs(p.x - target.x), Math.abs(p.y - target.y)) <= 1;
  if (within1(start)) return [];
  const key = (p: Pt) => `${p.x},${p.y}`;
  const prev = new Map<string, Pt | null>();
  prev.set(key(start), null);
  let frontier: Pt[] = [start];
  while (frontier.length) {
    const next: Pt[] = [];
    for (const p of frontier) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nx = p.x + dx;
          const ny = p.y + dy;
          if (nx < 0 || nx > 49 || ny < 0 || ny > 49) continue;
          if (isWall(nx, ny)) continue;
          const np = { x: nx, y: ny };
          if (prev.has(key(np))) continue;
          prev.set(key(np), p);
          if (within1(np)) {
            // Reconstruct path length.
            const path: Pt[] = [];
            let cur: Pt | null = np;
            while (cur && key(cur) !== key(start)) {
              path.push(cur);
              cur = prev.get(key(cur)) ?? null;
            }
            return path.reverse();
          }
          next.push(np);
        }
      }
    }
    frontier = next;
  }
  return []; // unreachable
}

function installPathFinder(isWall: (x: number, y: number) => boolean): void {
  const g = globalThis as unknown as { PathFinder?: unknown; RoomPosition?: unknown };
  g.RoomPosition = function (this: Pt & { roomName: string }, x: number, y: number, roomName: string) {
    this.x = x;
    this.y = y;
    this.roomName = roomName;
  };
  g.PathFinder = {
    search(origin: Pt, goal: { pos: Pt }) {
      const path = bfsSteps({ x: origin.x, y: origin.y }, { x: goal.pos.x, y: goal.pos.y }, isWall);
      return { path, ops: path.length, cost: path.length, incomplete: path.length === 0 };
    }
  };
}

function removePathFinder(): void {
  const g = globalThis as unknown as { PathFinder?: unknown };
  g.PathFinder = undefined;
}

// ---------------------------------------------------------------------------
// Minimal real FlowGraph: one node holds the spawn, another the source. Both in
// the same room, with a wall column forcing the source's haulers on a long
// detour - the exact case the analytic estimate (Chebyshev, wall-blind) gets
// wrong.
// ---------------------------------------------------------------------------
const SPAWN = at(5, 25);
const SOURCE = at(20, 25);

function buildGraph(): FlowGraph {
  const spawnRes: NodeResource = { type: "spawn", id: "spawn-0", position: SPAWN };
  const sourceRes: NodeResource = { type: "source", id: "src-0", position: SOURCE, capacity: 3000 };

  const home: Node = createNode("home", ROOM, SPAWN, 100, [ROOM], 0);
  home.resources = [spawnRes];
  const remote: Node = createNode("remote", ROOM, SOURCE, 100, [ROOM], 0);
  remote.resources = [sourceRes];

  const nodes = [home, remote];
  const graph = new FlowGraph(nodes, new NodeNavigator(nodes, []));
  graph.buildEdges();
  return graph;
}

function minerFor(graph: FlowGraph, sourceId: string): MinerAssignment | undefined {
  const solution = new FlowSolver().solve({
    sources: graph.getSources(),
    sinks: graph.getSinks(),
    edges: graph.getEdges(),
    constraints: DEFAULT_CONSTRAINTS
  });
  return solution.miners.find(m => m.sourceId === sourceId);
}

// A vertical wall at x=12 with the only gap at the very top (y=0) forces any
// route between the spawn (x=5) and the source (x=20) up and over.
const wallWithTopGap = (x: number, y: number): boolean => x === 12 && y !== 0;

describe("pathDistance feeds the real walled distance into the profitability gate", () => {
  const g = globalThis as unknown as { Game?: unknown; PathFinder?: unknown; RoomPosition?: unknown };
  let saved: { Game?: unknown; PathFinder?: unknown; RoomPosition?: unknown };

  beforeEach(() => {
    saved = { Game: g.Game, PathFinder: g.PathFinder, RoomPosition: g.RoomPosition };
    // Minimal Game so FlowGraph's source discovery (which probes getObjectById
    // for mining spots) works regardless of what an earlier test left behind.
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {} };
    clearPathDistanceCache();
  });

  afterEach(() => {
    g.Game = saved.Game;
    g.PathFinder = saved.PathFinder;
    g.RoomPosition = saved.RoomPosition;
    clearPathDistanceCache();
  });

  it("crow-flies (old behavior): the walled source looks close and cheap", () => {
    clearPathDistanceCache();
    removePathFinder(); // no engine PathFinder -> pathDistance falls back to the estimate
    const graph = buildGraph();

    const edge = graph.getEdge("source-src-0", "spawn-spawn-0");
    // Chebyshev(5,25)->(20,25) = 15: the wall is invisible to the estimate.
    expect(edge?.distance).to.equal(15);

    const miner = minerFor(graph, "source-src-0");
    expect(miner, "source is assigned under the cheap estimate").to.not.be.undefined;
    expect(miner!.spawnDistance).to.equal(15);
  });

  it("real path (fixed): the wall is revealed, distance and overhead jump", () => {
    clearPathDistanceCache();
    installPathFinder(wallWithTopGap);
    const graph = buildGraph();

    const edge = graph.getEdge("source-src-0", "spawn-spawn-0");
    // The detour up to the y=0 gap and back down is far longer than 15 tiles.
    expect(edge?.distance, "real path reflects the wall detour").to.be.greaterThan(40);

    const miner = minerFor(graph, "source-src-0");
    expect(miner, "still profitable, but now correctly priced").to.not.be.undefined;
    expect(miner!.spawnDistance).to.equal(edge!.distance);
  });

  it("the fix lowers the source's efficiency vs the wall-blind estimate", () => {
    // Same source, same positions - only the distance function differs. This is
    // the whole fix: the economy now prices the detour instead of ignoring it.
    clearPathDistanceCache();
    removePathFinder();
    const crowFlies = minerFor(buildGraph(), "source-src-0")!;

    clearPathDistanceCache();
    installPathFinder(wallWithTopGap);
    const realPath = minerFor(buildGraph(), "source-src-0")!;

    expect(realPath.spawnDistance).to.be.greaterThan(crowFlies.spawnDistance);
    expect(realPath.efficiency).to.be.lessThan(crowFlies.efficiency);
  });
});
