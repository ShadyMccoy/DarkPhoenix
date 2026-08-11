import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";

/**
 * SPAWN-AUTHORITY RATCHET (spec 39 phase 0 - "the plan owns the fleet").
 *
 * The migration's code cop, landed FIRST, before any behavioural change
 * (the spec's own sequencing: "the cop is cheap and can land first - it
 * pins the current surface so the number can only go down"). Same shape as
 * the purity ratchet (test/unit/economy/purity.test.ts):
 *
 *   1. `.spawnCreep(` call sites may exist ONLY in the allowlist - the
 *      sanctioned executor (SpawningCorp) and the named cold-start
 *      exception (BootstrapCorp). A third site is a new spawn authority
 *      nobody reviewed.
 *   2. `getSpawnDemand` may appear only in files on the DEBT list below.
 *      The list may only SHRINK: a file added fails ("a new corp took on
 *      demand-side spawning - integrate through the plan instead"), and a
 *      paid-off file still listed fails ("remove it so the ratchet holds").
 *      When spec 39 phases 4-5 complete, the debt list collapses and this
 *      suite becomes a permanent invariant.
 *
 * The DEBT list is a pin of TODAY's surface (2026-08-03, 21 files), not an
 * endorsement: every entry is scheduled to migrate off getSpawnDemand
 * corp-by-corp in phase 4. See the spec's migration table.
 */

const SRC = path.join(__dirname, "..", "..", "..", "src");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every .ts file under src/, repo-relative with forward slashes. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const rel = (p: string): string => path.relative(SRC, p).split(path.sep).join("/");

/**
 * The sanctioned spawn intent sites (spec 39 cop rule 1). Since the spawn
 * contract landed, the ONE physical `.spawnCreep(` site is contractSpawn
 * (corps/spawnContract.ts) - SpawningCorp's executor and BootstrapCorp's
 * cold-start path both buy through it, and the runtime guard it installs
 * makes any other call site throw. This list is the static half of that
 * enforcement; it may only shrink.
 */
const SPAWN_CREEP_ALLOWLIST = new Set(["corps/spawnContract.ts"]);

/**
 * The getSpawnDemand DEBT list (spec 39 cop rule 2) - today's CODE surface,
 * pinned 2026-08-03 at 11 files: the ten demand-side corp classes plus the
 * scheduler-facing SpawnDirector. (The spec's "16 files" count included
 * docstring-only mentions - the cop strips comments, so prose references in
 * Corp.ts, the kinds, main.ts and the schedulers do not carry debt.) SHRINK
 * ONLY.
 */
const GET_SPAWN_DEMAND_DEBT = new Set([
  "corps/CarryCorp.ts",
  "corps/ClaimCorp.ts",
  "corps/ConstructionCorp.ts",
  "corps/LinkCorp.ts",
  "corps/CoreBusterCorp.ts",
  "corps/ExtensionTenderCorp.ts",
  "corps/HarvestCorp.ts",
  "corps/RaidGuardCorp.ts",
  "corps/ReservationCorp.ts",
  "corps/UpgradingCorp.ts",
  "execution/SpawnDirector.ts"
]);

/**
 * THE PURCHASE BOOKS ITSELF AT THE DOOR (spec 60 phase A). The spend ledger
 * accrues and the forensic BlackBox "spawn" row is filed INSIDE contractSpawn,
 * so a caller that hand-books either re-creates the population gap this
 * closed: BootstrapCorp used to feed the ledger by hand and file no ring row,
 * so the forensic ring and the account covered different creep populations.
 * `accrueSpawnSpend(` may appear only at its definition and at the door;
 * `"spawn"` rows may be authored only by the door. Both lists SHRINK ONLY.
 */
const ACCRUE_SPAWN_SPEND_ALLOWLIST = new Set([
  "telemetry/spawnLedger.ts", // the definition
  "corps/spawnContract.ts" // the one accrual site - the contract door
]);
const SPAWN_ROW_AUTHOR_ALLOWLIST = new Set(["corps/spawnContract.ts"]);

describe("spawn-authority ratchet (spec 39 phase 0 - the cop lands first)", () => {
  const files = walk(SRC);

  it("`.spawnCreep(` call sites exist ONLY in the sanctioned executor + bootstrap exception", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/\.spawnCreep\(/.test(stripComments(fs.readFileSync(f, "utf8")))) continue;
      if (!SPAWN_CREEP_ALLOWLIST.has(rel(f))) offenders.push(rel(f));
    }
    expect(offenders, "a NEW spawn authority appeared - route it through SpawningCorp (spec 39)").to.deep.equal([]);
  });

  it("the allowlisted spawn sites actually exist (a rename must update the cop)", () => {
    for (const f of SPAWN_CREEP_ALLOWLIST) {
      expect(fs.existsSync(path.join(SRC, f)), `${f} missing - update SPAWN_CREEP_ALLOWLIST`).to.equal(true);
    }
  });

  it("getSpawnDemand appears only on the debt list - the surface may only SHRINK", () => {
    const grown: string[] = [];
    for (const f of files) {
      if (!/getSpawnDemand/.test(stripComments(fs.readFileSync(f, "utf8")))) continue;
      if (!GET_SPAWN_DEMAND_DEBT.has(rel(f))) grown.push(rel(f));
    }
    expect(
      grown,
      "a file JOINED the getSpawnDemand surface - new corps integrate through the plan (spec 39), never a new demand site"
    ).to.deep.equal([]);
  });

  it("every debt entry still carries the debt - a paid-off file must leave the list", () => {
    const paidOff: string[] = [];
    for (const f of GET_SPAWN_DEMAND_DEBT) {
      const p = path.join(SRC, f);
      if (!fs.existsSync(p) || !/getSpawnDemand/.test(stripComments(fs.readFileSync(p, "utf8")))) paidOff.push(f);
    }
    expect(
      paidOff,
      "these files no longer reference getSpawnDemand - remove them from GET_SPAWN_DEMAND_DEBT so the ratchet holds"
    ).to.deep.equal([]);
  });

  it("accrueSpawnSpend is called ONLY at the contract door - the purchase books itself (spec 60 A)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/accrueSpawnSpend\(/.test(stripComments(fs.readFileSync(f, "utf8")))) continue;
      if (!ACCRUE_SPAWN_SPEND_ALLOWLIST.has(rel(f))) offenders.push(rel(f));
    }
    expect(
      offenders,
      "a file hand-books the spawn ledger - the purchase books itself inside contractSpawn (spec 60 phase A); " +
        "passing a PurchaseContext is the whole contract"
    ).to.deep.equal([]);
  });

  it('forensic "spawn" rows are authored ONLY by the contract door (one row per purchase)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      if (!/(?:blackBox|record)\("spawn"/.test(src)) continue;
      if (!SPAWN_ROW_AUTHOR_ALLOWLIST.has(rel(f))) offenders.push(rel(f));
    }
    expect(
      offenders,
      'a file files its own BlackBox "spawn" row - the contract door files the one row per purchase ' +
        "(spec 60 phase A); pass director-side context through PurchaseContext.receipt instead"
    ).to.deep.equal([]);
  });

  it("the booking allowlists point at files that exist (a rename must update the cop)", () => {
    for (const f of [...ACCRUE_SPAWN_SPEND_ALLOWLIST, ...SPAWN_ROW_AUTHOR_ALLOWLIST]) {
      expect(fs.existsSync(path.join(SRC, f)), `${f} missing - update the spec-60 booking allowlists`).to.equal(true);
    }
  });
});
