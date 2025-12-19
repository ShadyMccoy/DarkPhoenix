/**
 * @fileoverview Telemetry module exports.
 *
 * Provides telemetry functionality for exporting game data to RawMemory segments.
 *
 * @module telemetry
 */

export {
  Telemetry,
  getTelemetry,
  configureTelemetry,
  TELEMETRY_SEGMENTS,
  PUBLIC_SEGMENTS,
  DEFAULT_TELEMETRY_CONFIG,
  type TelemetryConfig,
  type CoreTelemetry,
  type NodeTelemetry,
  type TerrainTelemetry,
  type IntelTelemetry,
  type CorpsTelemetry,
  type ChainsTelemetry,
} from "./Telemetry";
