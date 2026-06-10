import { expect } from "chai";
import {
  isSpawnPlacementInProgress,
  resetSpawnPlacement,
  startSpawnPlacement,
  runSpawnPlacementStep,
} from "../../../src/execution/SpawnPlacementScheduler";
import { Node, NodeResource, NodeROI, createNode } from "../../../src/nodes/Node";
import { Position } from "../../../src/types/Position";

const ROOM = "W0N0";
function at(x: number, y: number): Position {
  return { x, y, roomName: ROOM };
}

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

function nodeWithManyTiles(): { node: Node; territories: Map<string, Position[]> } {
  const resources: NodeResource[] = [
    { type: "source", id: "s", position: at(25, 30), capacity: 3000 },
    { type: "controller", id: "c", position: at(25, 20) },
  ];
  const node = createNode("node-A", ROOM, at(25, 25), 100, [ROOM], 0);
  node.resources = resources;
  node.roi = roi(50);

  // ~100 candidate tiles so the sweep spans more than one tick at 40/tick.
  const tiles: Position[] = [];
  for (let i = 0; i < 100; i++) tiles.push(at(10 + (i % 30), 10 + Math.floor(i / 30)));
  return { node, territories: new Map([["node-A", tiles]]) };
}

function setCpu(bucket: number): void {
  // Flat CPU clock (getUsed always 0): the hard per-tick eval cap drives yielding.
  (global as any).Game = {
    cpu: { getUsed: () => 0, limit: 20, tickLimit: 500, bucket },
  };
}

describe("SpawnPlacementScheduler", () => {
  beforeEach(() => {
    resetSpawnPlacement();
    setCpu(10000);
    (global as any).Memory = {};
  });

  it("starts nothing when no node qualifies", () => {
    expect(startSpawnPlacement([], new Map(), 5)).to.equal(false);
    expect(isSpawnPlacementInProgress()).to.equal(false);
  });

  it("spreads a large sweep across ticks and persists the result", () => {
    const { node, territories } = nodeWithManyTiles();
    expect(startSpawnPlacement([node], territories, 5)).to.equal(true);
    expect(isSpawnPlacementInProgress()).to.equal(true);

    // First tick: capped, not finished.
    expect(runSpawnPlacementStep()).to.equal(null);
    expect(isSpawnPlacementInProgress()).to.equal(true);

    // Subsequent ticks finish it (80 candidates after cap, 40/tick -> 2 ticks).
    let results = runSpawnPlacementStep();
    let guard = 0;
    while (results === null && guard++ < 10) results = runSpawnPlacementStep();

    expect(results).to.not.equal(null);
    expect(isSpawnPlacementInProgress()).to.equal(false);

    const placement = (global as any).Memory.spawnPlacements["node-A"];
    expect(placement).to.not.equal(undefined);
    expect(placement.value).to.be.greaterThan(0);
    expect(placement.roomName).to.equal(ROOM);
  });

  it("defers the sweep when the CPU bucket is low", () => {
    const { node, territories } = nodeWithManyTiles();
    startSpawnPlacement([node], territories, 5);

    setCpu(100); // below MIN_BUCKET
    expect(runSpawnPlacementStep()).to.equal(null);
    expect(isSpawnPlacementInProgress()).to.equal(true); // no progress made

    setCpu(10000); // bucket recovered
    let results = runSpawnPlacementStep();
    let guard = 0;
    while (results === null && guard++ < 10) results = runSpawnPlacementStep();
    expect(results).to.not.equal(null);
  });
});
