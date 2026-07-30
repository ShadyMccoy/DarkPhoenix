/**
 * @fileoverview Corps telemetry writer - segment 4 (per-corp census, bodies,
 * sizing records).
 *
 * Charter: the `CorpsTelemetry` segment shape and its ONE writer - one row per
 * census corp with its kind/type/room, its MEASURED aggregate body (from the
 * shared telemetry/bodyCensus pass, never a reconstruction from planned
 * rates), and the verbatim sizing stamp from the corp's last sizing decision
 * (spec 14 phase 2). The emitted bytes are a frozen external contract
 * (versioned; an external app parses them) - field order and version numbers
 * never change in a refactor.
 *
 * Layer: telemetry writer (Game-coupled; writes RawMemory segment 4).
 *
 * @module telemetry/corpsSegment
 */

import { CorpSizingRecord } from "../corps/Corp";
import { BodyAggregate, CorpCensusEntry, corpCreepCount, corpRoomName, emptyBody } from "./bodyCensus";
import { TELEMETRY_SEGMENTS } from "./segmentIds";

/**
 * Corps telemetry data structure (Segment 4).
 */
export interface CorpsTelemetry {
  version: number;
  tick: number;
  corps: {
    id: string;
    /** Commission kind (harvest/carry/reservation/tender/...) - the precise operator */
    kind: string;
    /** CorpType (mining/hauling/moving/...) - note tender & feeder share "moving" */
    type: string;
    nodeId: string;
    roomName: string;
    creepCount: number;
    /** Total ACTUAL body parts across this corp's live creeps (measured, 0 if none). */
    bodyParts: number;
    /** ACTUAL body parts by type for this corp's live creeps; {} when it has none. */
    body: { [part: string]: number };
    /**
     * Inputs of the corp's last sizing decision, exported verbatim from the
     * decision-site stamp (spec 14 phase 2). Absent for corps that don't stamp.
     */
    sizing?: CorpSizingRecord;
    createdAt: number;
    lastActivityTick: number;
  }[];
  summary: {
    totalCorps: number;
    /** Corps with at least one live creep */
    activeCorps: number;
    /** Count of corps by commission kind (every kind, including aux kinds) */
    corpsByKind: { [kind: string]: number };
  };
}

/**
 * Updates corps telemetry (Segment 4).
 */
export function updateCorpsTelemetry(census: CorpCensusEntry[], perCorpBody: Map<string, BodyAggregate>): void {
  const corps: CorpsTelemetry["corps"] = [];
  const corpsByKind: { [kind: string]: number } = {};
  let activeCorps = 0;

  for (const { kind, corp } of census) {
    const creepCount = corpCreepCount(corp);
    // ACTUAL body of this corp's live creeps (measured), or empty when it owns
    // none - never a reconstruction from planned rates.
    const body = perCorpBody.get(corp.id) ?? emptyBody();
    corps.push({
      id: corp.id,
      kind,
      type: corp.type,
      nodeId: corp.nodeId || "",
      roomName: corpRoomName(corp),
      creepCount,
      bodyParts: body.total,
      body: body.byPart,
      sizing: corp.lastSizing,
      createdAt: corp.createdAt,
      lastActivityTick: corp.lastActivityTick
    });
    corpsByKind[kind] = (corpsByKind[kind] || 0) + 1;
    if (creepCount > 0) activeCorps++;
  }

  const telemetry: CorpsTelemetry = {
    version: 10, // Version 10: construction pool/crew stamp (poolHead, crewAt, blind-head gate) 2026-07-30
    tick: Game.time,
    corps,
    summary: {
      totalCorps: corps.length,
      activeCorps,
      corpsByKind
    }
  };

  RawMemory.segments[TELEMETRY_SEGMENTS.CORPS] = JSON.stringify(telemetry);
}
