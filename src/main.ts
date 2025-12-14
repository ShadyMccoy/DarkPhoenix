import { ErrorMapper } from "./ErrorMapper";
import { Colony } from "./Colony";

// Keep track of colony instances between ticks
const activeColonies = new Map<string, Colony>();

// Initialize colonies or create new ones as needed
function manageColonies(): void {
  // Initialize memory structures if needed
  if (!Memory.colonies) Memory.colonies = {};
  if (!Memory.nodeNetwork) Memory.nodeNetwork = { nodes: {}, edges: {} };

  // Clear inactive colonies
  for (const [colonyId, colony] of activeColonies) {
    if (!Memory.colonies[colonyId]) {
      activeColonies.delete(colonyId);
    }
  }

  // Process existing colonies
  for (const colonyData of Object.values(Memory.colonies)) {
    const rootRoom = Game.rooms[colonyData.rootRoomName];
    if (!rootRoom) continue; // Skip if we lost vision of root room

    let colony = activeColonies.get(colonyData.id);
    if (!colony) {
      colony = new Colony(rootRoom, colonyData.id);
      activeColonies.set(colonyData.id, colony);
    }

    try {
      colony.run();
    } catch (error) {
      console.log(`Error running colony ${colonyData.id}:`, error);
    }
  }

  // Create new colonies for unclaimed rooms
  for (const roomName in Game.rooms) {
    const room = Game.rooms[roomName];
    if (!isRoomInColony(room)) {
      try {
        const colony = new Colony(room);
        activeColonies.set(colony.id, colony);
      } catch (error) {
        console.log(`Error creating colony for room ${roomName}:`, error);
      }
    }
  }
}

function isRoomInColony(room: Room): boolean {
  return Object.values(Memory.colonies).some(colony => colony.roomNames.includes(room.name));
}

function cleanupMemory(): void {
  // Clear dead creep memory
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name];
    }
  }

  // Clean up colonies that no longer have any rooms we can see
  const coloniesToDelete: string[] = [];

  for (const colonyId in Memory.colonies) {
    const colony = Memory.colonies[colonyId];
    const hasVisibleRooms = colony.roomNames.some(roomName => Game.rooms[roomName]);

    if (!hasVisibleRooms) {
      coloniesToDelete.push(colonyId);
      activeColonies.delete(colonyId);
    }
  }

  // Delete colonies outside the loop to avoid modification during iteration
  coloniesToDelete.forEach(id => delete Memory.colonies[id]);
}

function logStats(): void {
  if (Game.time % 10 !== 0) return;

  const stats = {
    colonies: activeColonies.size,
    creeps: Object.keys(Game.creeps).length,
    rooms: Object.keys(Game.rooms).length,
    cpu: Game.cpu.getUsed().toFixed(2)
  };

  console.log("Stats:", JSON.stringify(stats));
}

// Main loop
export const loop = ErrorMapper.wrapLoop(() => {
  try {
    // Memory cleanup
    cleanupMemory();

    // Run the colony system
    manageColonies();

    // Log stats periodically
    logStats();
  } catch (error) {
    console.log("Main loop error:", error);
  }
});
