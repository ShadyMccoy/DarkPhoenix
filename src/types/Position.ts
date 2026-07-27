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
export function parseRoomName(roomName: string): { x: number; y: number } | null {
  const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
  if (!match) return null;

  const x = match[1] === "W" ? -parseInt(match[2], 10) : parseInt(match[2], 10);
  const y = match[3] === "N" ? parseInt(match[4], 10) : -parseInt(match[4], 10);

  return { x, y };
}
