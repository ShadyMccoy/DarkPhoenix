/**
 * @fileoverview Error mapping and handling utilities.
 *
 * Provides wrapped function execution with error logging
 * for better debugging in the Screeps environment.
 *
 * @module utils/ErrorMapper
 */

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
  wrapLoop<T extends Function>(fn: T): T {
    return ((...args: any[]) => {
      try {
        return fn(...args);
      } catch (e) {
        if (e instanceof Error) {
          console.error(`Error in loop: ${e.message}\n${e.stack}`);
        } else {
          console.error(`Error in loop: ${e}`);
        }
      }
    }) as unknown as T;
  },
};
