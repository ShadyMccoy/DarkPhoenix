/**
 * scenarios.ts — checked-in staged worlds. The bootstrap cascade is the
 * first certification scenario (v0 ruling): an empty ledger on a
 * two-source room with the founding kernel laid out — spawn and bank
 * co-located between production and the controller.
 */
import { Scenario, emptyTerrain, setCell } from "./scenario";

function withWalls(cells: [number, number][]): string[] {
  const t = emptyTerrain();
  for (const [x, y] of cells) setCell(t, x, y, "#");
  return t;
}

export function bootstrapScenario(): Scenario {
  const walls: [number, number][] = [];
  // A ridge that makes srcB's route a real detour, not a straight line.
  for (let y = 2; y <= 16; y++) walls.push([34, y]);
  for (let x = 6; x <= 16; x++) walls.push([x, 31]);
  return {
    name: "bootstrap",
    terrain: withWalls(walls),
    spawn: { x: 24, y: 25 },
    bank: { x: 25, y: 26 },
    controller: { x: 28, y: 28 },
    sources: [
      { id: "srcA", x: 12, y: 36 },
      { id: "srcB", x: 43, y: 6 }
    ],
    bankStock: 300,
    bodyBudget: 300,
    creeps: []
  };
}
