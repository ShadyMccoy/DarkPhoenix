/**
 * @fileoverview Container census - WHICH of a room's five container slots are
 * spent, and on what.
 *
 * Charter: one pure classifier over a room's geometry, and the ONE place the
 * container table is described. Two readers, deliberately: the core telemetry
 * segment (so a capture can answer the question at all) and ConstructionCorp's
 * container rungs (so the number the dashboard shows is the number the
 * decision used - the `controllerSideStock` doctrine, applied to structures).
 *
 * WHY THIS EXISTS (owner 2026-08-06: *"I'd like more information and
 * instrumentation and telemetry on the containers getting built next to the
 * links"*). `CONTAINER_LIMIT = 5` is the GAME's per-room cap, not a policy
 * knob, and captures carried no structure inventory whatsoever. Five diagnoses
 * this week ended at "I cannot tell from telemetry", including two that
 * mattered:
 *
 *   - the deposit-port container never appeared and nothing could say whether
 *     the table was full, the tile was bad, or the detector found no ports;
 *   - `controllerStock` read 2,659 against a link's 800 capacity, and nothing
 *     could separate a container (which upgraders CANNOT withdraw from - a
 *     link outranks a container in `controllerInputSpot`) from a ground pile
 *     (which they can, but which decays at 2 e/t).
 *
 * Roles are derived from what a container STANDS BESIDE, never from a memory
 * flag: a flag drifts from the structure, geometry cannot.
 *
 * Layer: pure (no Game globals) - the caller passes the room's shape.
 *
 * @module telemetry/containerCensus
 */

import { Position } from "../types/Position";
import { CONTAINER_LIMIT } from "../corps/constructionPlacement";
import { controllerLink, coreLink } from "../corps/nodeEnergy";

/** What a container is FOR, derived from the thing it stands beside. */
export type ContainerRole = "source" | "coreDepot" | "controller" | "port" | "other";

export interface CensusContainer {
  pos: Position;
  role: ContainerRole;
  energy: number;
}

export interface CensusPort {
  pos: Position;
  /** A container stands within 2 - the range `resolvePortBuffer` searches. */
  hasContainer: boolean;
}

export interface ContainerCensus {
  built: number;
  sites: number;
  limit: number;
  /** Slots a rung may still claim. Sites count against the cap. */
  free: number;
  full: boolean;
  containers: CensusContainer[];
  /** Deposit-port links (neither core nor controller) and their buffer state. */
  ports: CensusPort[];
  /**
   * A controller-side container that a controller LINK has replaced as the
   * upgraders' input spot - dead weight holding a capped slot.
   *
   * Absent unless a controller link actually exists, because without one the
   * container IS the input spot and reclaiming it would strand the upgraders.
   * The flag is geometry-proven, never assumed: `controllerInputSpot` returns
   * a link before it looks at any container, and `findMissingControllerContainer`
   * refuses to build one while a link stands, so a container here can only be
   * a legacy from before the link went up.
   */
  supersededControllerContainer?: CensusContainer;
}

/** The room shape the census reads. Kept structural so tests and the live
 * segment describe the room the same way. */
export interface CensusRoom {
  storage?: Position;
  controllerPos?: Position;
  sources: Position[];
  /** Every link in the room. */
  links: Position[];
  coreLink?: Position;
  controllerLink?: Position;
  spawns: Position[];
  containers: { pos: Position; store?: { energy?: number } }[];
  /** Container CONSTRUCTION SITES standing (they hold a slot too). */
  sites: number;
}

const cheb = (a: Position, b: Position): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const near = (a: Position, b: Position | undefined, range: number): boolean => b !== undefined && cheb(a, b) <= range;
const samePos = (a: Position, b: Position | undefined): boolean => b !== undefined && a.x === b.x && a.y === b.y;

/**
 * Classify a room's container table. Returns null for a room that cannot be
 * read - an ABSENT census and an empty one are different facts, and the
 * account must never print a fabricated zero.
 */
export function classifyContainers(room: CensusRoom | undefined): ContainerCensus | null {
  if (!room) return null;

  // A deposit port is any link that is neither the hub nor the withdraw-only
  // controller link - the same set detectLinkDepositPorts walks and LinkRunner
  // loops as senders. Kept in one shape so the census and the detector cannot
  // disagree about what a port is.
  const ports: CensusPort[] = room.links
    .filter(l => !samePos(l, room.coreLink) && !samePos(l, room.controllerLink))
    .map(l => ({
      pos: l,
      // Range 2 is what resolvePortBuffer searches; a container further out is
      // not this port's buffer however convenient it looks on a map.
      hasContainer: room.containers.some(c => cheb(c.pos, l) <= 2)
    }));

  const roleOf = (p: Position): ContainerRole => {
    // ORDER MATTERS and encodes the ladder. A source container is checked
    // first because a source link often sits beside its source, and the
    // source's own buffer must not be misread as that link's port buffer.
    if (room.sources.some(s => cheb(p, s) <= 1)) return "source";
    if (near(p, room.storage, 2)) return "coreDepot";
    if (near(p, room.controllerPos, 4)) return "controller";
    if (ports.some(pt => cheb(p, pt.pos) <= 2)) return "port";
    return "other";
  };

  const containers: CensusContainer[] = room.containers.map(c => ({
    pos: c.pos,
    role: roleOf(c.pos),
    energy: c.store?.energy ?? 0
  }));

  const built = containers.length;
  const sites = room.sites;
  return {
    built,
    sites,
    limit: CONTAINER_LIMIT,
    free: Math.max(0, CONTAINER_LIMIT - built - sites),
    full: built + sites >= CONTAINER_LIMIT,
    containers,
    ports,
    ...(room.controllerLink
      ? (() => {
          const dead = containers.find(c => c.role === "controller");
          return dead ? { supersededControllerContainer: dead } : {};
        })()
      : {})
  };
}

/**
 * Live adapter: describe a Room to the pure classifier above. The ONLY
 * Game-coupled function here, kept thin so the classification itself stays
 * unit-testable from first principles.
 *
 * Returns null on a room this cannot read (harness paths without wired finds)
 * - an ABSENT census and an empty one are different facts.
 */
export function roomContainerCensus(room: Room): ContainerCensus | null {
  try {
    const p = (x: { x: number; y: number; roomName: string }): Position => ({ x: x.x, y: x.y, roomName: x.roomName });
    const links = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_LINK
    }) as StructureLink[];
    const containers = room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    }) as StructureContainer[];
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER
    }).length;
    // The core and controller links are identified by the SAME lenses the
    // runtime uses (nodeEnergy), not by re-deriving "nearest to storage" here
    // - two derivations of one fact is how a census starts lying.
    const core = coreLink(room);
    const ctrl = controllerLink(room);
    return classifyContainers({
      ...(room.storage ? { storage: p(room.storage.pos) } : {}),
      ...(room.controller ? { controllerPos: p(room.controller.pos) } : {}),
      sources: room.find(FIND_SOURCES).map(s => p(s.pos)),
      links: links.map(l => p(l.pos)),
      ...(core ? { coreLink: p(core.pos) } : {}),
      ...(ctrl ? { controllerLink: p(ctrl.pos) } : {}),
      spawns: room.find(FIND_MY_SPAWNS).map(s => p(s.pos)),
      containers: containers.map(c => ({ pos: p(c.pos), store: { energy: c.store[RESOURCE_ENERGY] ?? 0 } })),
      sites
    });
  } catch {
    return null;
  }
}
