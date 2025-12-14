import { Node } from "../Node";
import { NodeAgentRoutine } from "./NodeAgentRoutine";

export class BuildRoutine extends NodeAgentRoutine {
  constructor(node: Node) {
    super(node);
    this.requirements = [
      { type: "work", size: 1 },
      { type: "carry", size: 1 },
      { type: "move", size: 1 }
    ];
    this.outputs = [
      { type: "construction_progress", size: 5 }
    ];
  }

  initialize(): void {
    // Find construction sites in node territory
    const sites = this.node.territory.flatMap(pos => {
      const room = Game.rooms[pos.roomName];
      if (!room) return [];
      return room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    });

    if (sites.length > 0) {
      this.memory.targetConstructionSite = sites[0].id;
    }
  }

  run(): void {
    const creep = this.getAssignedCreep();
    if (!creep) return;

    const site = this.memory.targetConstructionSite ?
      Game.getObjectById(this.memory.targetConstructionSite) as ConstructionSite : null;
    if (!site) return;

    // Build if we have energy
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.build(site) === ERR_NOT_IN_RANGE) {
        creep.moveTo(site);
      } else {
        // Successfully built
        this.recordPerformance(5, 0); // 5 construction progress
      }
    } else {
      // Get energy from storage or ground
      const energySources = this.findNearbyEnergy();
      if (energySources.length > 0) {
        const target = energySources[0];
        if (target instanceof Resource) {
          if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target);
          }
        } else if (target instanceof Structure) {
          if (creep.withdraw(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            creep.moveTo(target);
          }
        }
      }
    }
  }

  protected calculateExpectedValue(): number {
    // Expected value based on work parts and distance
    return 5; // 5 construction progress per tick
  }

  private findNearbyEnergy(): (Resource | Structure)[] {
    const creep = this.getAssignedCreep();
    if (!creep) return [];

    // Find dropped energy
    const dropped = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 5)
      .filter((r: Resource) => r.resourceType === RESOURCE_ENERGY);

    // Find storage/containers
    const structures = creep.pos.findInRange(FIND_STRUCTURES, 5)
      .filter((s: Structure) =>
        (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_CONTAINER) &&
        (s as StructureStorage | StructureContainer).store.getUsedCapacity(RESOURCE_ENERGY) > 0
      );

    return [...dropped, ...structures];
  }

  private getAssignedCreep(): Creep | null {
    // This would need to be implemented to find the assigned creep
    return null;
  }
}
