/**
 * @fileoverview Energy logistics route types.
 *
 * Defines the data structures for energy transportation routes
 * used by carrier creeps to move resources between locations.
 *
 * @module types/EnergyRoute
 */

/**
 * A waypoint in an energy transportation route.
 *
 * Waypoints define stops along a route where carriers
 * pick up or drop off resources.
 */
export interface RouteWaypoint {
  /** X coordinate in the room */
  x: number;
  /** Y coordinate in the room */
  y: number;
  /** Room name */
  roomName: string;
  /**
   * Whether this waypoint is a surplus (pickup) point.
   * - true: Carriers pick up energy here
   * - false: Carriers deliver energy here
   */
  surplus: boolean;
}

/**
 * A carrier assignment on a route.
 *
 * Tracks which creep is assigned to a route and their
 * current progress along the waypoints.
 */
export interface CarrierAssignment {
  /** Unique identifier of the assigned carrier creep */
  creepId: Id<Creep>;
  /** Index of the waypoint the carrier is currently traveling to */
  waypointIdx: number;
}

/**
 * An energy transportation route.
 *
 * Routes define the path carriers take to move energy from
 * production sites (harvesters) to consumption sites (spawn, extensions).
 *
 * @example
 * const route: EnergyRoute = {
 *   waypoints: [
 *     { x: 24, y: 25, roomName: 'W1N1', surplus: true },  // Source
 *     { x: 25, y: 25, roomName: 'W1N1', surplus: false }  // Spawn
 *   ],
 *   Carriers: [{ creepId: '5bbcac21' as Id<Creep>, waypointIdx: 0 }]
 * };
 */
export interface EnergyRoute {
  /**
   * Ordered list of waypoints defining the route.
   * Carriers cycle through waypoints: 0 -> 1 -> ... -> n -> 0
   */
  waypoints: RouteWaypoint[];

  /** Carriers currently assigned to this route */
  Carriers: CarrierAssignment[];
}
