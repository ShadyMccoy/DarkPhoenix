import { forEach, keys, sortBy } from "lodash";

export function RoomProgram(room: Room, routines: RoomRoutine[]) {
  forEach(routines, (routine) => {
    routine.RemoveDeadCreeps();
    routine.AddNewlySpawnedCreeps(room);
    routine.SpawnCreeps(room);
    routine.routine(room);
  });
}

export abstract class RoomRoutine {
  name!: string;
  position: RoomPosition;

  constructor(pos: RoomPosition) {
      this.position = pos;
    }

  spawnQueue!:
    {
      body: BodyPartConstant[],
      pos: RoomPosition,
      role: string
    }[];

  creepIds!: {
    [role: string]: Id<Creep>[];
  };

  serialize(): string {
    return JSON.stringify({
      name: this.name,
      position: this.position,
      creepIds: this.creepIds
    });
  }

  deserialize(serialized: string): void {
    let data = JSON.parse(serialized);
    this.name = data.name;
    this.position = new RoomPosition(data.position.x, data.position.y, data.position.roomName);
    this.creepIds = data.creepIds;
  }

  runRoutine(room: Room) : void {
    this.RemoveDeadCreeps();
    this.calcSpawnQueue(room);
    this.AddNewlySpawnedCreeps(room);
    this.SpawnCreeps(room);
    this.routine(room);
  }

  abstract routine(room: Room): void;
  abstract calcSpawnQueue(room: Room): void;

  RemoveDeadCreeps(): void {
    forEach(keys(this.creepIds), (role) => {
      this.creepIds[role] = _.filter(this.creepIds[role], (creepId: Id<Creep>) => {
        return Game.getObjectById(creepId) != null;
      });
    });
  }

  AddNewlySpawnedCreeps(room: Room): void {
    if (this.spawnQueue.length == 0) return;

    forEach(keys(this.creepIds), (role) => {
      let idleCreeps = room.find(FIND_MY_CREEPS, {
        filter: (creep) => {
          return creep.memory.role == role && !creep.spawning;
        }
      });

      if (idleCreeps.length == 0) { return }

      let closestIdleCreep = sortBy(idleCreeps, (creep) => {
        return creep.pos.getRangeTo(this.position);
      })[0];

      this.AddNewlySpawnedCreep(role, closestIdleCreep);
    });
  }

  AddNewlySpawnedCreep(role: string, creep :  Creep ): void {
      this.creepIds[role].push(creep.id);
      creep.memory.role = "busy" + role;
  }

  SpawnCreeps(room: Room): void {
      if (this.spawnQueue.length == 0) return;

      let spawns = room.find(FIND_MY_SPAWNS, { filter: spawn => !spawn.spawning });
      if (spawns.length == 0) return;

      spawns = sortBy(spawns, spawn => this.position.findPathTo(spawn).length);
      let spawn = spawns[0];

      spawn.spawnCreep(
        this.spawnQueue[0].body,
        spawn.name + Game.time,
        { memory: { role: this.spawnQueue[0].role } }) == OK;
  }
}
