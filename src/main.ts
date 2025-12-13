import { Construction } from "./Construction"
import { EnergyMining } from "./EnergyMining";
import { RoomRoutine } from "./RoomProgram";
import { Bootstrap } from "./bootstrap";
import { ErrorMapper } from "./ErrorMapper";
import { RoomMap } from "./RoomMap";

declare global {
  namespace NodeJS {
    interface Global {
      log: any;
    }
  }
}

// Cache for room maps to avoid recalculating every tick
const roomMapCache: { [roomName: string]: { map: RoomMap, tick: number } } = {};
const ROOM_MAP_CACHE_TTL = 100; // Recalculate every 100 ticks

export const loop = ErrorMapper.wrapLoop(() => {
  _.forEach(Game.rooms, (room) => {
    if (!room.memory.routines) {
      room.memory.routines = {};
    }

    const routines = getRoomRoutines(room);

    _.forEach(routines, (routineList, routineType) => {
      // Filter out completed construction routines
      const activeRoutines = routineType === 'construction'
        ? _.filter(routineList, (r) => !(r as Construction).isComplete)
        : routineList;

      _.forEach(activeRoutines, (routine) => routine.runRoutine(room));

      if (routineType) {
        room.memory.routines[routineType] = _.map(activeRoutines, (routine) => routine.serialize());
      }
    });

    // Only recalculate room map periodically
    const cached = roomMapCache[room.name];
    if (!cached || Game.time - cached.tick > ROOM_MAP_CACHE_TTL) {
      roomMapCache[room.name] = { map: new RoomMap(room), tick: Game.time };
    }
  });

  // Clean up memory
  _.forIn(Memory.creeps, (_, name) => {
    if (name && !Game.creeps[name]) {
      delete Memory.creeps[name];
    }
  });
});


function getRoomRoutines(room: Room): { [routineType: string]: RoomRoutine[] } {
  if (!room.controller) return {};

  // Initialize room.memory.routines if not present
  if (!room.memory.routines) {
    room.memory.routines = {};
  }

  // Sync routines with the current state of the room
  if (!room.memory.routines.bootstrap) {
    room.memory.routines.bootstrap = [new Bootstrap(room.controller.pos).serialize()];
  }

  // Sync energy mines with current sources
  const currentSources = room.find(FIND_SOURCES);
  const existingSourceIds = _.map(room.memory.routines.energyMines || [], (m) => m.sourceId);
  const newSources = _.filter(currentSources, (source) => !existingSourceIds.includes(source.id));

  if (newSources.length > 0 || !room.memory.routines.energyMines) {
    room.memory.routines.energyMines = _.map(currentSources, (source) => initEnergyMiningFromSource(source).serialize());
  }

  // Sync construction sites
  const currentSites = room.find(FIND_MY_CONSTRUCTION_SITES);
  const existingSiteIds = _.map(room.memory.routines.construction || [], (c) => c.constructionSiteId);
  const newSites = _.filter(currentSites, (site) => !existingSiteIds.includes(site.id));

  if (newSites.length > 0 || !room.memory.routines.construction) {
    room.memory.routines.construction = _.map(currentSites, (site) => new Construction(site.id).serialize());
  }

  // Deserialize routines
  return {
    bootstrap: _.map(room.memory.routines.bootstrap, (memRoutine) => {
      const b = new Bootstrap(room.controller!.pos);
      b.deserialize(memRoutine);
      return b;
    }),
    energyMines: _.map(room.memory.routines.energyMines, (memRoutine) => {
      const m = new EnergyMining(room.controller!.pos);
      m.deserialize(memRoutine);
      return m;
    }),
    construction: _.map(room.memory.routines.construction, (memRoutine) => {
      const c = new Construction(memRoutine.constructionSiteId);
      c.deserialize(memRoutine);
      return c;
    })
  };
}

function initEnergyMiningFromSource(source: Source): EnergyMining {
  const harvestPositions = _.filter(
    source.room.lookForAtArea(LOOK_TERRAIN, source.pos.y - 1, source.pos.x - 1, source.pos.y + 1, source.pos.x + 1, true),
    (pos) => pos.terrain === "plain" || pos.terrain === "swamp"
  ).map((pos) => new RoomPosition(pos.x, pos.y, source.room.name));

  const spawns = source.room.find(FIND_MY_SPAWNS);
  if (spawns.length === 0) {
    const m = new EnergyMining(source.pos);
    m.setSourceMine({
      sourceId: source.id,
      HarvestPositions: harvestPositions,
      distanceToSpawn: 0,
      flow: 10
    });
    return m;
  }

  // Sort spawns by range (cheaper than pathfinding)
  const sortedSpawns = _.sortBy(spawns, (s) => s.pos.getRangeTo(source.pos));
  const closestSpawn = sortedSpawns[0];

  const m = new EnergyMining(source.pos);
  m.setSourceMine({
    sourceId: source.id,
    HarvestPositions: _.sortBy(harvestPositions, (h) => h.getRangeTo(closestSpawn)),
    distanceToSpawn: closestSpawn.pos.getRangeTo(source.pos),
    flow: 10
  });

  return m;
}

