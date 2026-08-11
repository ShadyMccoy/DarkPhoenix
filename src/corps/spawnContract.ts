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
 */

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
 * The one sanctioned physical spawn. Callers own the WHAT (body, name, opts -
 * including the ledger/receipt bookkeeping that must follow an OK); this seam
 * only proves to the guard that the call came through the contract.
 */
export function contractSpawn(
  spawn: StructureSpawn,
  body: BodyPartConstant[],
  name: string,
  opts?: SpawnOptions
): ScreepsReturnCode {
  inContract = true;
  try {
    return spawn.spawnCreep(body, name, opts);
  } finally {
    inContract = false;
  }
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
