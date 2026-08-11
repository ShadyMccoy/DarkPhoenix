/**
 * @fileoverview Room lenses over public map data and durable intel.
 *
 * Room-box discovery around owned rooms (public map data, no vision), plus
 * the shared room-state lenses the trap list mandates (isReservableRoom,
 * hostileRooms, routeIsDangerous) - durable signals, never creep positions.
 *
 * @module utils/RoomDiscovery
 */

import { recordRaidSighting } from "./raidMeter";
import { INVADER_TTL } from "../economy/primitives";
import { record as blackBox } from "../telemetry/BlackBox";

/**
 * Parses a room name into its coordinate components.
 * E.g., "E75N8" -> { xDir: "E", x: 75, yDir: "N", y: 8 }
 */
function parseRoomName(roomName: string): { xDir: string; x: number; yDir: string; y: number } | null {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return null;
  return {
    xDir: match[1],
    x: parseInt(match[2], 10),
    yDir: match[3],
    y: parseInt(match[4], 10)
  };
}

/**
 * Builds a room name from coordinate components.
 */
function buildRoomName(xDir: string, x: number, yDir: string, y: number): string {
  return `${xDir}${x}${yDir}${y}`;
}

/** Default radius for room box discovery (3 = 7x7 grid) */
export const DEFAULT_ROOM_BOX_RADIUS = 3;

/**
 * Gets a box of room names centered on the given room with configurable radius.
 * A radius of 3 gives a 7x7 box (49 rooms), radius of 4 gives 9x9 (81 rooms), etc.
 *
 * @param centerRoom - The room at the center of the box
 * @param radius - Distance from center (default 3 for 7x7)
 * @returns Array of room names in the box
 */
export function getRoomBox(centerRoom: string, radius: number = DEFAULT_ROOM_BOX_RADIUS): string[] {
  const parsed = parseRoomName(centerRoom);
  if (!parsed) return [centerRoom];

  const rooms: string[] = [];

  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      // Calculate new coordinates, handling sector boundary crossings
      let newX = parsed.x + dx;
      let newY = parsed.y + dy;
      let newXDir = parsed.xDir;
      let newYDir = parsed.yDir;

      // Handle X axis crossing (W/E boundary at 0)
      if (newX < 0) {
        // Crossing from E to W or W to E
        newX = -newX - 1; // E0 - 1 = W0, E0 - 2 = W1
        newXDir = parsed.xDir === "E" ? "W" : "E";
      }

      // Handle Y axis crossing (N/S boundary at 0)
      if (newY < 0) {
        // Crossing from N to S or S to N
        newY = -newY - 1; // N0 - 1 = S0, N0 - 2 = S1
        newYDir = parsed.yDir === "N" ? "S" : "N";
      }

      rooms.push(buildRoomName(newXDir, newX, newYDir, newY));
    }
  }

  return rooms;
}

/**
 * Gets a box of rooms centered on each owned room, combined.
 * Filters out closed rooms.
 *
 * @param radius - Distance from center (default 3 for 7x7)
 * @returns Set of room names in the combined boxes
 */
export function getRoomBoxAroundOwnedRooms(radius: number = DEFAULT_ROOM_BOX_RADIUS): Set<string> {
  const rooms = new Set<string>();

  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (room.controller?.my) {
      const box = getRoomBox(roomName, radius);
      for (const boxRoom of box) {
        // Check if room is accessible
        const status = Game.map.getRoomStatus(boxRoom);
        if (status.status !== "closed") {
          rooms.add(boxRoom);
        }
      }
    }
  }

  return rooms;
}

/**
 * Gets a 7x7 box of rooms centered on each owned room, combined.
 * Convenience wrapper for getRoomBoxAroundOwnedRooms with radius 3.
 */
export function get7x7BoxAroundOwnedRooms(): Set<string> {
  return getRoomBoxAroundOwnedRooms(3);
}

/**
 * Source-Keeper room classification by name: both room-grid coordinates mod 10
 * in [4,6], excluding the center (5,5) crossroads room. SK rooms' sources are
 * already excluded from mining (SourceAnalysis keeper check; grid cell
 * plan-t5-sk-never-mined), but nothing kept CREEPS out: scouts wandered in and
 * died to keepers (measured: 4 creeps parked in W44N24 on the shard1 stress
 * fixture). Mirrors test/grid/pack.ts's isSkRoomName - keep in sync.
 */
export function isSourceKeeperRoom(name: string): boolean {
  const m = /^[WE](\d+)[NS](\d+)$/.exec(name);
  if (!m) return false;
  const h = Number(m[1]) % 10;
  const v = Number(m[2]) % 10;
  const inBand = (n: number) => n >= 4 && n <= 6;
  return inBand(h) && inBand(v) && !(h === 5 && v === 5);
}

/**
 * Pure room-name port of Game.map.getRoomLinearDistance: Chebyshev distance on
 * the room lattice, with the W/E and N/S seams handled (Wn -> -n-1 / En -> n on
 * x; Nn -> -n-1 / Sn -> n on y). Pure so PLANNING code (CorpKind.propose) can
 * gate by distance without touching Game. Malformed names -> Infinity.
 */
export function roomLinearDistance(a: string, b: string): number {
  const pa = parseRoomName(a);
  const pb = parseRoomName(b);
  if (!pa || !pb) return Infinity;
  const wx = (p: { xDir: string; x: number }): number => (p.xDir === "W" ? -p.x - 1 : p.x);
  const wy = (p: { yDir: string; y: number }): number => (p.yDir === "N" ? -p.y - 1 : p.y);
  return Math.max(Math.abs(wx(pa) - wx(pb)), Math.abs(wy(pa) - wy(pb)));
}

/**
 * THE room-reservability lens: could `myUsername` hold this room's controller?
 * Prefers live vision when the room happens to be visible, and falls back to
 * scout intel (Memory.roomIntel) - it NEVER reads creep positions, so the
 * answer cannot flap when a creep dies or vision is lost. This is the same
 * predicate the planner's source valuation uses (IncrementalAnalysis
 * couldReserve: sources in reservable rooms are worth the reserved 3000), so
 * "valued as reservable" and "reserver dispatched" can never disagree.
 *
 * Stranded-reserver incident (shard1 t72378345): ReservationCorp derived its
 * targets from "a miner creep is standing in the room THIS TICK" - the dead
 * miner took both the trigger and the room's vision with it, an in-flight
 * 1300-energy reserver was revoked mid-route and idled out its CLAIM lifetime,
 * and the blackbox showed 10 reserver spawns in 2400 ticks of churn. Room
 * state must come from durable signals: this lens, or the plan's commissions.
 *
 * Unknown rooms (no vision, no intel) default to reservable: reservation
 * targets only come from the plan, and the plan only mines rooms it has seen.
 */
export function isReservableRoom(roomName: string, myUsername: string | undefined): boolean {
  const room = typeof Game !== "undefined" && Game.rooms ? Game.rooms[roomName] : undefined;
  if (room) {
    const ctrl = room.controller;
    return !!ctrl && !ctrl.owner && (!ctrl.reservation || ctrl.reservation.username === myUsername);
  }
  const intel = typeof Memory !== "undefined" ? Memory.roomIntel?.[roomName] : undefined;
  if (!intel) return true;
  return (
    !!intel.controllerPos &&
    !intel.controllerOwner &&
    (!intel.controllerReservation || intel.controllerReservation === myUsername)
  );
}

/** The Invader NPC's username: invader creeps and invader-core reservations. */
export const INVADER_USERNAME = "Invader";

/**
 * Ticks OUR reservation on `roomName` has left, from the intel-stamped bound
 * (see RoomIntel.reservedUntil). 0 for unknown, expired, or someone else's
 * reservation - the conservative read (over-reserve, never lose the 3000
 * rate). THE lens for the reserver duty cycle (spec 15 P5): the demand gate
 * and any work-side release must both read this, never live vision.
 */
export function myReservationTicksLeft(roomName: string, myUsername: string | undefined): number {
  const intel = typeof Memory !== "undefined" ? Memory.roomIntel?.[roomName] : undefined;
  if (!intel?.reservedUntil || !myUsername || intel.reservedBy !== myUsername) return 0;
  return Math.max(0, intel.reservedUntil - Game.time);
}

/**
 * Rooms currently held by hostiles, memoized per tick. Two flavors, one set:
 * hostile CREEPS (invaders, or any player's) sighted in the room, and an
 * invader CORE's controller reservation - the core is a structure the creep
 * pass never sees, so the reservation itself is the observable. The v1
 * DEFENSE ECONOMICS (owner directive 2026-07-10): while hostiles hold a
 * room, the corps operating there are DEFUNDED - no new bodies are bought
 * for a grinder (miners mining there, haulers hauling there, reservers
 * headed there). Existing creeps run out; funding resumes the tick the room
 * clears. Vision-limited by design: an unseen room is not assumed hostile.
 */
let hostileRoomsTick = -1;
let hostileRoomsCache = new Set<string>();
export function hostileRooms(): Set<string> {
  if (typeof Game === "undefined" || !Game.rooms) return new Set();
  if (Game.time === hostileRoomsTick) return hostileRoomsCache;
  hostileRoomsTick = Game.time;
  hostileRoomsCache = new Set<string>();

  // Vision pass: sight a hostile once and its ticksToLive BOUNDS the threat
  // (owner: "not always sight on the invaders, but if we see one we capture
  // the TTL") - the mark outlives vision; a clear sighting lifts it early.
  if (typeof Memory !== "undefined") {
    Memory.roomIntel = Memory.roomIntel ?? {};
    for (const roomName in Game.rooms) {
      const hostiles = Game.rooms[roomName].find(FIND_HOSTILE_CREEPS);
      const intel = Memory.roomIntel[roomName];
      if (hostiles.length > 0) {
        const maxTtl = hostiles.reduce((m, c) => Math.max(m, c.ticksToLive ?? 1500), 0);
        const until = Game.time + maxTtl;
        if (intel?.hostileUntil === undefined) {
          // Fresh mark on a previously-clear room: flight-recorder row so
          // live defund windows have measurable starts (spec 13 phase 5).
          blackBox("mark", { room: roomName, kind: "creeps", until });
          // Durable episode START (v33 attribution): the all-clear below
          // retains {from, until} so a death inside the window attributes
          // even after the live mark lifts. Only stamped on the fresh mark -
          // repeat sightings extend hostileUntil, not the start.
          if (intel) intel.hostileMarkedAt = Game.time;
        }
        if (intel) intel.hostileUntil = until;
        else {
          Memory.roomIntel[roomName] = { lastVisit: Game.time, hostileUntil: until, hostileMarkedAt: Game.time } as RoomIntel;
        }
        // Raid observation (spec 13): Invader-owned creeps in sight mean the
        // engine zeroed its raid fuse when it spawned them - zero the mirror
        // and stamp the sighting (the guard corp's reactive trigger). One
        // flight-recorder row per raid (not per tick of visibility).
        if (hostiles.some(c => c.owner?.username === INVADER_USERNAME)) {
          const seen = Memory.roomIntel[roomName]?.lastRaidSeen;
          if (seen === undefined || Game.time - seen >= INVADER_TTL) {
            blackBox("raid", { room: roomName, debt: Memory.roomIntel[roomName]?.raidDebt ?? 0 });
          }
          recordRaidSighting(roomName);
        }
      } else if (intel?.hostileUntil) {
        // RETAIN the closed window before lifting the mark (v33): the loss
        // meter books tombstones AFTER this clear in any room with standing
        // vision - the home room ALWAYS has it, so deleting outright erased
        // the attribution evidence within ticks of every fight ending
        // (measured t72792889: 9,203e killed cargo, the live-mark lens
        // caught 332e / 3.6%, with 47% of kills at home). `from` falls back
        // to until - max creep TTL for legacy mid-episode entries - bounded
        // by physics, never wider than a real episode could be.
        const HOSTILE_WINDOWS_KEPT = 3;
        intel.hostileWindows = [
          ...(intel.hostileWindows ?? []).slice(-(HOSTILE_WINDOWS_KEPT - 1)),
          { from: intel.hostileMarkedAt ?? intel.hostileUntil - 1500, until: intel.hostileUntil }
        ];
        delete intel.hostileMarkedAt;
        delete intel.hostileUntil; // fresh all-clear sighting
        blackBox("unmark", { room: roomName, kind: "creeps" });
      }

      // Invader-core reservation: the room is held even with zero hostile
      // creeps in sight. The reservation's ticksToEnd bounds the occupation
      // the way a creep's ticksToLive bounds a raid - though a live core
      // RENEWS it, so each sighting refreshes the bound; blind, the mark
      // lapses at the last-seen bound and the next sighting re-arms it.
      const reservation = Game.rooms[roomName].controller?.reservation;
      const stamped = Memory.roomIntel[roomName]; // may exist since the creep pass
      if (reservation && reservation.username === INVADER_USERNAME) {
        const until = Game.time + reservation.ticksToEnd;
        if (stamped?.invaderReservedUntil === undefined) {
          blackBox("mark", { room: roomName, kind: "reservation", until });
        }
        if (stamped) stamped.invaderReservedUntil = until;
        else {
          Memory.roomIntel[roomName] = { lastVisit: Game.time, invaderReservedUntil: until } as RoomIntel;
        }
        // Is the CORE itself in sight? Splits the occupation into its two
        // phases for the buster corp (spec 13 phase 4): core alive = KILL
        // (stripping against a live core's +2/tick renewal is pointless),
        // core dead = STRIP (the leftover reservation decays 1/tick for up
        // to 5000 ticks unless CLAIM parts grind it). Only checked in
        // invader-reserved rooms with vision, so the extra find() is rare.
        const coreSeen = Game.rooms[roomName]
          .find(FIND_HOSTILE_STRUCTURES)
          .some(s => s.structureType === STRUCTURE_INVADER_CORE);
        Memory.roomIntel[roomName].invaderCorePresent = coreSeen;
      } else if (stamped?.invaderReservedUntil) {
        delete stamped.invaderReservedUntil; // fresh sighting: reservation gone
        delete stamped.invaderCorePresent;
        blackBox("unmark", { room: roomName, kind: "reservation" });
      }
      // PLAYER reservation bound (spec 15 P5): stamp the absolute end-tick so
      // the ReservationCorp can coast on a banked reservation with zero
      // vision - the bound counts down exactly as the reservation does.
      if (reservation && reservation.username !== INVADER_USERNAME) {
        const target = stamped ?? (Memory.roomIntel[roomName] = { lastVisit: Game.time } as RoomIntel);
        target.reservedUntil = Game.time + reservation.ticksToEnd;
        target.reservedBy = reservation.username;
      } else if (stamped?.reservedUntil !== undefined && !reservation) {
        delete stamped.reservedUntil; // fresh sighting: no reservation stands
        delete stamped.reservedBy;
      }
    }
    // Marks persist without vision until their TTL bound expires.
    for (const roomName in Memory.roomIntel) {
      const intel = Memory.roomIntel[roomName];
      const hostileUntil = intel?.hostileUntil;
      const reservedUntil = intel?.invaderReservedUntil;
      if (
        (hostileUntil !== undefined && hostileUntil > Game.time) ||
        (reservedUntil !== undefined && reservedUntil > Game.time)
      ) {
        hostileRoomsCache.add(roomName);
      }
    }
  } else {
    for (const roomName in Game.rooms) {
      const room = Game.rooms[roomName];
      if (room.find(FIND_HOSTILE_CREEPS).length > 0 || room.controller?.reservation?.username === INVADER_USERNAME) {
        hostileRoomsCache.add(roomName);
      }
    }
  }
  return hostileRoomsCache;
}

/**
 * Rooms a haul route transits between two rooms, endpoints included, per the
 * engine's room-level router (Game.map.findRoute - the same topology moveTo
 * follows across rooms). Memoized per tick. Falls back to just the endpoints
 * when the map API is unavailable (harness) or routing fails, so callers
 * degrade to the old pickup-room-only behavior.
 *
 * Spec 13 phase 2b (The International's `pathsThrough`): a route is dangerous
 * if ANY room it transits is hostile - haulers must not drive their circuit
 * through a raid two rooms out just because the pickup room itself is clear.
 */
let routeRoomsTick = -1;
let routeRoomsCache = new Map<string, string[]>();
export function routeRooms(fromRoom: string, toRoom: string): string[] {
  if (typeof Game === "undefined") return [fromRoom, toRoom];
  if (Game.time !== routeRoomsTick) {
    routeRoomsTick = Game.time;
    routeRoomsCache = new Map();
  }
  const key = `${fromRoom}->${toRoom}`;
  const hit = routeRoomsCache.get(key);
  if (hit) return hit;

  let rooms = [fromRoom, toRoom];
  if (fromRoom === toRoom) {
    rooms = [fromRoom];
  } else if (typeof Game.map?.findRoute === "function") {
    const route = Game.map.findRoute(fromRoom, toRoom);
    if (Array.isArray(route)) {
      rooms = [fromRoom, ...route.map(step => step.room)];
    }
  }
  routeRoomsCache.set(key, rooms);
  return rooms;
}

/** Is any room on the route between the two rooms currently hostile? */
export function routeIsDangerous(fromRoom: string, toRoom: string): boolean {
  const danger = hostileRooms();
  if (danger.size === 0) return false;
  return routeRooms(fromRoom, toRoom).some(r => danger.has(r));
}
