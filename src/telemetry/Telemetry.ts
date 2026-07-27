/**
 * @fileoverview Telemetry orchestrator for exporting game data to RawMemory segments.
 *
 * This module drives the telemetry write each tick (or periodically), enabling
 * an external app to poll the Screeps HTTP API and visualize colony state.
 *
 * Charter (spec 35 phase H): the ONE update entry point + segment dispatch.
 * Each segment's shape and writer lives in its own module (below); the spawn
 * meter's accumulator (which must run EVERY observed tick, before the interval
 * gate) lives in telemetry/spawnMeter; shared census/body measurement in
 * telemetry/bodyCensus; segment numbers in telemetry/segmentIds. This module
 * re-exports the whole public surface so importers keep one path.
 *
 * ## Segment Layout
 * - Segment 0: Core telemetry (colony stats, creep census, spawn meter, agenda
 *   mirror) - telemetry/coreSegment
 * - Segment 1: Node data (territories, resources, expansion scoring) -
 *   telemetry/spatialSegments
 * - Segment 2: Edge data (spatial node adjacency) - telemetry/spatialSegments
 * - Segment 3: Room intel data (scouted room information) - telemetry/intelSegment
 * - Segment 4: Corps data (per-corp census, bodies, sizing records) -
 *   telemetry/corpsSegment
 * - Segment 6: Flow economy (sources, sinks, allocations) - telemetry/flowSegment
 *
 * (Segment 5 is the BlackBox flight recorder, written by telemetry/BlackBox.)
 *
 * ## Data Flow
 * Screeps Game → RawMemory.segments[N] → HTTP API → External App → Dashboard
 *
 * Layer: telemetry orchestrator (Game-coupled; the writers do the RawMemory
 * serialization). The emitted segment bytes are a frozen external contract.
 *
 * @module telemetry/Telemetry
 */

import { Colony } from "../colony/Colony";
import { FlowSolution } from "../flow/FlowTypes";
import { PUBLIC_SEGMENTS } from "./segmentIds";
import { aggregateActualBodies, CorpCensusEntry } from "./bodyCensus";
import { meterSpawns } from "./spawnMeter";
import { updateCoreTelemetry } from "./coreSegment";
import { updateNodesTelemetry, updateEdgesTelemetry } from "./spatialSegments";
import { updateIntelTelemetry } from "./intelSegment";
import { updateCorpsTelemetry } from "./corpsSegment";
import { updateFlowTelemetry } from "./flowSegment";

// The frozen public surface: the phase-H split moved each piece to its own
// module; this facade re-exports them so every importer (index.ts, tests,
// scripts) keeps the one telemetry/Telemetry path it always had.
export { TELEMETRY_SEGMENTS, PUBLIC_SEGMENTS } from "./segmentIds";
export { classifySpawnIdle } from "./spawnMeter";
export type { SpawnIdleCause } from "./spawnMeter";
export type { CorpCensusEntry, BodyAggregate } from "./bodyCensus";
export type { CoreTelemetry } from "./coreSegment";
export type { NodeTelemetry, EdgesTelemetry } from "./spatialSegments";
export type { IntelTelemetry } from "./intelSegment";
export type { CorpsTelemetry } from "./corpsSegment";
export type { FlowTelemetry } from "./flowSegment";

/**
 * Telemetry configuration.
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;
  /** Tick interval for full telemetry update (0 = every tick) */
  updateInterval: number;
  /** Tick interval for terrain update (expensive, should be infrequent) */
  terrainInterval: number;
}

/**
 * Default telemetry configuration.
 */
export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  updateInterval: 1, // Every tick for core data
  terrainInterval: 1000 // Every 1000 ticks for terrain (rarely changes)
};

/**
 * Telemetry system for exporting game data to RawMemory segments.
 */
export class Telemetry {
  private config: TelemetryConfig;

  public constructor(config: Partial<TelemetryConfig> = {}) {
    this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
  }

  /**
   * Updates all telemetry data in RawMemory segments.
   * Call this from the main game loop.
   */
  public update(colony: Colony | undefined, census: CorpCensusEntry[], flowSolution?: FlowSolution): void {
    if (!this.config.enabled) return;

    // Set public segments for API access
    RawMemory.setPublicSegments(PUBLIC_SEGMENTS);

    // Request segments we'll be writing to
    RawMemory.setActiveSegments(PUBLIC_SEGMENTS);

    // Spawn meter accumulates EVERY observed tick, before the interval gate -
    // sampling busy state on an interval would systematically undercount.
    meterSpawns();

    // Check if we should update based on interval
    const shouldUpdate = this.config.updateInterval === 0 || Game.time % this.config.updateInterval === 0;

    if (!shouldUpdate) return;

    // Measure ACTUAL bodies once (single pass over Game.creeps); core wants the
    // colony total, corps wants the per-corp breakdown.
    const bodies = aggregateActualBodies();

    // Update core telemetry (always)
    updateCoreTelemetry(colony, census, bodies.colony);

    // Update nodes telemetry
    updateNodesTelemetry(colony);

    // Update edges telemetry (segment 2)
    updateEdgesTelemetry(colony);

    // Update intel telemetry
    updateIntelTelemetry();

    // Update corps telemetry
    updateCorpsTelemetry(census, bodies.perCorp);

    // Update flow telemetry (sources, sinks, allocations)
    updateFlowTelemetry(flowSolution);
  }
}

/**
 * Global telemetry instance.
 */
let telemetryInstance: Telemetry | null = null;

/**
 * Gets or creates the global telemetry instance.
 */
export function getTelemetry(config?: Partial<TelemetryConfig>): Telemetry {
  if (!telemetryInstance) {
    telemetryInstance = new Telemetry(config);
  }
  return telemetryInstance;
}

/**
 * Reconfigures telemetry with new settings.
 */
export function configureTelemetry(config: Partial<TelemetryConfig>): void {
  telemetryInstance = new Telemetry(config);
}
