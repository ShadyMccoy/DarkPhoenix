/**
 * Position in the game world for location-based calculations.
 * Abstract from Screeps RoomPosition.
 */
export interface Position {
  x: number;
  y: number;
  roomName: string;
}

/**
 * Calculate Manhattan distance between two positions.
 * Returns estimated cross-room distance if in different rooms.
 */
export function manhattanDistance(a: Position, b: Position): number {
  if (a.roomName !== b.roomName) {
    return estimateCrossRoomDistance(a, b);
  }
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Calculate Chebyshev distance (Screeps movement distance).
 * Diagonal movement counts as 1.
 */
export function chebyshevDistance(a: Position, b: Position): number {
  if (a.roomName !== b.roomName) {
    // Cross-room: estimate based on room distance
    const roomDist = estimateRoomDistance(a.roomName, b.roomName);
    return roomDist * 50 + Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Estimate distance between positions in different rooms.
 */
export function estimateCrossRoomDistance(a: Position, b: Position): number {
  const aCoords = parseRoomName(a.roomName);
  const bCoords = parseRoomName(b.roomName);

  if (!aCoords || !bCoords) return Infinity;

  // Each room is 50 tiles, add in-room distances
  const roomDist =
    (Math.abs(aCoords.x - bCoords.x) + Math.abs(aCoords.y - bCoords.y)) * 50;
  const inRoomDist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

  return roomDist + inRoomDist;
}

/**
 * Estimate room distance from room names (in room units, not tiles).
 */
export function estimateRoomDistance(room1: string, room2: string): number {
  const c1 = parseRoomName(room1);
  const c2 = parseRoomName(room2);
  if (!c1 || !c2) return Infinity;
  return Math.max(Math.abs(c1.x - c2.x), Math.abs(c1.y - c2.y));
}

/**
 * Parse room name into coordinates (e.g., "W1N2" -> { x: -1, y: 2 })
 */
export function parseRoomName(
  roomName: string
): { x: number; y: number } | null {
  const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return null;

  const x = match[1] === "W" ? -parseInt(match[2], 10) : parseInt(match[2], 10);
  const y = match[3] === "N" ? parseInt(match[4], 10) : -parseInt(match[4], 10);

  return { x, y };
}
