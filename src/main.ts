import { Construction } from "Construction";
import { EnergyMining } from "EnergyMining";
import { RoomRoutine } from "RoomProgram";
import { Bootstrap } from "bootstrap";
import { forEach, sortBy } from "lodash";
import { ErrorMapper } from "utils/ErrorMapper";
import { RoomMap } from "RoomMap";

declare global {
  // Syntax for adding proprties to `global` (ex "global.log")
  namespace NodeJS {
    interface Global {
      log: any;
    }
  }
}

export const loop = ErrorMapper.wrapLoop(() => {
  console.log(`Current game tick is ${Game.time}`);

  _.forEach(Game.rooms, (room) => {
    const routines = getRoomRoutines(room);

    _.forEach(routines, (routineList, routineType) => {
      _.forEach(routineList, (routine) => routine.runRoutine(room));
      room.memory.routines[routineType] = _.map(routineList, (routine) => routine.serialize());
    });

    new RoomMap(room);
  });

  // Clean up memory
  _.forIn(Memory.creeps, (_, name) => {
    if (!Game.creeps[name]) delete Memory.creeps[name];
  });
});


function getRoomRoutines(room: Room): { [routineType: string]: RoomRoutine[] } {
  if (!room.controller) return {};

  // Initialize routines if not present
  if (!room.memory.routines) {
    room.memory.routines = {
      bootstrap: [new Bootstrap(room.controller.pos).serialize()],
      energyMines: _.map(room.find(FIND_SOURCES), (source) => initEnergyMiningFromSource(source).serialize()),
      construction: _.map(room.find(FIND_MY_CONSTRUCTION_SITES), (site) => new Construction(site.id).serialize())
    };
  }

  // Filter out invalid construction sites
  room.memory.routines.construction = _.filter(room.memory.routines.construction, (memRoutine) =>
    Game.getObjectById(memRoutine.constructionSiteId) != null
  );

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

  const spawns = _.sortBy(source.room.find(FIND_MY_SPAWNS), (s) => s.pos.findPathTo(source.pos).length);

  const m = new EnergyMining(source.pos);
  m.setSourceMine({
    sourceId: source.id,
    HarvestPositions: _.sortBy(harvestPositions, (h) => h.getRangeTo(spawns[0])),
    distanceToSpawn: spawns[0].pos.findPathTo(source.pos).length,
    flow: 10
  });

  return m;
}


//////
/*
if (!room.memory.constructionSites) { room.memory.constructionSites = [] as ConstructionSiteStruct[]; }

let sites = room.memory.constructionSites as ConstructionSiteStruct[];
sites = _.filter(sites, (site) => {
    return Game.getObjectById(site.id) != null;
});

if (sites.length == 0) {
    let s = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (s.length == 0) { return; }

    room.memory.constructionSites.push({ id: s[0].id, Builders: [] as Id<Creep>[] });
}

if (sites.length == 0) { return; }

forEach(sites, (s) => {



  ////

  calculateConstructionSites(room: Room) {
    let constructionSites = room.find(FIND_MY_CONSTRUCTION_SITES);
    forEach(constructionSites, (site) => {
        if (!any(room.memory.constructionSites, (s) => { return s.id == site.id })) {
            let newSite = {
                id: site.id,
                Builders: [] as Id<Creep>[]
            } as ConstructionSiteStruct;
            room.memory.constructionSites.push(newSite);
        }
    });
}

*/

