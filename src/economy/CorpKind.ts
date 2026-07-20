/**
 * @fileoverview CorpKind - the pluggable corp unit, and the generic dispatch
 * that replaces per-type plumbing.
 *
 * A corp kind declares the five things the colony needs to use it:
 * propose (PLAN), materialize (BIND), run (EXECUTE), serialize/deserialize
 * (PERSIST), and body (SPAWN). Register a kind and it participates in the
 * whole lifecycle; nothing else in the codebase learns its name. This is the
 * seam that makes corps interchangeable - see docs/specs/00-corp-framework.md.
 *
 * The dispatch here operates on a plain CorpStore and is Game-free, so every
 * piece is provable in isolation (the spec's proof ladder, rungs 1-4) before
 * it ever touches the live loop.
 *
 * @module economy/CorpKind
 */

import { Corp, SerializedCorp } from "../corps/Corp";
import { Commission } from "./Commission";
import { ColonyProblem } from "./CorpPlanner";

// =============================================================================
// THE KIND CONTRACT
// =============================================================================

/**
 * One spawnable role of a kind: how the executor stamps its creeps and how
 * orphan rescue treats them. Declaring roles HERE (instead of the historical
 * SpawningCorp workTypeMap + OrphanRescue ROLE_KIND mirrors) is what lets a
 * new kind's creeps spawn, get counted, and be re-adopted by registration
 * alone - see docs/specs/17-ontology-layers.md.
 */
export interface RoleSpec {
  /** The CreepMemory.workType this role's creeps carry. */
  workType: string;
  /**
   * Whether an orphaned creep of this role may be re-adopted into a same-room
   * corp of this kind (the default rescue rule). Default true. Set false when
   * ANOTHER kind owns the workType's rescue (e.g. construction's tankers are
   * rescued by the tender kind, preserving the pre-spec-17 ROLE_KIND mapping).
   */
  readopt?: boolean;
}

/**
 * Body-shape hints forwarded from a SpawnDemand to the kind's body builder.
 * Opaque to the scheduler; the kind interprets what it declared.
 */
export interface BodyHints {
  /** Hauler CARRY:MOVE ratio (transport roles). Same union as HaulerRatio. */
  haulerRatio?: "2:1" | "1:1" | "1:2";
  /** Free-form strategy (e.g. miner "linkFed", upgrader "containerFed"). */
  bodyStrategy?: string;
}

/**
 * The few cross-kind execution facts a kind's demand policy may read. Built by
 * the director from the commission store each tick - execution-layer state is
 * an INPUT to the pure policy, never something the policy digs out of Game.
 */
export interface DemandWorld {
  /** True if the given REAL game source id has a producer creep in the field. */
  isSourceMined(gameSourceId: string): boolean;
}

export interface CorpKind<C extends Corp = Corp> {
  /** Unique kind name; commission.kind values reference this. */
  kind: string;
  /**
   * The spawnable roles of this kind's creeps, keyed by SpawnDemand.role.
   * Drives the executor's workType stamp, body dispatch, and orphan
   * re-adoption. A kind that spawns nothing declares {}.
   */
  roles: { [role: string]: RoleSpec };
  /**
   * Execution order across kinds (lower runs earlier). Convention:
   * 0 spawning/infrastructure, 10 produce, 20 transport, 30 consume,
   * 40 auxiliary.
   */
  runOrder: number;
  /**
   * PLAN (pure): propose commissions this kind can fulfil in this world.
   * Central shapes (produce/transport/consume) normally return [] - the
   * solver emits them - while auxiliary kinds implement their trigger here
   * (e.g. reserver: "the draft plan MINES an unowned, controllered room"),
   * reading the draft commissions for preconditions instead of inventing a
   * private side-channel. The draft is the DURABLE signal: never trigger on
   * live creep positions or room vision, which flap on every creep death
   * (the stranded-reserver incident - see corps/kinds/reservationKind).
   */
  propose(problem: ColonyProblem, draft: readonly Commission[]): Commission[];
  /** BIND: create the runtime corp for a commission, or update the existing one. */
  materialize(commission: Commission, existing: C | undefined): C;
  /** EXECUTE one tick. Keep it dumb - the assignment has everything it needs. */
  run(corp: C, tick: number): void;
  /** PERSIST: kind-aware (de)serialization (Corp.serialize is the base shape). */
  serializeCorp(corp: C): SerializedCorp;
  deserializeCorp(data: SerializedCorp, commission: Commission | undefined): C;
  /**
   * SPAWN: build a body for one of this kind's roles within an energy budget.
   * THE live body path (SpawningCorp dispatches here); the equivalence pin in
   * test/unit/framework/bodyEquivalence.test.ts froze each kind against the
   * pre-spec-17 role switch it replaced.
   */
  body(role: string, bodyParam: number | undefined, energyBudget: number, hints?: BodyHints): BodyPartConstant[];
  /**
   * DEMAND policy (pure): decorate this kind's spawn demands with funding-group
   * semantics - which income UNIT they belong to (groupId) and whether that
   * unit is already underway (started). Absent or null = pass through: the
   * corp's own getSpawnDemand already said everything. `corpId` is the
   * commission id (the store key); `world` carries the cross-kind facts the
   * director assembled. See spec 17 and the pins in
   * test/unit/execution/collectDemandsPolicy.test.ts.
   */
  demandGroup?(corp: C, corpId: string, world: DemandWorld): { groupId: string; started: boolean } | null;
  /**
   * PRODUCER declaration: the REAL game source id this corp produces at, if
   * any. Feeds DemandWorld.isSourceMined - a transport kind's "my source has a
   * miner" check works for ANY registered producer kind, not just harvest.
   */
  sourceOf?(corp: C): string | null;
  /**
   * ORPHAN re-adoption override: return the id of one of this kind's corps
   * that legitimately owns this creep's work, or null for "none - recycle".
   * Absent = the default rule (any same-room corp of this kind whose declared
   * role matches the creep's workType, roles[].readopt permitting).
   */
  claimsOrphan?(creep: Creep, corps: { [corpId: string]: C }): string | null;
}

// =============================================================================
// REGISTRY
// =============================================================================

const registry = new Map<string, CorpKind>();

/** Register a corp kind. Throws on duplicate registration (a wiring bug). */
export function registerCorpKind(kind: CorpKind): void {
  if (registry.has(kind.kind)) {
    throw new Error(`CorpKind "${kind.kind}" is already registered`);
  }
  registry.set(kind.kind, kind);
}

export function getCorpKind(name: string): CorpKind | undefined {
  return registry.get(name);
}

/** All registered kinds in execution order (runOrder, then kind name). */
export function listCorpKinds(): CorpKind[] {
  return [...registry.values()].sort((a, b) => a.runOrder - b.runOrder || (a.kind < b.kind ? -1 : 1));
}

/** Tests only: clear the registry between cases. */
export function resetCorpKinds(): void {
  registry.clear();
}

// =============================================================================
// GENERIC DISPATCH (the plumbing per-type code dissolves into)
// =============================================================================

/** A live commissioned corp: the runtime instance plus its current commission. */
export interface CommissionedCorp {
  kind: string;
  corp: Corp;
  commission: Commission;
}

/** The generic corp store keyed by commission corpId. */
export type CorpStore = Map<string, CommissionedCorp>;

export interface MaterializeResult {
  created: number;
  updated: number;
  /** Corps whose commission vanished this round (demobilized and dropped). */
  removed: number;
  /**
   * Corps whose commission vanished but which were KEPT (flagged retiring)
   * because canDemobilize said no - typically because they still have living
   * creeps to run out. They drop on the round canDemobilize finally allows it.
   */
  retained: number;
  /** Commissions whose kind has no registration (left for legacy plumbing). */
  skipped: number;
}

/**
 * Whether a corp whose commission vanished may be dropped NOW. Returning false
 * keeps the corp in the store (flagged retiring) for another round - the seam the
 * live host uses to hold a corp alive while it still has living creeps, so a brief
 * commission gap around a re-solve never strands a fleet. Pure default: always
 * drop (the original behaviour), so callers and tests that don't care are
 * unaffected.
 */
export type DemobilizePredicate = (corpId: string, entry: CommissionedCorp) => boolean;

/**
 * Bind a round of commissions to runtime corps: create the missing, update the
 * existing, and demobilize store entries (of REGISTERED kinds) that no longer
 * have a commission AND that `canDemobilize` permits dropping. A vanished corp
 * `canDemobilize` declines to drop is KEPT and flagged `retiring` (it runs its
 * remaining creeps but requests no new spawns) - the hysteresis that stops a
 * one-solve commission flicker from deleting a corp out from under its live
 * creeps. Commissions for unregistered kinds are skipped untouched, which is what
 * lets the legacy per-type plumbing coexist during the strangler migration - each
 * kind moves over the round its registration lands.
 */
export function materializeCommissions(
  commissions: readonly Commission[],
  store: CorpStore,
  canDemobilize: DemobilizePredicate = () => true
): MaterializeResult {
  const result: MaterializeResult = { created: 0, updated: 0, removed: 0, retained: 0, skipped: 0 };
  const seen = new Set<string>();

  for (const c of commissions) {
    const kind = registry.get(c.kind);
    if (!kind) {
      result.skipped += 1;
      continue;
    }
    seen.add(c.corpId);
    const existing = store.get(c.corpId);
    const corp = kind.materialize(c, existing?.corp);
    corp.retiring = false; // freshly commissioned: not winding down
    store.set(c.corpId, { kind: c.kind, corp, commission: c });
    if (existing) result.updated += 1;
    else result.created += 1;
  }

  for (const [corpId, entry] of store) {
    if (seen.has(corpId) || !registry.has(entry.kind)) continue;
    if (canDemobilize(corpId, entry)) {
      store.delete(corpId);
      result.removed += 1;
    } else {
      entry.corp.retiring = true; // keep running its creeps, but spawn no more
      result.retained += 1;
    }
  }

  return result;
}

/** Run every commissioned corp, kinds in execution order, stable within a kind. */
export function runCommissionedCorps(store: CorpStore, tick: number): void {
  for (const kind of listCorpKinds()) {
    for (const [, entry] of store) {
      if (entry.kind !== kind.kind) continue;
      kind.run(entry.corp, tick);
    }
  }
}

// =============================================================================
// PERSISTENCE (round-trips the whole store through Memory-shaped data)
// =============================================================================

export interface SerializedCommissionedCorp {
  kind: string;
  commission: Commission;
  corp: SerializedCorp;
}

export type SerializedCorpStore = Record<string, SerializedCommissionedCorp>;

export function serializeStore(store: CorpStore): SerializedCorpStore {
  const out: SerializedCorpStore = {};
  for (const [corpId, entry] of store) {
    const kind = registry.get(entry.kind);
    if (!kind) continue;
    out[corpId] = { kind: entry.kind, commission: entry.commission, corp: kind.serializeCorp(entry.corp) };
  }
  return out;
}

export function deserializeStore(data: SerializedCorpStore): CorpStore {
  const store: CorpStore = new Map();
  for (const corpId in data) {
    const entry = data[corpId];
    const kind = registry.get(entry.kind);
    if (!kind) continue; // a kind removed from the code: drop its corps
    store.set(corpId, {
      kind: entry.kind,
      corp: kind.deserializeCorp(entry.corp, entry.commission),
      commission: entry.commission
    });
  }
  return store;
}
