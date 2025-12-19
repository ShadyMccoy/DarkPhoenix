/**
 * @fileoverview Utilities module exports.
 *
 * This module provides utility functions and helpers.
 *
 * @module utils
 */

export { ErrorMapper } from "./ErrorMapper";

export {
  discoverNearbyRooms,
  getDistanceToOwnedRoom,
  categorizeRoomsByDistance,
  get5x5RoomBox,
  get5x5BoxAroundOwnedRooms,
} from "./RoomDiscovery";
