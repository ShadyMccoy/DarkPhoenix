/**
 * @fileoverview Error mapping and handling utilities.
 *
 * Provides wrapped function execution with error logging
 * for better debugging in the Screeps environment.
 *
 * @module utils/ErrorMapper
 */

import { record } from "../telemetry/BlackBox";

/**
 * Error handling utilities for the game loop.
 *
 * Wraps functions to catch and log errors without crashing
 * the entire game loop.
 *
 * @example
 * export const loop = ErrorMapper.wrapLoop(() => {
 *   // Game logic here
 * });
 */
export const ErrorMapper = {
  /**
   * Wraps a function to catch and log any errors.
   *
   * Errors are logged to console with stack traces when available.
   * The wrapped function continues to run on subsequent ticks.
   *
   * @param fn - Function to wrap
   * @returns Wrapped function with error handling
   */
  wrapLoop<T extends (...args: any[]) => unknown>(fn: T): T {
    return ((...args: any[]) => {
      try {
        return fn(...args);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (e instanceof Error) {
          console.error(`Error in loop: ${e.message}\n${e.stack ?? ""}`);
        } else {
          console.error(`Error in loop: ${String(e)}`);
        }
        // Flight recorder: a caught loop error is exactly what the incident
        // pipeline needs context for (spec 09 phase 4).
        record("err", { phase: "loop", msg });
      }
    }) as unknown as T;
  }
};
