import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";

/**
 * THE OUTSIDE-THE-FRAMEWORK SURFACE, PINNED SHRINK-ONLY (spec 60 phase C -
 * the cop lands first, spec 39's sequencing).
 *
 * What runs OUTSIDE the CommissionHost is invisible to per-corp measurement:
 * no commission envelope, no dispatch-metered CPU (`Memory.corpCpu`), no
 * conformance enrollment, no statement row. Today that surface is exactly
 * two legacy-registry actors (bootstrap, spawning) and the named bulkhead
 * buckets in main.ts (spec 20 P2 gave them names so the CPU residual could
 * be decomposed - names are visibility, not absolution). Spec 20 phase 3
 * schedules the migration; until it completes, NOTHING may join this
 * surface: new infrastructure integrates as a corp kind (one kind file + one
 * KINDS entry, spec 17), where measurement is automatic - never as a new
 * hand-wired actor or bucket the census, the statement and the CPU ledger
 * would silently under-count.
 *
 * Both pins are SHRINK-ONLY in the purity-ratchet idiom: growth fails with
 * directions, and a migrated entry still listed fails until the pin follows
 * - so the lists can only march toward empty, at which point this suite
 * becomes a permanent invariant.
 */

const MAIN_TS = path.join(__dirname, "..", "..", "..", "src", "main.ts");

/**
 * The named bulkhead buckets of main.ts, pinned 2026-08-11 at 19. A new name
 * is a new infrastructure actor outside the corp framework - the CPU it burns
 * would be a named-but-corpless bucket forever. Migration slices (spec 20
 * phase 3: towers and links first - already intent-only runners with clean
 * seams) DELETE their bucket here as the kind's dispatch metering takes over.
 */
const BULKHEAD_BUCKETS = new Set([
  "analysis",
  "bootstrap",
  "commissions",
  "corp-variance",
  "fiscal-month",
  "flight-recorder",
  "links",
  "market-sample",
  "orphans",
  "persist",
  "planning",
  "resource-refresh",
  "road-tracker",
  "spawn-scheduling",
  "spawning-corps",
  "telemetry",
  "terminals",
  "towers",
  "visuals"
]);

/**
 * The legacy corp registry's roster (execution/CorpRunner.CorpRegistry):
 * the two pre-framework actors that run outside the commission store. They
 * close the migration program (spec 35 phase F overlap); nothing joins them.
 */
const LEGACY_REGISTRY_ROSTER = ["bootstrapCorps", "spawningCorps"];

describe("the legacy boundary is pinned shrink-only (spec 60 phase C - the cop lands first)", () => {
  it("main.ts bulkhead buckets: no new bucket may appear", () => {
    const src = fs.readFileSync(MAIN_TS, "utf8");
    const found = new Set<string>();
    const re = /bulkhead\("([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) found.add(m[1]);

    const grown = [...found].filter(b => !BULKHEAD_BUCKETS.has(b));
    expect(
      grown,
      "a NEW bulkhead bucket appeared - new infrastructure integrates as a corp kind " +
        "(spec 20 phase 3), not a new bucket; the dispatch meters kind CPU automatically " +
        "(docs/specs/60-measurement-at-the-door.md phase C)"
    ).to.deep.equal([]);

    const shrunk = [...BULKHEAD_BUCKETS].filter(b => !found.has(b));
    expect(
      shrunk,
      "these buckets left main.ts (migrated to kinds?) - remove them from BULKHEAD_BUCKETS so the ratchet holds"
    ).to.deep.equal([]);
  });

  it("the legacy corp registry roster: bootstrap + spawning, and nothing may join", () => {
    expect(
      Object.keys(createCorpRegistry()).sort(),
      "a NEW legacy-registry actor appeared - new corps integrate through the kind registry " +
        "(one kind file + one KINDS entry, spec 17); the legacy roster only shrinks " +
        "(docs/specs/60-measurement-at-the-door.md phase C)"
    ).to.deep.equal([...LEGACY_REGISTRY_ROSTER].sort());
  });
});
