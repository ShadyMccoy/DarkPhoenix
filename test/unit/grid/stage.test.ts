/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * THE STAGING VOCABULARY + ITS COP (spec 61 rows 5-6 - doctrine at the door).
 *
 * The CLAUDE.md "Grid staging" trap list encoded three mockup-db incidents as
 * prose a future developer must remember under pressure. These tests are the
 * doors that make remembering unnecessary:
 *
 *  - the mockup db's $set with dotted paths ("store.energy") SILENTLY NO-OPS -
 *    cells staged against state that never landed have false-redded before.
 *    `dbPatch` throws on a dotted key; the source cop below refuses raw $set
 *    payloads carrying one anywhere under test/grid/.
 *  - addBot's `gcl` is POINTS, not level (1e6 points = GCL 2) - `gclPoints`
 *    makes the unit mismatch unwritable.
 *  - staged storage needs the OWNED schema (user + flat storeCapacity) -
 *    a partially-schema'd storage stages fine and breaks pricing invisibly.
 *    `stagedStorage` emits the schema complete.
 *  - an ARMED CpuGovernor (Memory.cpuGovernor = "on") couples a cell's verdict
 *    to HOST load - one full grid run drained heavy worlds' buckets and failed
 *    six baseline-green cells. The harness refuses it at staging unless the
 *    cell declares `expectsGovernor: true` (a governor test saying so on
 *    purpose).
 */

import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import { armedGovernorError, assertWholeObjectPatch, dbPatch, gclPoints, stagedStorage } from "../../grid/stage";
import { GridCell } from "../../grid/GridCell";

const GRID = path.join(__dirname, "..", "..", "grid");

/** The engine's own points -> level read (screeps GCL_POW 2.4, GCL_MULTIPLY 1e6). */
const engineLevelOf = (points: number): number => Math.floor(Math.pow(points / 1_000_000, 1 / 2.4)) + 1;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every .ts file under test/grid/, repo-relative with forward slashes. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Quoted string keys containing a dot ("store.energy":) inside a payload slice. */
function dottedKeys(payload: string): string[] {
  const out: string[] = [];
  const re = /["']([^"'\n]*\.[^"'\n]*)["']\s*:/g;
  for (let m = re.exec(payload); m; m = re.exec(payload)) out.push(m[1]);
  return out;
}

/**
 * Extract every $set payload (balanced-brace slice) from a source. Quote-aware
 * enough for staging code: skips over string literals so braces inside them
 * cannot desync the depth count.
 */
function setPayloads(src: string): string[] {
  const out: string[] = [];
  const re = /["']?\$set["']?\s*:\s*\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '"' || ch === "'" || ch === "`") {
        const quote = ch;
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === "\\") i++;
          i++;
        }
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(open, i + 1));
  }
  return out;
}

describe("grid staging vocabulary (spec 61 row 5 - the mockup-db traps become doors)", () => {
  describe("gclPoints - addBot's gcl is POINTS, not level", () => {
    it("emits the minimal points for each level, by the engine's own curve", () => {
      for (let level = 1; level <= 8; level++) {
        expect(engineLevelOf(gclPoints(level)), `level ${level}`).to.equal(level);
        if (level >= 2) {
          expect(engineLevelOf(gclPoints(level) - 1), `minimality at level ${level}`).to.equal(level - 1);
        }
      }
    });

    it("pins the trap-list number: GCL 2 = 1e6 points", () => {
      expect(gclPoints(2)).to.equal(1_000_000);
      expect(gclPoints(1)).to.equal(0);
    });

    it("refuses a non-level argument (points passed where a level belongs)", () => {
      expect(() => gclPoints(0)).to.throw(/positive integer/);
      expect(() => gclPoints(2.5)).to.throw(/positive integer/);
    });
  });

  describe("dbPatch - the one sanctioned staged-db update", () => {
    const fakeDb = (calls: any[][]) => ({
      "rooms.objects": { update: async (...args: any[]) => void calls.push(args) },
      users: { update: async (...args: any[]) => void calls.push(args) }
    });

    it("throws on a dotted top-level key BEFORE touching the db (the silent no-op trap)", async () => {
      const calls: any[][] = [];
      let thrown: Error | undefined;
      try {
        await dbPatch(fakeDb(calls), { room: "W1N1", type: "spawn" }, { "store.energy": 300 });
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown, "dotted path must throw").to.not.equal(undefined);
      expect(String(thrown)).to.match(/dotted path/);
      expect(String(thrown)).to.match(/whole object/);
      expect(calls, "nothing may reach the db").to.deep.equal([]);
    });

    it("passes a whole-object patch through as $set, query object or _id string", async () => {
      const calls: any[][] = [];
      const db = fakeDb(calls);
      await dbPatch(db, { room: "W1N1", type: "spawn" }, { store: { energy: 300 } });
      await dbPatch(db, "someId", { hits: 0 });
      await dbPatch(db, "u1", { active: 0 }, "users");
      expect(calls).to.deep.equal([
        [{ room: "W1N1", type: "spawn" }, { $set: { store: { energy: 300 } } }],
        [{ _id: "someId" }, { $set: { hits: 0 } }],
        [{ _id: "u1" }, { $set: { active: 0 } }]
      ]);
    });

    it("nested keys are literal keys, not mongo paths - only the top level is refused", () => {
      expect(() => assertWholeObjectPatch({ store: { energy: 1 } })).to.not.throw();
      expect(() => assertWholeObjectPatch({ "store.energy": 1 })).to.throw(/dotted/);
    });
  });

  describe("stagedStorage - the OWNED schema, complete", () => {
    it("emits user + flat storeCapacity + full hits (the schema pricing paths read)", () => {
      const doc = stagedStorage("W1N1", 120_000, "bot-1");
      expect(doc.type).to.equal("storage");
      expect(doc.room).to.equal("W1N1");
      expect(doc.user, "storage must be OWNED - the neutral schema broke link-haul pricing").to.equal("bot-1");
      expect(doc.store).to.deep.equal({ energy: 120_000 });
      expect(doc.storeCapacity, "flat storeCapacity - the engine's transfer paths read the scalar").to.be.greaterThan(
        0
      );
      expect(doc.hits, "0/absent hits reads as destroyed and the engine purges the object").to.be.greaterThan(0);
      expect(doc.hitsMax).to.equal(doc.hits);
    });
  });

  describe("the dotted-$set source cop - raw payloads under test/grid/ stay whole-object", () => {
    it("no $set payload in any grid source carries a dotted string key", () => {
      const offenders: string[] = [];
      for (const f of walk(GRID)) {
        const src = stripComments(fs.readFileSync(f, "utf8"));
        for (const payload of setPayloads(src)) {
          for (const key of dottedKeys(payload)) {
            offenders.push(`${path.relative(GRID, f)}: "${key}"`);
          }
        }
      }
      expect(
        offenders,
        'a $set payload carries a dotted key - the mockup db SILENTLY NO-OPS dotted paths ("store.energy" ' +
          "updates nothing, no error), staging state that never lands. Write whole objects " +
          "({ store: { energy: N } }) or use stage.dbPatch, which refuses the mistake at runtime"
      ).to.deep.equal([]);
    });

    it("the cop's extractor actually sees payloads (self-test against a synthetic offender)", () => {
      const offender = 'await db["rooms.objects"].update({ x: 1 }, { $set: { "store.energy": 300 } });';
      const payloads = setPayloads(offender);
      expect(payloads.length).to.equal(1);
      expect(dottedKeys(payloads[0])).to.deep.equal(["store.energy"]);
      // and a clean whole-object payload passes, including collection-index
      // strings ("rooms.objects") which are lookups, not keys
      const clean = 'await db["rooms.objects"].update({ x: 1 }, { $set: { store: { energy: 300 } } });';
      expect(dottedKeys(setPayloads(clean)[0])).to.deep.equal([]);
    });
  });
});

describe("armed-governor harness refusal (spec 61 row 6)", () => {
  const cell = (over: Partial<GridCell>): GridCell =>
    ({
      id: "synthetic-cell",
      tier: 1,
      avenue: "synthetic",
      window: 10,
      rooms: {},
      bot: { x: 25, y: 25 },
      assertions: [],
      ...over
    } as unknown as GridCell);

  it("refuses a cell staging Memory.cpuGovernor = 'on' without expectsGovernor", () => {
    const err = armedGovernorError(cell({ memory: { cpuGovernor: "on" } }));
    expect(err, "an armed governor couples the verdict to host load - must be refused").to.be.a("string");
    expect(err).to.match(/expectsGovernor/);
    expect(err).to.match(/HOST load/);
  });

  it("a governor test that SAYS so is allowed through", () => {
    expect(armedGovernorError(cell({ memory: { cpuGovernor: "on" }, expectsGovernor: true }))).to.equal(null);
  });

  it("unarmed cells pass untouched (absent memory, absent key, dry-run value)", () => {
    expect(armedGovernorError(cell({}))).to.equal(null);
    expect(armedGovernorError(cell({ memory: {} }))).to.equal(null);
    expect(armedGovernorError(cell({ memory: { cpuGovernor: "dry" } }))).to.equal(null);
  });
});
