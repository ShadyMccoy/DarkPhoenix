/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { assembleEconomyForSolve } from "../../../src/economy/planningAssembly";
import { createNode, Node, NodeResource } from "../../../src/nodes/Node";

/**
 * Spec 35 phase G (the ONE sanctioned behavior change of the refactor): BOTH
 * planning paths - the scheduled cadence and the console-forced global.plan()
 * - run the ONE solve-input assembly, and that assembly ADMITS the
 * construction project ledger's sinks before solving.
 *
 * The bug this pins shut: pre-G, global.plan() duplicated the rebuild+solve
 * WITHOUT sink admission, so a console-forced plan solved with zero
 * construction sinks and published a plan that zeroed construction
 * colony-wide until the next scheduled solve.
 */
describe("planningAssembly - the ONE solve-input assembly (spec 35 phase G)", () => {
  const g = globalThis as unknown as { Game?: any; Memory?: any };
  let savedGame: unknown;
  let savedMemory: unknown;

  const at = (x: number) => ({ x, y: 25, roomName: "W0N0" });
  function world(): Node[] {
    const home = createNode("home", "W0N0", at(5) as any, 100, ["W0N0"], 0);
    home.resources = [
      { type: "spawn", id: "spawn-0", position: at(5) },
      { type: "controller", id: "ctrl-0", position: at(5), isOwned: true } as NodeResource
    ];
    const src = createNode("s1", "W0N0", at(15) as any, 50, ["W0N0"], 0);
    src.resources = [{ type: "source", id: "s1", position: at(15), capacity: 3000 } as NodeResource];
    return [home, src];
  }

  beforeEach(() => {
    savedGame = g.Game;
    savedMemory = g.Memory;
    g.Game = { time: 0, getObjectById: () => null, rooms: {}, creeps: {}, spawns: {} };
    // The construction corps' durable project ledger (rehydrates without
    // vision) - THE sink-admission data source (constructionProjectLedger),
    // staged the way a live construction corp persists it.
    g.Memory = {
      commissionedCorps: {
        "construction-home": {
          kind: "construction",
          corp: {
            projects: [
              {
                id: "site-ext-1",
                x: 7,
                y: 25,
                roomName: "W0N0",
                structureType: "extension",
                remaining: 3000,
                seen: 0
              }
            ]
          }
        }
      }
    };
  });
  afterEach(() => {
    g.Game = savedGame;
    g.Memory = savedMemory;
  });

  it("admits the project ledger's sites as construction sinks and SOLVES", () => {
    const economy = assembleEconomyForSolve(world(), 0);

    const construction = economy.getFlowGraph().getSinks("construction");
    expect(
      construction.map(s => s.gameId),
      "the ledger project must be a sink in the solved economy"
    ).to.include("site-ext-1");

    // ...and the assembly ends in a real published plan: the solve ran over
    // the graph WITH the construction sink in it.
    expect(economy.getSolution(), "assembly must end in a solve").to.not.equal(null);
    expect(economy.getCommissions().length, "the solve publishes commissions").to.be.greaterThan(0);
  });

  it("the FORCED path runs this same assembly (wiring pin: console plan -> runPlanningPhase -> assembleEconomyForSolve)", () => {
    // The behavior half is above; this half pins the WIRING (in the repo's
    // purity.test.ts source-scan style) so the pre-G bug class - a second,
    // admission-less solve path behind global.plan() - cannot silently return.
    const mainSrc = fs.readFileSync(path.join(__dirname, "../../../src/main.ts"), "utf8");
    const consoleSrc = fs.readFileSync(path.join(__dirname, "../../../src/execution/console.ts"), "utf8");

    // ONE runPlanningPhase in main.ts, and it goes through the assembly seam.
    expect(mainSrc).to.match(/function runPlanningPhase\(force: boolean\)/);
    expect(mainSrc, "the planning phase must solve through the assembly seam").to.include(
      "assembleEconomyForSolve(planningNodes, Game.time)"
    );
    // The scheduled path calls it...
    expect(mainSrc).to.include("runPlanningPhase(false)");
    // ...and the console-forced path calls the SAME function with force=true.
    expect(consoleSrc).to.include("deps.runPlanningPhase(true)");

    // The admission-less duplicate is GONE: main.ts constructs a FlowEconomy
    // only in getOrCreateFlowEconomy's cold-start restore (which the first
    // planning pass immediately supersedes) - never as a solve path of its own.
    const rawConstructions = mainSrc.match(/new FlowEconomy\(/g) ?? [];
    expect(rawConstructions.length, "main.ts FlowEconomy constructions").to.equal(1);
  });
});
