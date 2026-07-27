/**
 * @fileoverview Intel telemetry writer - segment 3 (scouted room intel).
 *
 * Charter: the `IntelTelemetry` segment shape and its ONE writer - a verbatim
 * projection of `Memory.roomIntel` (scout observations, defense state per
 * spec 12/13, our reservation bank per spec 15 P5) so dashboards read room
 * state without a /user/memory pull. The emitted bytes are a frozen external
 * contract (versioned; an external app parses them) - field order and version
 * numbers never change in a refactor.
 *
 * Layer: telemetry writer (Memory-coupled; writes RawMemory segment 3).
 *
 * @module telemetry/intelSegment
 */

import { TELEMETRY_SEGMENTS } from "./segmentIds";

/**
 * Intel telemetry data structure (Segment 3).
 */
export interface IntelTelemetry {
  version: number;
  tick: number;
  rooms: {
    name: string;
    lastVisit: number;
    sourceCount: number;
    sourcePositions: { x: number; y: number }[];
    mineralType: string | null;
    mineralPos: { x: number; y: number } | null;
    controllerLevel: number;
    controllerPos: { x: number; y: number } | null;
    controllerOwner: string | null;
    controllerReservation: string | null;
    hostileCreepCount: number;
    hostileStructureCount: number;
    isSafe: boolean;
    /** Spec 12/13 defense state - previously invisible to dashboards. */
    hostileUntil?: number;
    invaderReservedUntil?: number;
    invaderCorePresent?: boolean;
    raidDebt?: number;
    lastRaidSeen?: number;
    reservedUntil?: number;
    reservedBy?: string;
  }[];
}

/**
 * Updates intel telemetry (Segment 3).
 */
export function updateIntelTelemetry(): void {
  const rooms: IntelTelemetry["rooms"] = [];

  if (Memory.roomIntel) {
    for (const roomName in Memory.roomIntel) {
      const intel = Memory.roomIntel[roomName];
      rooms.push({
        name: roomName,
        lastVisit: intel.lastVisit,
        sourceCount: intel.sourceCount,
        sourcePositions: intel.sourcePositions,
        mineralType: intel.mineralType,
        mineralPos: intel.mineralPos,
        controllerLevel: intel.controllerLevel,
        controllerPos: intel.controllerPos,
        controllerOwner: intel.controllerOwner,
        controllerReservation: intel.controllerReservation,
        hostileCreepCount: intel.hostileCreepCount,
        hostileStructureCount: intel.hostileStructureCount,
        isSafe: intel.isSafe,
        // Defense state (spec 12/13): the active defund marks and the raid
        // meter, so dashboards can see live windows without Memory access.
        ...(intel.hostileUntil !== undefined ? { hostileUntil: intel.hostileUntil } : {}),
        ...(intel.invaderReservedUntil !== undefined ? { invaderReservedUntil: intel.invaderReservedUntil } : {}),
        ...(intel.invaderCorePresent !== undefined ? { invaderCorePresent: intel.invaderCorePresent } : {}),
        ...(intel.raidDebt !== undefined ? { raidDebt: intel.raidDebt } : {}),
        ...(intel.lastRaidSeen !== undefined ? { lastRaidSeen: intel.lastRaidSeen } : {}),
        // Our reservation bank (spec 15 P5): the duty-cycle lens, exported
        // so a capture shows what the reserver gate coasts on.
        ...(intel.reservedUntil !== undefined ? { reservedUntil: intel.reservedUntil } : {}),
        ...(intel.reservedBy !== undefined ? { reservedBy: intel.reservedBy } : {})
      });
    }
  }

  const telemetry: IntelTelemetry = {
    version: 1,
    tick: Game.time,
    rooms
  };

  RawMemory.segments[TELEMETRY_SEGMENTS.INTEL] = JSON.stringify(telemetry);
}
