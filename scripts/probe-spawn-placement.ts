/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * probe-spawn-placement - sweep a territory for the best spawn tile.
 *
 * Builds a synthetic node (one source + a controller) over a block of candidate
 * tiles, runs the placement job to completion, and prints the winning tile plus
 * a handful of ranked candidates - the same valuation the live CPU-budgeted
 * sweep performs, just run all at once here.
 */
// Define the Screeps body-part constants the corps' body builders read at load
// (the game/test harness provides these; a bare ts-node script does not).
import "../test/setup-mocha";
import { Position } from "../src/types/Position";
import { spawnSiteValue } from "../src/economy/siteValue";
import {
  SpawnCandidateContext,
  createPlacementJob,
  stepPlacementJob,
  placementResults,
} from "../src/planning/SpawnPlacement";

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}

// Source and controller in opposite corners so the best spawn tile is a unique
// interior point (not a degenerate collinear plateau).
const sourcePos = at(38, 38);
const controllerPos = at(12, 12);

// Candidate tiles: an 11x11 block spanning the middle of the room.
const candidates: Position[] = [];
for (let y = 15; y <= 35; y += 2) for (let x = 15; x <= 35; x += 2) candidates.push(at(x, y));

const ctx: SpawnCandidateContext = {
  nodeId: "node-A",
  localSources: [{ id: "source-A", capacity: 3000, pos: sourcePos }],
  controllerPos,
  candidates,
};

const job = createPlacementJob([ctx]);
stepPlacementJob(job, candidates.length); // run the whole sweep at once
const best = placementResults(job)[0];

console.log(`source @ (${sourcePos.x},${sourcePos.y}), controller @ (${controllerPos.x},${controllerPos.y})`);
console.log(`evaluated ${job.evaluated} candidate tiles`);
console.log(`\nbest spawn tile: (${best.pos!.x},${best.pos!.y})  value=${best.value.toFixed(3)} e/tick`);

const ranked = candidates
  .map((pos) => ({ pos, value: spawnSiteValue(pos, ctx.localSources, controllerPos) }))
  .sort((a, b) => b.value - a.value);

console.log(`\ntop 5 tiles:`);
for (const r of ranked.slice(0, 5)) console.log(`  (${r.pos.x},${r.pos.y})  ${r.value.toFixed(3)}`);
const worst = ranked[ranked.length - 1];
console.log(`worst tile: (${worst.pos.x},${worst.pos.y})  ${worst.value.toFixed(3)}`);
console.log(`\nspread best->worst: ${(best.value - worst.value).toFixed(3)} e/tick (${(((best.value - worst.value) / worst.value) * 100).toFixed(1)}%)`);
