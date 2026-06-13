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
 * Currently registered: scout. The live ColonyProblem below is therefore
 * minimal (spawns only - all any auxiliary kind reads today); the full
 * problem builder arrives with the solver-backed kinds (harvest/carry/...).
 *
 * @module execution/CommissionHost
 */

import {
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
import type { CorpRegistry } from "./CorpRunner";

/** Survives ticks, dies on global reset - rehydrated from Memory then. */
let store: CorpStore | null = null;

function registerKinds(): void {
  if (!getCorpKind("scout")) {
    registerCorpKind(scoutKind as never);
  }
}

/**
 * The live world as a ColonyProblem, restricted to what registered kinds
 * read. Sources/sinks stay empty until solver-backed kinds register.
 */
function liveProblem(): ColonyProblem {
  const spawns: ColonyProblem["spawns"] = [];
  for (const name in Game.spawns) {
    const s = Game.spawns[name];
    spawns.push({ id: s.id, pos: { x: s.pos.x, y: s.pos.y, roomName: s.pos.roomName } });
  }
  return {
    spawns,
    sources: [],
    sinks: [],
    // Same-room Chebyshev; good enough for the auxiliary kinds, replaced by
    // the real path-distance provider when the solver port lands.
    dist: (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
  };
}

/**
 * Drive all registered corp kinds for one tick. Called from the main loop in
 * place of the legacy per-kind run*Corps calls as each kind ports over.
 */
export function runCommissionHost(registry: CorpRegistry, tick: number): void {
  registerKinds();
  // Fresh closure every tick: the legacy registry object can be rebuilt on
  // hydration, and kinds must always see the live spawning corps.
  setSpawningCorpResolver(spawnId => registry.spawningCorps[spawnId]);

  if (!store) {
    store = Memory.commissionedCorps ? deserializeStore(Memory.commissionedCorps) : new Map();
  }

  const problem = liveProblem();
  const commissions: Commission[] = [];
  for (const kind of listCorpKinds()) {
    commissions.push(...kind.propose(problem, commissions));
  }

  materializeCommissions(commissions, store);
  runCommissionedCorps(store, tick);

  Memory.commissionedCorps = serializeStore(store);
}

/** Tests only: drop the tick-cache so the next run rehydrates from Memory. */
export function resetCommissionHost(): void {
  store = null;
}

/**
 * The live corps of one kind, keyed by commission corpId - the legacy-map
 * shape stats/telemetry consumers already speak, so they don't care whether a
 * kind has ported yet.
 */
export function commissionedCorpsOfKind<T extends Corp>(kind: string): { [corpId: string]: T } {
  const out: { [corpId: string]: T } = {};
  if (!store) return out;
  for (const [corpId, entry] of store) {
    if (entry.kind === kind) out[corpId] = entry.corp as T;
  }
  return out;
}
