/**
 * @fileoverview The construction LEDGER/POOL lens — the PLAN-consumed surface
 * of construction state (spec 35 phase H, split out of ConstructionCorp).
 *
 * Charter: read-only lenses over DURABLE construction state — the project
 * LEDGER (serialized corp memory, vision-independent) and the colony BUILD
 * POOL (standing sites plus blind-route receipt remainders). This is the one
 * module non-corp readers may consume: the plan's sink admission
 * (economy/planningAssembly), the consumers' construction-first clamp
 * (UpgradingCorp / LinkCorp) and the corp's own crew sizing all
 * read HERE, so none of them imports the corp runtime.
 *
 * Layer: corps-side WORLD LENS, not PLAN-pure — it reads Game.rooms and the
 * serialized corp store in Memory, always behind typeof guards so Game-less
 * harnesses can call it (the purity suite ratchets the guards). It WRITES
 * nothing: the single writer of ledger records is
 * ConstructionCorp.reconcileProjects (sight reconciles, decisions read).
 *
 * @module corps/constructionLedger
 */

import {
  projectAbsorbRate
} from "../economy/primitives";
import { spendableBankSurplus, resolveReserveTarget } from "../economy/bank";
import { ROAD_BUILD_COST } from "../economy/roadEconomics";
import { roomLinearDistance } from "../utils/RoomDiscovery";

/**
 * One entry of the corp's PROJECT LEDGER (the observe-and-remember pattern,
 * owner 2026-07-22: "construction sites should be part of the corps memory
 * so it can rehydrate and bypass Vision. That's a general pattern we should
 * work towards - similar to staffsPost"): a durable record of a standing
 * construction site, written/refreshed whenever its room is SIGHTED, read
 * by decisions (the plan's sink admission) regardless of vision. Ground
 * truth wins on sight; a record unseen for PROJECT_LEDGER_DECAY retires
 * (hostiles can stomp sites in unowned rooms while we are blind).
 */
export interface ProjectRecord {
  id: string;
  x: number;
  y: number;
  roomName: string;
  structureType: string;
  /** Energy remaining (progressTotal - progress) at last sight. */
  remaining: number;
  /** Tick of last reconciliation against vision. */
  seen: number;
}

/** Ticks a ledger record survives without sight before it retires. */
export const PROJECT_LEDGER_DECAY = 10_000;

/**
 * THE ONE LENS for "what construction projects stand, colony-wide" - read
 * from the serialized corp store in Memory (durable across resets, never
 * vision-gated), deduped by site id across corps. The plan's sink
 * admission, crew reasoning and telemetry must all read THIS, never scan
 * Game.rooms (the staffsPost symmetry rule applied to world state; the
 * measured alternative was the cluster flap - 15 sinks -> 0 across two
 * captures with the solve keyed to which room happened to be sighted).
 */
export function constructionProjectLedger(): ProjectRecord[] {
  const out = new Map<string, ProjectRecord>();
  if (typeof Memory === "undefined" || !Memory.commissionedCorps) return [];
  for (const key of Object.keys(Memory.commissionedCorps)) {
    const entry = Memory.commissionedCorps[key] as { kind?: string; corp?: { projects?: ProjectRecord[] } };
    if (entry?.kind !== "construction") continue;
    for (const rec of entry.corp?.projects ?? []) {
      if (rec.remaining > 0) out.set(rec.id, rec);
    }
  }
  return [...out.values()];
}

/**
 * The colony's BUILD POOL (owner 2026-07-20: "It basically just doesn't
 * matter which room the construction is in"): every room with our
 * construction sites, home room first then nearest, each with its remaining
 * work. ONE spawn-scoped crew is sized against the whole pool and marches
 * wherever the work is - the room enters the math only as travel distance.
 * This retires the distributed trunk model (each room's corp owned its
 * segment), whose empty-room corps fielded self-ferrying 1-WORK runts:
 * trunk stalled at 32/38 for ~4300 ticks, measured.
 */
export interface BuildPoolEntry {
  roomName: string;
  /** Absent for a BLIND receipt entry - the crew's travel restores it. */
  room?: Room;
  work: number;
}

export function buildPool(homeRoomName: string): BuildPoolEntry[] {
  const entries: BuildPoolEntry[] = [];
  if (typeof Game === "undefined" || !Game.rooms) return entries;
  for (const roomName in Game.rooms) {
    const r = Game.rooms[roomName];
    let work = 0;
    try {
      for (const s of r.find(FIND_MY_CONSTRUCTION_SITES)) work += s.progressTotal - s.progress;
    } catch {
      continue; // partial mocks
    }
    if (work > 0) entries.push({ roomName, room: r, work });
  }
  // RECEIPT REMAINDERS (the stranded-trunk deadlock, prod t72488324): the
  // vision scan above is a creep-position lens - when a trunk room went
  // dark, poolWork hit 0, the crew stood down, and nobody was left to ever
  // restore vision (trunk-blind-W43N22 for 1100+ ticks, cee0 frozen 35/50).
  // The HOME room's roadRoutes receipts are the durable signal (CLAUDE.md:
  // room state from intel, never vision): charge each BLIND route room its
  // tile-share of the unbuilt remainder so the crew fields and marches -
  // arrival restores vision and the ground-truth scan takes over. Visible
  // rooms NEVER take a receipt charge (their standing sites are the truth).
  const routes = Game.rooms[homeRoomName]?.memory?.roadRoutes;
  if (routes) {
    const blindWork = new Map<string, number>();
    for (const key of Object.keys(routes)) {
      const e = routes[key];
      if (!e || e.paved || e.declined || !e.tiles3 || !e.rooms) continue;
      const total = e.total ?? 0;
      const remaining = total - (e.built ?? 0);
      if (total <= 0 || remaining <= 0) continue;
      const tileCount = e.tiles3.length / 3;
      const perRoom = new Map<string, number>();
      for (let i = 2; i < e.tiles3.length; i += 3) {
        const rn = e.rooms[e.tiles3[i]];
        if (rn) perRoom.set(rn, (perRoom.get(rn) ?? 0) + 1);
      }
      for (const [rn, count] of perRoom) {
        if (Game.rooms[rn]) continue;
        const share = (remaining * count) / tileCount;
        blindWork.set(rn, (blindWork.get(rn) ?? 0) + share * ROAD_BUILD_COST);
      }
    }
    for (const [roomName, work] of blindWork) {
      if (work > 0) entries.push({ roomName, work });
    }
  }
  const rank = (name: string): number => (name === homeRoomName ? -1 : roomLinearDistance(homeRoomName, name));
  entries.sort((a, b) => rank(a.roomName) - rank(b.roomName));
  return entries;
}

/**
 * The energy/tick the ONE build-pool crew can usefully absorb - the shared
 * CONSTRUCTION-FIRST bound (prod t72478939). Three readers, one formula:
 * the crew sizing (builderPlan), the plan's construction-sink capacity
 * (flowAdapter, via the same primitives.projectAbsorbRate), and the
 * consumers' surplus clamp (feederRelayTarget / upgraderSizing). The clamp's
 * boolean predecessor ("any site stands") treated 12 road sites - pool
 * absorb ~5 e/t - exactly like a 100k build-out: it freed the whole 115 e/t
 * surplus from the upgraders, construction ate 0.47 e/t measured, and the
 * difference BANKED (+20.18/t at 474k, 17x the warchest target). Bounding
 * the clamp by what the build set can actually EAT is what makes
 * "construction first" funnel energy to construction instead of the bank.
 *
 * Inputs mirror builderPlan's home branch verbatim: total pool work over
 * the buffered horizon of the FARTHEST pool room (in-room = spawn range to
 * the first site; remote = roomLinearDistance * 50).
 */
/**
 * The colony's summed outstanding construction work (energy), the WARTIME
 * backlog gauge (spec 33). Same buildPool lens buildPoolAbsorbRate sizes from -
 * including the durable blind-route receipt remainders - so the fleet
 * relegation (UpgradingCorp) reads exactly the work the crew is funded to eat.
 */
export function buildPoolBacklog(homeRoomName: string): number {
  return buildPool(homeRoomName).reduce((s, e) => s + e.work, 0);
}

export function buildPoolAbsorbRate(homeRoomName: string, spawnPos: RoomPosition | undefined): number {
  const pool = buildPool(homeRoomName);
  if (pool.length === 0) return 0;
  const siteWork = pool.reduce((s, e) => s + e.work, 0);
  let travel = 0;
  for (const e of pool) {
    let t: number;
    if (e.roomName === homeRoomName && e.room && spawnPos) {
      let sitePos: RoomPosition | undefined;
      try {
        sitePos = e.room.find(FIND_MY_CONSTRUCTION_SITES)[0]?.pos;
      } catch {
        sitePos = undefined; // partial mocks
      }
      t = spawnPos.getRangeTo(sitePos ?? spawnPos);
    } else {
      // Blind receipt entries take this leg too - only the NAME is needed.
      t = roomLinearDistance(homeRoomName, e.roomName) * 50;
    }
    if (t > travel) travel = t;
  }
  // WARTIME acceleration (spec 33 down-payment): while the home room holds a
  // spendable warchest surplus, finish construction fast (shorter horizon) so
  // the surplus is spent into structures, not banked. Same bankSurplusRate lens
  // flowAdapter's construction sink reads, so the plan and the crew agree on the
  // pace. Bounded by the available energy downstream, so it never over-draws.
  const room = typeof Game !== "undefined" && Game.rooms ? Game.rooms[homeRoomName] : undefined;
  const accelerate =
    !!room?.storage?.my &&
    spendableBankSurplus(room.storage.store[RESOURCE_ENERGY] ?? 0, resolveReserveTarget(Memory.warchestTarget)) > 0;
  return projectAbsorbRate(siteWork, travel, accelerate);
}
