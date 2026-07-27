/**
 * @fileoverview The id-space lens module (spec 35 phase C; ONTOLOGY §5).
 *
 * "Lookups that cross id spaces must normalize explicitly" - this module is
 * the ONE home for those normalizations. Every lens here re-homes string
 * logic that used to be copy-pasted at its call sites; none of them changes
 * an id. Corp ids and creep `memory.corpId` are LEGACY-STABLE (trap list:
 * "Corp id prefixes - a rename silently orphans live creeps"), so each lens
 * must keep producing byte-identical results for every id shape its encoder
 * mints.
 *
 * Encoders cross-referenced per lens:
 *  - flow source ids  ("source-<gameId>"): flow/FlowTypes.createFlowSource
 *  - flow sink ids    ("spawn-<gameId>" etc.): flow/FlowTypes.createFlowSink
 *  - bank source ids  ("bank-<roomName>"): economy/bank.bankSourceId
 *  - scavenge stocks  ("scavenge-ROOM-X-Y"): economy/scavenge.stockId
 *  - intel phantoms   ("intel-ROOM-X-Y"): execution/IncrementalAnalysis
 *    (buildRoomNodes' intel fallback, `intel-${roomName}-${x}-${y}`; wrapped
 *    by createFlowSource into "source-intel-ROOM-X-Y" on the graph)
 *
 * PLAN-purity: this module is pure (no Game/Memory) and registered on the
 * purity ratchet's PURE list (test/unit/economy/purity.test.ts).
 *
 * @module economy/ids
 */

import { Position } from "../types/Position";

/** Flow-graph source id prefix - minted by flow/FlowTypes.createFlowSource. */
export const FLOW_SOURCE_PREFIX = "source-";

/** Flow-graph spawn sink id prefix - minted by flow/FlowTypes.createFlowSink. */
export const FLOW_SPAWN_PREFIX = "spawn-";

/** Bank source id prefix - minted by economy/bank.bankSourceId ("bank-W1N1"). */
export const BANK_SOURCE_PREFIX = "bank-";

/** Scavenge stock id prefix - minted by economy/scavenge.stockId ("scavenge-ROOM-X-Y"). */
export const SCAVENGE_STOCK_PREFIX = "scavenge-";

/** Intel phantom-source id prefix - minted by execution/IncrementalAnalysis ("intel-ROOM-X-Y"). */
export const INTEL_SOURCE_PREFIX = "intel-";

/**
 * Strip the flow "source-" prefix to the real game id (anchored). Well-formed
 * ids only ever carry the prefix at position 0 (game ids are alphanumeric;
 * intel/scavenge/bank ids never embed "source-" mid-string), so anchoring is
 * byte-identical to the historical unanchored `.replace("source-", "")`.
 */
export function stripSourcePrefix(id: string): string {
  return id.startsWith(FLOW_SOURCE_PREFIX) ? id.slice(FLOW_SOURCE_PREFIX.length) : id;
}

/**
 * Strip the flow "spawn-" prefix to the real spawn game id (anchored - same
 * position-0 argument as stripSourcePrefix). Undefined/null pass through as
 * undefined, mirroring the optional-chained `.replace` at the historical call
 * sites (commission spawnIds are optional in several assignment shapes).
 */
export function stripSpawnPrefix(id: string): string;
export function stripSpawnPrefix(id: string | undefined): string | undefined;
export function stripSpawnPrefix(id: string | undefined): string | undefined {
  if (id == null) return undefined;
  return id.startsWith(FLOW_SPAWN_PREFIX) ? id.slice(FLOW_SPAWN_PREFIX.length) : id;
}

/** A positional id ("intel-ROOM-X-Y" / "scavenge-ROOM-X-Y") decoded. */
export interface PositionalId {
  kind: "intel" | "scavenge";
  pos: Position;
}

/**
 * The intel-/scavenge- position codec: ONE regex for the two position-encoded
 * id forms (encoders: scavenge.stockId, IncrementalAnalysis' intel phantom
 * minting - see the module header). Replaces four copy-pasted regexes
 * (CarryCorp x2, HarvestCorp x2). The "source-intel-*" graph form is never
 * parsed directly anywhere (every parse site runs post-strip), so the codec
 * deliberately does not accept it - strip first (stripSourcePrefix).
 *
 * Returns null for anything else - including the non-positional intel ids
 * ("intel-controller-<room>", "intel-mineral-<room>"), exactly like the
 * per-site regexes did.
 */
export function parsePositionalId(id: string): PositionalId | null {
  const match = /^(intel|scavenge)-([EW]\d+[NS]\d+)-(\d+)-(\d+)$/.exec(id);
  if (!match) return null;
  const [, kind, roomName, x, y] = match;
  return {
    kind: kind as "intel" | "scavenge",
    pos: { x: parseInt(x, 10), y: parseInt(y, 10), roomName }
  };
}

/** True for a scavenge ground-stock id (encoder: economy/scavenge.stockId). */
export function isScavengeId(id: string): boolean {
  return id.startsWith(SCAVENGE_STOCK_PREFIX);
}

/** True for an intel phantom-source id (encoder: execution/IncrementalAnalysis). */
export function isIntelId(id: string): boolean {
  return id.startsWith(INTEL_SOURCE_PREFIX);
}

/** True for a bank/hub source id (encoder: economy/bank.bankSourceId). */
export function isBankSourceId(id: string): boolean {
  return id.startsWith(BANK_SOURCE_PREFIX);
}

/**
 * The hub ROOM a bank source id encodes ("bank-W1N1" -> "W1N1") - the inverse
 * of bank.bankSourceId. Callers must gate on isBankSourceId first; on a
 * non-bank id this returns garbage, exactly like the historical inline
 * `.slice("bank-".length)`.
 */
export function bankRoomFromId(id: string): string {
  return id.slice(BANK_SOURCE_PREFIX.length);
}

/**
 * Whether a source id counts as SUSTAINED mined income (excludes intel-only
 * prospects - rooms scouted before their real source ids were recorded, which
 * are not income; the t72444684 phantom guard). One home for the rule so the
 * plan's income sum (flowAdapter buildColonyProblem minedSupply), the
 * spec-25 cluster-source scan, and the reserve's income (FlowEconomy
 * warchestTarget) classify identically and cannot drift. Both the raw intel
 * form and the graph-wrapped "source-intel-*" form are excluded (encoders:
 * IncrementalAnalysis mints "intel-*", createFlowSource wraps it).
 */
export function isMinedIncomeId(id: string): boolean {
  return !id.startsWith(FLOW_SOURCE_PREFIX + INTEL_SOURCE_PREFIX) && !id.startsWith(INTEL_SOURCE_PREFIX);
}
