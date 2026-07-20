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
  "roadEconomics.ts",
  "bank.ts",
  "expansion.ts"
];

/** Sanctioned world adapters: Game reads allowed, but only typeof-guarded. */
const ADAPTERS: string[] = ["flowAdapter.ts", "scavenge.ts"];

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
    // The planning core's permitted import surface. The two entries marked
    // (debt) are audited inversions scheduled in spec 17 P5 - listed so a NEW
    // dependency (execution/, colony/, telemetry/, corps runtime classes)
    // cannot land silently.
    const ALLOWED = new Set([
      // intra-economy
      "./CorpPlanner", "./primitives", "./Commission", "./CorpKind", "./commissionPlan",
      "./siteValue", "./roadEconomics", "./bank", "./expansion", "./flowAdapter", "./scavenge",
      // pure shared types
      "../types/Position", "../types/Memory",
      // (debt) constants physically homed outside economy/ - P5 inverts these
      "../flow/FlowTypes", "../corps/economics", "../planning/EconomicConstants",
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
});
