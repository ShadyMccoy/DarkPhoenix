import { Node } from "../Node";
import { NodeAgentRoutine } from "./NodeAgentRoutine";

export class TransportRoutine extends NodeAgentRoutine {
  constructor(node: Node) {
    super(node);
    this.requirements = [
      { type: "carry", size: 2 },
      { type: "move", size: 2 }
    ];
    this.outputs = [
      { type: "energy_transport", size: 50 }
    ];
  }

  initialize(): void {
    // Find energy sources and storage locations in node territory
    const sources = this.node.territory.flatMap(pos => {
      const room = Game.rooms[pos.roomName];
      if (!room) return [];
      return room.lookForAt(LOOK_SOURCES, pos.x, pos.y);
    });

    const storage = this.node.territory.flatMap(pos => {
      const room = Game.rooms[pos.roomName];
      if (!room) return [];
      return room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y)
        .filter(s => s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER);
    });

    if (sources.length > 0 && storage.length > 0) {
      this.memory.targetSource = sources[0].id;
      this.memory.targetStorage = (storage[0] as StructureStorage | StructureContainer).id;
    }
  }

  run(): void {
    const creep = this.getAssignedCreep();
    if (!creep) return;

    // Transport energy from source area to storage
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      // Pick up energy from ground or containers near source
      if (this.memory.targetSource) {
        const source = Game.getObjectById(this.memory.targetSource) as Source | null;
        if (source) {
          const droppedEnergy = source.pos.findInRange(FIND_DROPPED_RESOURCES, 2)
            .filter((r: Resource) => r.resourceType === RESOURCE_ENERGY);

          if (droppedEnergy.length > 0) {
            if (creep.pickup(droppedEnergy[0]) === ERR_NOT_IN_RANGE) {
              creep.moveTo(droppedEnergy[0]);
            }
          } else {
            // Wait for energy to be dropped
            creep.moveTo(source.pos);
          }
        }
      }
    } else {
      // Deliver energy to storage
      if (this.memory.targetStorage) {
        const storage = Game.getObjectById(this.memory.targetStorage) as StructureStorage | StructureContainer | null;
        if (storage) {
          if (creep.transfer(storage as any, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(storage);
          } else {
            // Successfully delivered energy
            this.recordPerformance(creep.store.getUsedCapacity(RESOURCE_ENERGY), 0);
          }
        }
      }
    }
  }

  protected calculateExpectedValue(): number {
    // Expected value based on transport capacity and distance
    return 50; // 50 energy transported per tick
  }

  private getAssignedCreep(): Creep | null {
    // This would need to be implemented to find the assigned creep
    // For now, return null
    return null;
  }
}
