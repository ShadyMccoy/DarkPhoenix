/**
 * @fileoverview CommissionHost - rung 5 of the proof ladder: the thin runtime
 * that drives commissioned corps from the live loop.
 *
 * Each tick: register kinds (idempotent), propose commissions over the live
 * world, bind them to runtime corps via the generic dispatch, run them, and
 * persist the store. As kinds port over (docs/specs/00-corp-framework.md),
 * their legacy run*Corps call in main.ts is deleted and they flow through
 * here instead - the host itself never changes.
 *
 * Registered: harvest, carry, upgrade (solver-backed - their commissions are
 * passed in from FlowEconomy.getCommissions, so their propose() returns [] and
 * they never read the live ColonyProblem) plus scout, reservation, tender
 * (auxiliary - they propose() over the minimal live problem below).
 *
 * @module execution/CommissionHost
 */

import {
  CorpKind,
  CorpStore,
  deserializeStore,
  getCorpKind,
  listCorpKinds,
  materializeCommissions,
  registerCorpKind,
  runCommissionedCorps,
  serializeStore
} from "../economy/CorpKind";
import { Commission } from "../economy/Commission";
import { ColonyProblem } from "../economy/CorpPlanner";
import { Corp } from "../corps/Corp";
import { scoutKind, setSpawningCorpResolver } from "../corps/kinds/scoutKind";
import { reservationKind } from "../corps/kinds/reservationKind";
import { raidGuardKind } from "../corps/kinds/raidGuardKind";
import { coreBusterKind } from "../corps/kinds/coreBusterKind";
import { claimKind } from "../corps/kinds/claimKind";
import { extensionTenderKind } from "../corps/kinds/extensionTenderKind";
import { controllerFeederKind } from "../corps/kinds/controllerFeederKind";
import { harvestKind } from "../corps/kinds/harvestKind";
import { carryKind } from "../corps/kinds/carryKind";
import { upgradeKind } from "../corps/kinds/upgradeKind";
import { constructionKind } from "../corps/kinds/constructionKind";
import { record as blackBox } from "../telemetry/BlackBox";
import { plan as governorPlan } from "./CpuGovernor";
import { hostileRooms } from "../utils/RoomDiscovery";
import type { CorpRegistry } from "./CorpRunner";

/** Survives ticks, dies on global reset - rehydrated from Memory then. */
let store: CorpStore | null = null;

/** Every ported kind. New ports add one line here - the host body never changes. */
const KINDS: CorpKind[] = [
  // Solver-backed (commissions come from FlowEconomy.getCommissions):
  harvestKind as CorpKind,
  carryKind as CorpKind,
  upgradeKind as CorpKind,
  // Self-proposing (auxiliary, or hybrid like construction which reads the draft):
  scoutKind as CorpKind,
  reservationKind as CorpKind,
  raidGuardKind as CorpKind,
  coreBusterKind as CorpKind,
  claimKind as CorpKind,
  extensionTenderKind as CorpKind,
  controllerFeederKind as CorpKind,
  constructionKind as CorpKind
];

function registerKinds(): void {
  for (const kind of KINDS) {
    if (!getCorpKind(kind.kind)) registerCorpKind(kind);
  }
}

/**
 * The live world as a ColonyProblem, restricted to what registered kinds
 * read: fresh spawns, plus the execution-context facts propose() triggers
 * need (spec 17 P3 - the HOST owns the impure reads; propose stays a pure
 * function of the problem). Sources/sinks stay empty (self-proposing kinds
 * read spawns + draft only); dist is same-room Chebyshev and NOT
 * cross-room-safe - kinds needing room distance use roomLinearDistance.
 */
function liveProblem(): ColonyProblem {
  const spawns: ColonyProblem["spawns"] = [];
  for (const name in Game.spawns) {
    const s = Game.spawns[name];
    spawns.push({ id: s.id, pos: { x: s.pos.x, y: s.pos.y, roomName: s.pos.roomName } });
  }
  const expansionRoom = typeof Memory !== "undefined" ? Memory.expansion?.roomName : undefined;
  return {
    spawns,
    sources: [],
    sinks: [],
    dist: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)),
    ...(expansionRoom ? { expansion: { roomName: expansionRoom } } : {}),
    freezes: { scouting: governorPlan().freezeScouting },
    hostileRooms: [...hostileRooms()]
  };
}

/**
 * Drive all registered corp kinds for one tick. Called from the main loop in
 * place of the legacy per-kind run*Corps calls as each kind ports over.
 *
 * `solverCommissions` are the central planner's output (FlowEconomy.getCommissions
 * - harvest/carry/upgrade), stable between solves. They seed the draft so
 * auxiliary kinds can react to them, and are materialized together with the
 * auxiliaries' per-tick propose() output as ONE union, so neither set
 * demobilizes the other. Commissions whose kind is not registered are skipped
 * (materializeCommissions), so passing solver commissions before harvest/carry/
 * upgrade register is a no-op.
 */
export function runCommissionHost(
  registry: CorpRegistry,
  solverCommissions: readonly Commission[],
  tick: number
): void {
  registerKinds();
  // Fresh closure every tick: the legacy registry object can be rebuilt on
  // hydration, and kinds must always see the live spawning corps.
  setSpawningCorpResolver(spawnId => registry.spawningCorps[spawnId]);

  const liveStore = ensureStore();
  const problem = liveProblem();
  // Seed the draft with the solver commissions so auxiliaries' propose() can
  // read them (e.g. "a miner works here"), then append each kind's proposals.
  const commissions: Commission[] = [...solverCommissions];
  for (const kind of listCorpKinds()) {
    commissions.push(...kind.propose(problem, commissions));
  }

  // Hysteresis: don't drop a corp whose commission vanished while it still has
  // living creeps. Keeping it (flagged retiring) lets it run those creeps to
  // their natural death/recycle instead of stranding them as orphans the instant
  // a re-solve churns the commission set; it requests no new spawns, so the
  // planner's wind-down still takes effect as the fleet drains.
  const beforeIds = new Set(liveStore.keys());
  materializeCommissions(commissions, liveStore, (_corpId, entry) => !hasLiveCreeps(entry.corp.id));
  // Flight recorder: commission churn is a top incident signal (spec 09 ph4).
  let created = 0;
  for (const id of liveStore.keys()) if (!beforeIds.has(id)) created++;
  let removed = 0;
  for (const id of beforeIds) if (!liveStore.has(id)) removed++;
  if (created > 0 || removed > 0) blackBox("churn", { created, removed });
  runCommissionedCorps(liveStore, tick, corpCpuMeter());

  publishCorpCpu(tick);
  Memory.commissionedCorps = serializeStore(liveStore);
}

// =============================================================================
// PER-CORP CPU LEDGER (spec 20) - the corp is the accounting boundary
// =============================================================================

/** This tick's raw per-corp CPU (rebuilt each host run). */
let cpuThisTick = new Map<string, { kind: string; cpu: number }>();
/** Exponential moving average per corp, surviving between ticks (heap only). */
const cpuEma = new Map<string, number>();
/** EMA smoothing: ~100-tick horizon, matching the corp variance rate window. */
const CPU_EMA_ALPHA = 0.02;
/** Rows published per tick - enough for a dashboard, small enough for Memory. */
const CPU_TOP_ROWS = 12;

/** The dispatch meter, or undefined outside a live tick (unit/pure paths). */
function corpCpuMeter(): { now(): number; record(kind: string, corpId: string, cpu: number): void } | undefined {
  if (typeof Game === "undefined" || !Game.cpu?.getUsed) return undefined;
  cpuThisTick = new Map();
  return {
    now: () => Game.cpu.getUsed(),
    record: (kind, corpId, cpu) => {
      const row = cpuThisTick.get(corpId);
      if (row) row.cpu += cpu;
      else cpuThisTick.set(corpId, { kind, cpu });
    }
  };
}

/**
 * Publish the per-corp CPU ledger (Memory.corpCpu, pullable via the telemetry
 * API like corpVariance): per-KIND totals for this tick plus the top per-corp
 * EMA rows. `corpsTotal` is the sum over every commissioned corp, so audit
 * consumers can reconcile corp-attributed CPU against the loop's whole-tick
 * budget - the same tracked-vs-total discipline as the creep census.
 */
function publishCorpCpu(tick: number): void {
  if (typeof Memory === "undefined" || cpuThisTick.size === 0) return;
  const byKind: { [kind: string]: number } = {};
  let corpsTotal = 0;
  for (const [corpId, row] of cpuThisTick) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + row.cpu;
    corpsTotal += row.cpu;
    cpuEma.set(corpId, (cpuEma.get(corpId) ?? row.cpu) * (1 - CPU_EMA_ALPHA) + row.cpu * CPU_EMA_ALPHA);
  }
  // Drop EMA rows for corps that vanished (demobilized) so the map stays bounded.
  for (const corpId of cpuEma.keys()) {
    if (!cpuThisTick.has(corpId) && !ensureStore().has(corpId)) cpuEma.delete(corpId);
  }
  const top = [...cpuThisTick.entries()]
    .map(([corpId, row]) => ({ corpId, kind: row.kind, cpu: Number(row.cpu.toFixed(3)), avg: Number((cpuEma.get(corpId) ?? row.cpu).toFixed(3)) }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, CPU_TOP_ROWS);
  const rounded: { [kind: string]: number } = {};
  for (const kind in byKind) rounded[kind] = Number(byKind[kind].toFixed(3));
  Memory.corpCpu = { tick, corpsTotal: Number(corpsTotal.toFixed(3)), byKind: rounded, top };
}

/** True if any creep (alive or still spawning) is assigned to this corp id. */
function hasLiveCreeps(corpId: string): boolean {
  for (const name in Game.creeps) {
    if (Game.creeps[name].memory.corpId === corpId) return true;
  }
  return false;
}

/**
 * Lazy rehydration after a global reset. Kinds must be registered first
 * (deserializeStore drops entries of unregistered kinds), so this also
 * registers - making the adapter below safe to call from anywhere in the
 * tick, even before the host itself has run.
 */
function ensureStore(): CorpStore {
  if (!store) {
    registerKinds();
    store = Memory.commissionedCorps ? deserializeStore(Memory.commissionedCorps) : new Map();
  }
  return store;
}

/** Tests only: drop the tick-cache so the next run rehydrates from Memory. */
export function resetCommissionHost(): void {
  store = null;
}

/**
 * Tests only: insert a live corp into the store under a kind, keyed by the
 * production corpId (e.g. `harvest-${sourceId}`), bypassing materialize. Lets
 * spawn/fleet harnesses exercise collectDemands - which reads the store - with
 * hand-built corps, the way they used to seed the registry.
 */
export function seedCommissionStoreForTest(corpId: string, kind: string, corp: Corp): void {
  ensureStore().set(corpId, { kind, corp, commission: { corpId, kind } as Commission });
}

/**
 * The live corps of one kind, keyed by commission corpId - the legacy-map
 * shape stats/telemetry consumers already speak, so they don't care whether a
 * kind has ported yet.
 */
export function commissionedCorpsOfKind<T extends Corp>(kind: string): { [corpId: string]: T } {
  const out: { [corpId: string]: T } = {};
  for (const [corpId, entry] of ensureStore()) {
    if (entry.kind === kind) out[corpId] = entry.corp as T;
  }
  return out;
}

/** One entry in the complete corp census. */
export interface CorpCensusEntry {
  corpId: string;
  kind: string;
  corp: Corp;
  /** The commission's declared shape (absent for the legacy registry kinds). */
  commissionShape?: Commission["shape"];
}

/**
 * Every corp in the commission store, of every kind, with its kind label - the
 * store half of the census. Prefer {@link completeCensus} for consumers that
 * must see EVERY corp: it folds in the two legacy-registry kinds (bootstrap,
 * spawning) exactly once, so no caller maintains its own append.
 */
export function allCommissionedCorps(): CorpCensusEntry[] {
  const out: CorpCensusEntry[] = [];
  for (const [corpId, entry] of ensureStore()) {
    out.push({ corpId, kind: entry.kind, corp: entry.corp, commissionShape: entry.commission.shape });
  }
  return out;
}

/**
 * The COMPLETE corp census: the commission store plus the two legacy-registry
 * kinds that predate the framework (bootstrap - the cold-start fallback, and
 * spawning - infrastructure). This is the ONLY place their kind labels are
 * hand-written; every census consumer (telemetry, variance, stats, orphan
 * rescue, console) iterates this instead of remembering the append. When those
 * two finally port to the framework, this collapses into allCommissionedCorps.
 */
export function completeCensus(registry: CorpRegistry): CorpCensusEntry[] {
  const out = allCommissionedCorps();
  for (const room in registry.bootstrapCorps) {
    out.push({ corpId: registry.bootstrapCorps[room].id, kind: "bootstrap", corp: registry.bootstrapCorps[room] });
  }
  for (const spawnId in registry.spawningCorps) {
    out.push({ corpId: registry.spawningCorps[spawnId].id, kind: "spawning", corp: registry.spawningCorps[spawnId] });
  }
  return out;
}
