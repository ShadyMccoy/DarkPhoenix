/* eslint-disable no-console */
/**
 * base-lab - a read-only lab for iterating on base designs.
 *
 * Loads a room (a captured fixture, or a synthetic RoomBuilder room), plans the
 * base (highways = hauler routes, alveolar extension field), and renders an
 * ASCII overlay + metrics so we can LOOK at a design. The planning lives in
 * plan.ts (importable, side-effect-free); this file is the CLI.
 *
 * Run:
 *   npx ts-node -P tsconfig.test.json scripts/base-lab/index.ts [fixture] [--fill alveoli|pockets] [--dead-bias N] [--target N]
 *   npx ts-node -P tsconfig.test.json scripts/base-lab/index.ts --list
 *   npx ts-node -P tsconfig.test.json scripts/base-lab/index.ts --synthetic
 */
import { SIZE, packTile, isWall, isSwamp } from "./geometry";
import {
  BasePlan,
  RCL8_EXTENSIONS,
  RoomInput,
  defaultFixture,
  listFixtures,
  loadFixture,
  planBase,
  synthetic
} from "./plan";

function render(plan: BasePlan): void {
  const { input, highways, reachSet, placed } = plan;
  const { terrain, objects } = input;
  const anchorGlyph = new Map<number, string>();
  for (const o of objects) {
    const g = o.type === "source" ? "*" : o.type === "controller" ? "K" : o.type === "mineral" ? "%" : "?";
    anchorGlyph.set(packTile(o.x, o.y), g);
  }

  const lines: string[] = [];
  for (let y = 0; y < SIZE; y++) {
    let row = "";
    for (let x = 0; x < SIZE; x++) {
      const tile = packTile(x, y);
      if (placed.has(tile)) row += placed.get(tile)!.glyph;
      else if (anchorGlyph.has(tile)) row += anchorGlyph.get(tile)!;
      else if (highways.has(tile)) row += "=";
      else if (isWall(terrain, x, y)) row += "#";
      else if (!reachSet.has(tile)) row += "x"; // sealed pocket
      else if (isSwamp(terrain, x, y)) row += ","; // swamp dead-space
      else row += "·"; // plain dead-space (middle dot)
    }
    lines.push(row);
  }

  console.log(`\n=== base-lab: ${input.name} ===`);
  console.log(lines.join("\n"));
  console.log("\nlegend: # wall  , swamp  · dead-space  = highway  x sealed  * source  K controller  % mineral");
  console.log("        P spawn  @ feeder/manager  L link  O storage  M terminal  T tower  B lab  E extension  C container");
}

function report(plan: BasePlan): void {
  const { input, opts } = plan;
  const cells = SIZE * SIZE;
  const walls = input.terrain.join("").split("").filter(c => c === "#").length;
  const swamp = input.terrain.join("").split("").filter(c => c === "~").length;
  const pct = (n: number, d: number): string => `${((100 * n) / d).toFixed(0)}%`;
  console.log("\n--- metrics ---");
  console.log(`room            ${input.name}`);
  console.log(`terrain         ${pct(walls, cells)} wall, ${pct(swamp, cells)} swamp, ${plan.passable} passable`);
  console.log(`spawn/manager   (${plan.spawn.x},${plan.spawn.y})  clearance ${plan.clearance(plan.spawn.x, plan.spawn.y)}`);
  console.log(
    `highways        ${plan.highways.size} tiles (${plan.highwaySwamp} on swamp) - hauler routes to sources/controller/exits, kept clear`
  );
  console.log(`dead space      ${plan.deadSpace} tiles (${pct(plan.deadSpace, plan.passable)} of passable) - the eddies`);
  console.log(`core pocket     ${plan.coreOk ? "placed" : "FAILED to fit at spawn"}`);
  console.log(
    `buildings       ${plan.spawnsPlaced} spawns, ${plan.towersPlaced} towers, ${plan.labsPlaced} labs (in dead-space, competing with extensions)`
  );
  console.log(
    `fill mode       ${opts.fillMode}` +
      (opts.fillMode === "pockets"
        ? ` (${plan.pocketCount} ring pockets)`
        : ` (wall-edge flood, grown from core, dead-bias ${opts.deadBias})`)
  );
  console.log(
    `extensions      ${plan.extPlaced}/${opts.target}` +
      (plan.extPlaced < opts.target ? `  (short ${opts.target - plan.extPlaced} - ran out of fitting dead-space)` : "  (target met)")
  );
  console.log(`compactness     mean ext travel-dist from core ${plan.meanExtDist.toFixed(1)} (lower = tighter blob = shorter refill)`);
  console.log(
    `outskirts       mean dead-end depth ${plan.meanExtDead.toFixed(1)} tiles from nearest artery; ${plan.extOnAccess} ext on the artery edge` +
      ` (higher depth = deeper in the dead-end suburbs)`
  );
  console.log(`note            extensions grow OUTWARD from the core into the dead-end suburbs, around the arteries`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--list")) {
    console.log(listFixtures().join("\n"));
    return;
  }
  const valueFlags = new Set(["--target", "--fill", "--dead-bias", "--commute"]);
  const flagVal = (name: string, dflt: string): string => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const target = Number(flagVal("--target", String(RCL8_EXTENSIONS)));
  const fillMode = flagVal("--fill", "alveoli");
  const deadBias = Number(flagVal("--dead-bias", "1"));
  const commuteSlack = Number(flagVal("--commute", "1.5"));
  const useSynthetic = args.includes("--synthetic");
  const positional = args.find((a, i) => !a.startsWith("--") && !(i > 0 && valueFlags.has(args[i - 1])));

  const input: RoomInput = useSynthetic ? synthetic() : loadFixture(positional ?? defaultFixture());
  const plan = planBase(input, { target, fillMode, deadBias, commuteSlack });
  render(plan);
  report(plan);
}

main();
