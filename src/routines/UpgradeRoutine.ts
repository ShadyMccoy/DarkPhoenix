import { Node } from "../Node";
import { NodeAgentRoutine } from "./NodeAgentRoutine";

export class UpgradeRoutine extends NodeAgentRoutine {
  constructor(node: Node) {
    super(node);
    this.requirements = [
      { type: "work", size: 1 },
      { type: "carry", size: 1 },
      { type: "move", size: 1 }
    ];
    this.outputs = [
      { type: "control_points", size: 1 }
    ];
  }

  initialize(): void {
    // Find controller in node territory
    const controllers = this.node.territory.flatMap(pos => {
      const room = Game.rooms[pos.roomName];
      if (!room || !room.controller) return [];
      return room.controller.pos.getRangeTo(pos) <= 3 ? [room.controller] : [];
    });

    if (controllers.length > 0) {
      this.memory.targetController = controllers[0].id;
    }
  }

  run(): void {
    const creep = this.getAssignedCreep();
    if (!creep) return;

    const controller = this.memory.targetController ?
      Game.getObjectById(this.memory.targetController) as StructureController : null;
    if (!controller) return;

    // Upgrade controller if we have energy
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
        creep.moveTo(controller);
      } else {
        // Successfully upgraded
        this.recordPerformance(1, 0); // 1 control point gained
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
    return 1; // 1 control point per tick
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
