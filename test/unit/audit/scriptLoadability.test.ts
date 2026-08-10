/**
 * THE AUDIT SCRIPTS MUST LOAD UNDER PLAIN NODE.
 *
 * `scripts/waste-ledger.ts` and its siblings run in ts-node with NO Screeps
 * globals. Several modules under `src/corps/` evaluate body literals at import
 * time - `CorpConstants` opens with `JACK_BODY = [WORK, CARRY, MOVE]` - so
 * pulling one into a module the scripts import crashes the tool at load with
 * `ReferenceError: WORK is not defined`, before it prints a single line.
 *
 * This is invisible to the rest of the suite: mocha installs the game globals
 * (test/unit/mock), so `wasteLedger.test.ts` imports the very same graph and
 * passes. It cost a shipped commit - spec 51 phase 2 moved the armed-room lens
 * into `utils/raidMeter` and imported `MAX_SCOUT_DISTANCE` from CorpConstants,
 * breaking `npm run audit:ledger` while every test stayed green.
 *
 * Checked by ACTUALLY LOADING each entry in a child process, not by a
 * source-text rule: "reaches src/corps/" is the wrong invariant (most of those
 * modules only touch `Game` inside functions, which loads fine), and a
 * require-cache check cannot work once mocha has loaded everything. ~2s per
 * script, which buys a class of failure the whole rest of the suite is blind to.
 */
import { expect } from "chai";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.join(__dirname, "..", "..", "..");

/** Entries `npm run audit:*` / `fiscal:*` invoke - the ones that must load. */
const ENTRIES = ["waste-ledger.ts", "fiscal-archive.ts", "audit-report.ts", "corp-budget.ts"];

describe("the audit scripts load without Screeps globals", () => {
  const present = ENTRIES.filter(s => fs.existsSync(path.join(ROOT, "scripts", s)));

  it("still has entries to check (the fixture must not rot away)", () => {
    expect(present, "no audit entry scripts found - has scripts/ been reorganized?").to.not.be.empty;
  });

  for (const script of present) {
    it(`scripts/${script} imports cleanly in a bare node process`, function () {
      this.timeout(60_000); // ts-node cold start
      let stderr = "";
      try {
        execFileSync(
          process.execPath,
          [path.join(ROOT, "node_modules", ".bin", "ts-node"), "-P", "tsconfig.test.json", "-e", `require("./scripts/${script}")`],
          { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" }
        );
      } catch (e) {
        stderr = String((e as { stderr?: string }).stderr ?? e);
      }
      // Only LOAD failures count. A script that loads and then complains about
      // missing arguments has done its job here.
      expect(stderr, `module-scope crash loading scripts/${script}:\n${stderr}`).to.not.match(
        /ReferenceError|Cannot find module/
      );
    });
  }
});
