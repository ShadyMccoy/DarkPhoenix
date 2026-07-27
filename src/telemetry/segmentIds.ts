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
  FLOW: 6 // Flow economy: sources, sinks, allocations
};

/**
 * Segments to make publicly readable via API.
 */
export const PUBLIC_SEGMENTS = [0, 1, 2, 3, 4, 5, 6];
