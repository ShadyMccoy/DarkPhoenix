/**
 * @fileoverview Segment-number assignments for the telemetry export.
 *
 * Charter: the ONE table mapping telemetry data families to RawMemory segment
 * numbers, shared by every segment writer (telemetry/coreSegment,
 * spatialSegments, intelSegment, corpsSegment, flowSegment) and the
 * orchestrator (telemetry/Telemetry). Constants only - no Game access, no
 * behavior. The external telemetry app polls these segment numbers over the
 * Screeps HTTP API, so the assignments are part of the frozen external
 * contract: never renumber.
 *
 * (Segment 5 is the BlackBox flight recorder, written by telemetry/BlackBox.)
 *
 * Layer: shared constants (leaf module - imports nothing).
 *
 * @module telemetry/segmentIds
 */

/**
 * Segment assignments for telemetry data.
 */
export const TELEMETRY_SEGMENTS = {
  CORE: 0, // Colony stats, creep census, spawn meter
  NODES: 1, // Node territories, resources, expansion scoring
  EDGES: 2, // Spatial node adjacency
  INTEL: 3, // Room intel from scouting
  CORPS: 4, // Corps details
  FLOW: 6, // Flow economy: sources, sinks, allocations
  HAUL_TRACE: 7, // Per-tick flight recorder for ONE hauler (telemetry/HaulTrace)
  FISCAL: 8, // Month-boundary accounting archive, part 1 (telemetry/fiscalArchive)
  FISCAL2: 9 // ...part 2. The archive is sharded: one segment holds ~13 months.
};

/**
 * Segments to make publicly readable via API.
 *
 * ALL TEN active-segment slots the engine allows (`RawMemory.setActiveSegments`
 * caps at 10). There is no margin left: a new telemetry family must RETIRE one,
 * and the honest candidate is 7 (haulTrace, a single-hauler debug recorder) -
 * never this list silently growing past the cap, which fails the write.
 */
export const PUBLIC_SEGMENTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
