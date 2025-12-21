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
  DEFAULT_ROOM_BOX_RADIUS,
  getRoomBox,
  getRoomBoxAroundOwnedRooms,
  get7x7RoomBox,
  get7x7BoxAroundOwnedRooms,
} from "./RoomDiscovery";
