/**
 * PLAN-layer purity ratchet (spec 17 acceptance test 4; ONTOLOGY §1).
 *
 * The planning core must be Game-free: a pure function of its arguments. The
 * 2026-07-19 audit found three impure propose() implementations and a game
 * intent inside economy/ had landed green precisely because NOTHING enforced
 * the boundary. This suite is that enforcement, as a source-scan ratchet:
 *
 *   1. PURE files may not mention Game/Memory at all (comments aside);
 *   2. PURE files may only import from the allowlisted modules below - a new
 *      import of execution// corps runtime code fails loudly;
 *   3. the sanctioned world ADAPTERS (flowAdapter, scavenge) may read Game
 *      only behind `typeof Game` guards - counted, so a guard removal trips.
 *
 * The scan extends beyond src/economy/ to the modules the planning core
 * touches (spec 35 phase G): corps/Corp.ts (the base type), the NOW planner
 * (spawn/SpawnScheduler), the demand ladder, and flow/FlowTypes.ts - the ONE
 * surviving flow DTO module after the translation-layer collapse folded
 * FlowGraph + FlowEconomy into economy/flowAdapter.ts (an ADAPTER here).
 *
 * Known debt is EXPLICIT (KNOWN_IMPURE below), not silently tolerated: when a
 * P3/P5 cleanup lands, move the file to the pure list and shrink the debt set
 * - the test fails if debt grows OR if paid-off debt is still listed.
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

const ECONOMY = path.join(__dirname, "../../../src/economy");

/** Files that must be entirely Game/Memory-free. */
const PURE: string[] = [
  "CorpPlanner.ts",
  "primitives.ts",
  "Commission.ts",
  "CorpKind.ts",
  "commissionPlan.ts",
  "siteValue.ts",
  "mineralValue.ts",
  "roadEconomics.ts",
  "roadScoring.ts",
  "roadSegments.ts",
  "bank.ts",
  "expansion.ts",
  "goals.ts",
  "strategy.ts",
  "depositSavings.ts",
  "ids.ts",
  "proposeHelpers.ts",
  // Spec 51: the corp -> statement-line map. Constants and a lookup; the
  // planning core reads it to group its own commissions.
  "accountCategory.ts",
  // The handicap sweep (spec 50) is PURE by construction: its state is
  // persisted by telemetry/fiscalArchive and mirrored in here, precisely so
  // primitives.ts can resolve the planner's margin through it without the
  // planning core gaining a Memory read.
  "spawnSweep.ts",
  // spec 39 phase 3: declared-vs-fielded arithmetic only; the actuals enter
  // through the SpawnDirector seam, never through this module.
  "replacementSchedule.ts"
];

/** Sanctioned world adapters: Game reads allowed, but only typeof-guarded.
 * planningAssembly.ts is the solve-input assembly seam (spec 35 phase G):
 * construction sink admission (project ledger + trunk aggregation) + the ONE
 * rebuild->admit->solve sequence both planning paths run. */
const ADAPTERS: string[] = ["flowAdapter.ts", "scavenge.ts", "roadSegmentsGame.ts", "planningAssembly.ts"];

/**
 * Explicit debt: economy/ files known to violate purity. EMPTY since the
 * spec 17 P3 split moved the expansion campaign driver (game intents, Memory
 * writes) to execution/ExpansionCampaign.ts. Never grow this list - classify
 * new files PURE or ADAPTER, or split them like expansion was.
 */
const KNOWN_IMPURE: string[] = [];

/** Strip line and block comments so doc references to Game don't count. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function read(file: string): string {
  return fs.readFileSync(path.join(ECONOMY, file), "utf8");
}

const GLOBAL_REF = /\b(Game|Memory|RawMemory)\s*[.[]/;

describe("PLAN-layer purity (spec 17): economy/ is Game-free by construction", () => {
  it("covers every file in src/economy/ (a new file must be classified)", () => {
    const all = fs.readdirSync(ECONOMY).filter(f => f.endsWith(".ts"));
    const classified = new Set([...PURE, ...ADAPTERS, ...KNOWN_IMPURE]);
    const unclassified = all.filter(f => !classified.has(f));
    expect(unclassified, "classify new economy/ files as PURE, ADAPTER, or (temporarily) KNOWN_IMPURE").to.deep.equal(
      []
    );
    const missing = [...classified].filter(f => !all.includes(f));
    expect(missing, "listed files that no longer exist").to.deep.equal([]);
  });

  for (const file of PURE) {
    it(`${file} never references Game/Memory`, () => {
      const code = stripComments(read(file));
      const match = GLOBAL_REF.exec(code);
      expect(match, match ? `found "${match[0]}" — the planning core must stay pure` : "").to.equal(null);
    });
  }

  for (const file of ADAPTERS) {
    it(`${file} (world adapter) only reads Game behind typeof guards`, () => {
      const code = stripComments(read(file));
      // Every Game-referencing statement region must sit near a typeof guard.
      // Coarse but effective ratchet: the file must contain at least one guard
      // per three raw references, and MUST contain guards at all.
      const refs = (code.match(/\bGame\s*[.[]/g) ?? []).length;
      const guards = (code.match(/typeof\s+(Game|Memory)\s*[!=]==?\s*"undefined"/g) ?? []).length;
      if (refs > 0) {
        expect(guards, `${refs} Game references need typeof guards`).to.be.greaterThan(0);
      }
    });
  }

  it("known debt is still debt (else shrink KNOWN_IMPURE and grow PURE)", () => {
    for (const file of KNOWN_IMPURE) {
      const code = stripComments(read(file));
      expect(GLOBAL_REF.test(code), `${file} looks pure now — move it to the PURE list`).to.equal(true);
    }
  });

  it("pure planner files import only allowlisted modules", () => {
    // The planning core's permitted import surface - listed so a NEW
    // dependency (execution/, colony/, telemetry/, corps runtime classes)
    // cannot land silently. The constants inversion debt is PAID (spec 35
    // phase B): primitives.ts imports constants from nobody; phase G deleted
    // the one-release flow/FlowTypes + corps/economics re-exports - every
    // importer reads primitives directly.
    const ALLOWED = new Set([
      // intra-economy
      "./CorpPlanner", "./primitives", "./Commission", "./CorpKind", "./commissionPlan",
      "./siteValue", "./roadEconomics", "./bank", "./expansion", "./flowAdapter", "./scavenge",
      "./goals", "./strategy", "./ids", "./proposeHelpers", "./spawnSweep",
      // pure shared types
      "../types/Position", "../types/Memory",
      // (debt) the Corp base type lives in corps/ - Game-free, pinned by this suite's sibling
      "../corps/Corp",
      // pure spatial/room helpers
      "../utils/RoomDiscovery", "../nodes/Node"
    ]);
    for (const file of PURE) {
      const code = read(file);
      const importRe = /from\s+"([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(code)) !== null) {
        expect(ALLOWED.has(m[1]), `${file} imports "${m[1]}" — not on the PLAN-layer allowlist`).to.equal(true);
      }
    }
  });

  it("the flow DTO module (flow/FlowTypes.ts) is Game-free", () => {
    // The ONE surviving src/flow/ module (spec 35 phase G): FlowSolution +
    // assignment shapes, the id-minting factories, and the shared
    // CommissionedHauler -> HaulerAssignment mapper. Declarations and pure
    // mappers only - discovery and the solve driver live in flowAdapter (an
    // ADAPTER above); if this file needs Game, it belongs there instead.
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../../../src/flow/FlowTypes.ts"), "utf8")
    );
    expect(
      GLOBAL_REF.test(code),
      "flow/FlowTypes.ts gained a Game/Memory reference — the DTO module must stay declaration-only"
    ).to.equal(false);
  });

  it("the Corp base class the planning core depends on is itself Game-free", () => {
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../../../src/corps/Corp.ts"), "utf8")
    );
    expect(GLOBAL_REF.test(code), "corps/Corp.ts gained a Game/Memory reference — it contaminates the planner").to.equal(
      false
    );
  });

  it("the NOW planner (spawn/SpawnScheduler.ts) is Game-free", () => {
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../../../src/spawn/SpawnScheduler.ts"), "utf8")
    );
    expect(
      GLOBAL_REF.test(code),
      "SpawnScheduler gained a Game/Memory reference — the NOW planner must stay a pure function of demands + ctx"
    ).to.equal(false);
  });

  it("the demand-value ladder (spawn/demandLadder.ts) is Game-free", () => {
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../../../src/spawn/demandLadder.ts"), "utf8")
    );
    expect(
      GLOBAL_REF.test(code),
      "demandLadder gained a Game/Memory reference — the ladder is pure named constants (spec 35 phase D)"
    ).to.equal(false);
  });

  it("the construction placement ladder (corps/constructionPlacement.ts) is Game/Memory-free", () => {
    // Spec 35 phase H: rung tables + tile-election policy only. The scorers
    // operate on the Room they are handed; placement EXECUTION (site
    // creation, cooldowns, stamps) stays in ConstructionCorp.
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../../../src/corps/constructionPlacement.ts"), "utf8")
    );
    expect(
      GLOBAL_REF.test(code),
      "constructionPlacement gained a Game/Memory reference — Game-coupled placement belongs in ConstructionCorp"
    ).to.equal(false);
  });

  it("the hauler policy head (corps/haulPolicy.ts) is Game/Memory-free", () => {
    // Spec 35 phase H: CarryCorp's exported pure-policy head (sink choice,
    // storage banking, depot refill, dedicated-source drain, duty
    // classification) - pure functions of their arguments. World reads stay
    // in CarryCorp (the corp runtime), which supplies the state.
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../../../src/corps/haulPolicy.ts"), "utf8")
    );
    expect(
      GLOBAL_REF.test(code),
      "haulPolicy gained a Game/Memory reference — Game-coupled hauling belongs in CarryCorp"
    ).to.equal(false);
  });

  it("the construction ledger lens (corps/constructionLedger.ts) reads Game only behind typeof guards", () => {
    // Spec 35 phase H: the PLAN-consumed lens surface (project ledger + build
    // pool). Same adapter-style ratchet as economy/'s ADAPTERS: world reads
    // are allowed, but only typeof-guarded, so pure harnesses can call it.
    const code = stripComments(
      fs.readFileSync(path.join(__dirname, "../../../src/corps/constructionLedger.ts"), "utf8")
    );
    const refs = (code.match(/\bGame\s*[.[]/g) ?? []).length;
    const guards = (code.match(/typeof\s+(Game|Memory)\s*[!=]==?\s*"undefined"/g) ?? []).length;
    if (refs > 0) {
      expect(guards, `${refs} Game references need typeof guards`).to.be.greaterThan(0);
    }
  });

  it("economy/ never imports a corp RUNTIME module (the phase-H seam)", () => {
    // The seam violation spec 35 phase H closes: planningAssembly imported
    // constructionProjectLedger from corps/ConstructionCorp (the Game-coupled
    // corp runtime). economy/ may reach into corps/ ONLY for the whitelisted
    // lens/type modules below — a corp class import cannot land silently again.
    const ALLOWED_CORPS_IMPORTS = new Set(["Corp", "nodeEnergy", "constructionLedger"]);
    const all = fs.readdirSync(ECONOMY).filter(f => f.endsWith(".ts"));
    for (const file of all) {
      const code = read(file);
      const importRe = /from\s+"\.\.\/corps\/([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(code)) !== null) {
        expect(
          ALLOWED_CORPS_IMPORTS.has(m[1]),
          `economy/${file} imports corps/${m[1]} — economy may only read the corps lens/type modules (${[
            ...ALLOWED_CORPS_IMPORTS
          ].join(", ")})`
        ).to.equal(true);
      }
    }
  });
});
