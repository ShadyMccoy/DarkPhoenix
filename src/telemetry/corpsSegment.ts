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
    /**
     * Sizing stamps of this corp's INTERNAL ENGINES (`Corp.innerCorps`, spec 34
     * D5) - sub-corps that run inside the operation and are never censused on
     * their own. Absent when the corp has none, or none of them stamp.
     *
     * Added 2026-07-31 (production audit t72695674) because the biggest spender
     * in the colony was also the only one with no decision record. The miner
     * operation owns its evacuation haulers, so `mining-*` rows carried 85% of
     * hauler spawn spend (59,150e of 69,750e over one window) while exporting
     * only the MINER's stamp - the rich hauler stamp (routes/carryNeeded/staged/
     * duty) existed at the decision site and died there. Every hauler diagnosis
     * (E6's "read the carry pickup stamps", H1 duty, F1's hauler class) was
     * blind on exactly the corps that dominate the spend, so the route-sizing
     * churn loop had to be reconstructed from the blackbox ring instead of read.
     */
    innerSizing?: { type: string; nodeId: string; sizing: CorpSizingRecord }[];
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
    // Kind-neutral: read the framework's declared internal-engine seam, so a
    // new operation kind's engines export by declaration alone (spec 17).
    const innerSizing = (corp.innerCorps?.() ?? [])
      .filter(inner => inner.lastSizing)
      .map(inner => ({ type: inner.type, nodeId: inner.nodeId || "", sizing: inner.lastSizing as CorpSizingRecord }));
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
      ...(innerSizing.length > 0 ? { innerSizing } : {}),
      createdAt: corp.createdAt,
      lastActivityTick: corp.lastActivityTick
    });
    corpsByKind[kind] = (corpsByKind[kind] || 0) + 1;
    if (creepCount > 0) activeCorps++;
  }

  const telemetry: CorpsTelemetry = {
    version: 13, // Version 13: upgrader sizing stamps fieldedWork (the fleet's real burn capacity vs its headcount) 2026-08-01
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
