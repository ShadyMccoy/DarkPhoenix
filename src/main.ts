import { EnergyMining } from "EnergyMining";
import { RoomRoutine } from "RoomProgram";
import { Bootstrap } from "bootstrap";
import { forEach, sortBy } from "lodash";
import { ErrorMapper } from "utils/ErrorMapper";

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

  forEach(Game.rooms, (room) => {
    let routines = getRoomRoutines(room);

    room.memory.routines = {};

    _.keys(routines).forEach((routineType) => {
      _.forEach(routines[routineType], (routine) => {
        routine.runRoutine(room);
      });
    });

    _.keys(routines).forEach((routineType) => {
      room.memory.routines[routineType] = _.map(routines[routineType], (routine) => routine.serialize())
    });

  });

  // Automatically delete memory of missing creeps
  for (const name in Memory.creeps) {
    if (!(name in Game.creeps)) {
      delete Memory.creeps[name];
    }
  }
});


function getRoomRoutines(room: Room): { [routineType: string]: RoomRoutine[] } {
  if (!room.controller) { return {}; }

  if (room.memory?.routines?.bootstrap == null || room.memory?.routines?.bootstrap.length == 0) {
    room.memory.routines = {
      bootstrap: [new Bootstrap(room.controller?.pos).serialize()]
    };
  }


  if (room.memory?.routines?.energyMines == null || room.memory?.routines?.energyMines.length == 0) {
    let energySources = room.find(FIND_SOURCES);
    let mines = _.map(energySources, (source) => initEnergyMiningFromSource(source));

    room.memory.routines.energyMines = _.map(mines, (m) => JSON.stringify(m));
  };

  console.log(`room.memory.routiness: ${JSON.stringify(room.memory.routines)}`);
  let routines = {
    bootstrap: _.map(room.memory.routines.bootstrap, (memRoutine) => {
      let b = new Bootstrap(room.controller!.pos);
      b.deserialize(memRoutine);
      return b;
    }),
    energyMines: _.map(room.memory.routines.energyMines, (memRoutine) => {
      let m = new EnergyMining(room.controller!.pos);
      m.deserialize(memRoutine);
      return m;
    })
  };

  console.log(`routines2: ${JSON.stringify(routines)}`);
  return routines;
}

function findMines(room: Room) {
  let energySources = room.find(FIND_SOURCES);
  let mines: SourceMine[] = [];

  forEach(energySources, (source) => {
    let s = initEnergyMiningFromSource(source);
    mines.push(s);
  });

  room.memory.sourceMines = mines;
}


function initEnergyMiningFromSource(source: Source): EnergyMining {
  let adjacentPositions = source.room.lookForAtArea(
    LOOK_TERRAIN,
    source.pos.y - 1,
    source.pos.x - 1,
    source.pos.y + 1,
    source.pos.x + 1, true);

  let harvestPositions: RoomPosition[] = [];

  forEach(adjacentPositions, (pos) => {
    if (pos.terrain == "plain" || pos.terrain == "swamp") {
      harvestPositions.push(new RoomPosition(pos.x, pos.y, source.room.name))
    }
  });

  let spawns = source.room.find(FIND_MY_SPAWNS);
  spawns = _.sortBy(spawns, s => s.pos.findPathTo(source.pos).length);

  let m = new EnergyMining(source.pos);
  m.setSourceMine({
    sourceId: source.id,
    HarvestPositions: sortBy(harvestPositions, (h) => {
      return h.getRangeTo(spawns[0]);
    }),
    distanceToSpawn: spawns[0].pos.findPathTo(source.pos).length,
    flow: 10
  });

  return m;
}
