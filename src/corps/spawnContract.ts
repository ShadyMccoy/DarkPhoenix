/**
 * @fileoverview The corp spawn contract - the ONE physical spawn call site,
 * and the runtime guard that makes bypassing it an error.
 *
 * Creeps are requisitioned, never conjured: a corp declares a demand
 * (getSpawnDemand), the NOW planner ranks it (spawn/SpawnScheduler ->
 * planAcquisitions), and the director executes the single buy through
 * SpawningCorp.executeSpawn - which is where the spend ledger accrues and
 * the agenda receipt files. A naked `spawn.spawnCreep(...)` skips every one
 * of those books at once, which is why the spawn-authority ratchet
 * (test/unit/framework/spawnAuthority.test.ts) pins the static call surface.
 *
 * This module is the RUNTIME half of that cop:
 *
 * - `contractSpawn` is the one function that may physically invoke
 *   `spawnCreep`. The sanctioned buyers (SpawningCorp's executor; the
 *   pre-economy BootstrapCorp, which owns RCL 1 where no plan exists yet)
 *   call it; the static ratchet's allowlist shrinks to this file.
 * - `installSpawnContractGuard` (main.ts, module load - the same seam that
 *   registers console commands) wraps StructureSpawn.prototype so any OTHER
 *   spawnCreep call throws with directions to the contract. The deprecated
 *   `createCreep` API always throws.
 *
 * The throw lands inside a phase bulkhead in live code, so a stray caller
 * costs one logged error and a skipped spawn, never the tick. For operator
 * break-glass work (scripts/rescue-console.ts) `armSpawnContractBypass`
 * admits a counted number of naked calls - registered on the console as
 * `global.spawnContractBypass(n)`.
 *
 * SPEC 60 PHASE A - the purchase books itself at this door. contractSpawn
 * is no longer a pass-through: on OK it accrues the cumulative spend ledger
 * and files the forensic BlackBox "spawn" row itself, so a body that is not
 * on the books is impossible to buy. (BootstrapCorp used to hand-book the
 * ledger and file NO ring row, so the forensic ring and the account covered
 * different creep populations - the 2026-08 audit's population gap.) The
 * memory contract is enforced at the same door: a creep born without corpId
 * or workType is unaccountable (orphan rescue skips it, the census misses
 * it), so the seam throws before the engine is reached.
 */

import { record as blackBox } from "../telemetry/BlackBox";
import { accrueSpawnSpend } from "../telemetry/spawnLedger";
import { bodyEnergyCost } from "../economy/primitives";

/** True while contractSpawn is on the stack - the guard's pass condition. */
let inContract = false;

/** Naked calls still admitted by an operator bypass (break-glass tooling). */
let bypassRemaining = 0;

/**
 * The error a naked spawnCreep call gets - the contract, spelled out. (The
 * demand-side method is deliberately not named here: the spawn-authority
 * ratchet counts every file carrying that symbol as demand surface, and this
 * guard is not one. The docs pointer covers the full requisition path.)
 */
export const NAKED_SPAWN_MESSAGE =
  "spawn.spawnCreep called outside the corp contract. Creeps are requisitioned: " +
  "declare the spawn demand on your corp and let the scheduler buy it " +
  "(SpawnDirector -> SpawningCorp.executeSpawn -> contractSpawn); a sanctioned " +
  "direct path buys through corps/spawnContract.contractSpawn so the spend ledger " +
  "and receipts stay whole. See docs/ONTOLOGY.md §5-6. " +
  "Operator break-glass: global.spawnContractBypass(1).";

/** The error any createCreep call gets - the API is dead here either way. */
export const CREATE_CREEP_MESSAGE =
  "spawn.createCreep is retired. Creeps are requisitioned through the corp " +
  "contract (corp spawn demand -> SpawnDirector -> SpawningCorp.executeSpawn); " +
  "see docs/ONTOLOGY.md §5-6.";

/**
 * The error an unaccountable purchase gets: a creep born without corpId or
 * workType is invisible to the census, skipped by orphan rescue, and missing
 * from every per-corp book - so the contract refuses it before the engine is
 * reached (spec 60 phase A).
 */
export const MEMORY_CONTRACT_MESSAGE =
  "contractSpawn requires opts.memory.corpId and opts.memory.workType. The census, " +
  "orphan rescue and every per-corp book key off them, so a creep missing either is " +
  "unaccountable from birth. SpawningCorp.executeSpawn stamps both from the kind's " +
  "roles declaration; see docs/specs/60-measurement-at-the-door.md phase A.";

/**
 * What the caller tells the books about a purchase. The buyer corp is NOT a
 * field here - it is read from the enforced `opts.memory.corpId`, so the row's
 * `corp` and the newborn's memory can never disagree (one input, not two).
 */
export interface PurchaseContext {
  /**
   * The role bought - the spend ledger's grain (spawnLedger's role -> account
   * class join). Distinct from memory.workType, the work-dispatch stamp.
   */
  role: string;
  /**
   * Recovery-fleet purchase (methodology #10): accrues the scavenge
   * sub-counter beside the role total, so the account can price the cure.
   */
  scavenge?: boolean;
  /**
   * Caller-owned context merged into the forensic "spawn" row - the
   * SpawnDirector's agenda receipt (declared/want/grant/fill/pri/rank/why:
   * budget-vs-debit facts this seam cannot know). Opaque here; the seam's own
   * fields (spawn, role, corp, cost, parts) always win a key collision.
   */
  receipt?: Record<string, unknown>;
}

/**
 * The one sanctioned physical spawn - and, since spec 60 phase A, the one
 * place a purchase is BOOKED. On OK this seam itself accrues the cumulative
 * spend ledger (the account's capture-bounded spend side) and files the
 * BlackBox "spawn" row (the forensic ring), from the body it just bought -
 * callers stop hand-booking, so the two records cannot cover different
 * populations. A failed spawn books nothing.
 */
export function contractSpawn(
  spawn: StructureSpawn,
  body: BodyPartConstant[],
  name: string,
  opts: SpawnOptions,
  purchase: PurchaseContext
): ScreepsReturnCode {
  const memory = opts.memory as { corpId?: string; workType?: string } | undefined;
  if (!memory?.corpId || !memory?.workType) {
    throw new Error(MEMORY_CONTRACT_MESSAGE);
  }
  inContract = true;
  let result: ScreepsReturnCode;
  try {
    result = spawn.spawnCreep(body, name, opts);
  } finally {
    inContract = false;
  }
  if (result === OK) {
    const cost = bodyEnergyCost(body);
    accrueSpawnSpend(purchase.role, cost, body.length, { scavenge: purchase.scavenge });
    blackBox("spawn", {
      ...purchase.receipt,
      spawn: spawn.id,
      role: purchase.role,
      corp: memory.corpId,
      cost,
      parts: body.length
    });
  }
  return result;
}

/**
 * Admit the next `calls` naked spawnCreep invocations (default 1). Counted,
 * not timed, so a break-glass console expression can arm-and-spawn in one
 * evaluation with no Game.time dependency.
 */
export function armSpawnContractBypass(calls = 1): number {
  bypassRemaining = Math.max(0, Math.floor(calls));
  return bypassRemaining;
}

/** Structural view of the prototype the guard wraps (test-injectable). */
interface SpawnPrototypeLike {
  spawnCreep(body: BodyPartConstant[], name: string, opts?: SpawnOptions): ScreepsReturnCode;
  createCreep?(...args: unknown[]): unknown;
}

/** Prototypes already wrapped - double-install must be a no-op. */
const guardedPrototypes = new WeakSet<SpawnPrototypeLike>();

/**
 * Wrap `ctor.prototype.spawnCreep` (default: the global StructureSpawn) so a
 * call outside contractSpawn throws NAKED_SPAWN_MESSAGE, and `createCreep`
 * (when the engine still ships it) always throws CREATE_CREEP_MESSAGE.
 *
 * Installed from main.ts at module load - re-evaluated on every Screeps
 * global reset, which is exactly when the engine rebuilds the prototypes.
 * No-ops when StructureSpawn is absent (unit tests stub spawns as plain
 * objects, which never reach the prototype chain) and on double install.
 */
export function installSpawnContractGuard(ctor?: { prototype: SpawnPrototypeLike }): void {
  const target = ctor ?? (typeof StructureSpawn !== "undefined" ? StructureSpawn : undefined);
  if (!target?.prototype || guardedPrototypes.has(target.prototype)) return;
  guardedPrototypes.add(target.prototype);

  const proto = target.prototype;
  const engineSpawnCreep = proto.spawnCreep;
  proto.spawnCreep = function (
    this: StructureSpawn,
    body: BodyPartConstant[],
    name: string,
    opts?: SpawnOptions
  ): ScreepsReturnCode {
    if (!inContract) {
      if (bypassRemaining > 0) {
        bypassRemaining--;
        console.log(`[SpawnContract] bypass admitted a naked spawnCreep (${bypassRemaining} left)`);
      } else {
        console.log(`[SpawnContract] ERROR: ${NAKED_SPAWN_MESSAGE}`);
        throw new Error(NAKED_SPAWN_MESSAGE);
      }
    }
    return engineSpawnCreep.call(this, body, name, opts);
  };

  if (typeof proto.createCreep === "function") {
    proto.createCreep = function (): never {
      throw new Error(CREATE_CREEP_MESSAGE);
    };
  }
}
