import { NodeAgentRoutine, RoutineMemory } from "./NodeAgentRoutine";

interface EnergyCarryingMemory extends RoutineMemory {
    carrierAssignments: {
        [creepId: string]: {
            task: 'pickup' | 'deliver' | 'idle';
            targetId?: Id<any>;
        };
    };
    currentFlow: number;
    requiredFlow: number;
}

type EnergyStructure = StructureSpawn | StructureExtension | StructureStorage;

export class EnergyCarrying extends NodeAgentRoutine {
    initialize(): void {
        this.saveToMemory({
            efficiency: 0,
            initialized: false,
            carrierAssignments: {},
            currentFlow: 0,
            requiredFlow: 0
        } as EnergyCarryingMemory);

        // Register initial carrier requirement
        this.node.addRequirement({
            type: 'carrier',
            amount: 0,  // Will be calculated based on energy flow
            priority: 80
        });
    }

    run(): void {
        const memory = this.memory as EnergyCarryingMemory;

        this.updateCarrierAssignments();
        this.processCarriers();
        this.updateEfficiencyStats();
    }

    private updateCarrierAssignments(): void {
        const memory = this.memory as EnergyCarryingMemory;

        // Clean up dead carriers
        for (const creepId in memory.carrierAssignments) {
            const assignment = memory.carrierAssignments[creepId];
            if (assignment.targetId && !Game.getObjectById(assignment.targetId)) {
                assignment.task = 'idle';
                assignment.targetId = undefined;
            }
        }

        // Update carrier requirements
        const requiredCarriers = Object.keys(memory.carrierAssignments).length;
        this.node.addRequirement({
            type: 'carrier',
            amount: requiredCarriers,
            priority: 80
        });
    }

    private processCarriers(): void {
        const memory = this.memory as EnergyCarryingMemory;
        let totalEnergyMoved = 0;

        for (const creepId in memory.carrierAssignments) {
            const assignment = memory.carrierAssignments[creepId];
            const carrier = Game.getObjectById(creepId as Id<Creep>);
            if (!carrier) continue;

            if (assignment.task === 'pickup') {
                // Find nearest pickup point
                const pickup = carrier.pos.findClosestByPath(FIND_DROPPED_RESOURCES);
                if (pickup) {
                    if (carrier.pos.isNearTo(pickup)) {
                        const amount = Math.min(
                            carrier.store.getFreeCapacity(RESOURCE_ENERGY),
                            pickup.amount
                        );
                        if (carrier.pickup(pickup) === OK) {
                            totalEnergyMoved += amount;
                        }
                    } else {
                        carrier.moveTo(pickup);
                    }
                }
            } else if (assignment.task === 'deliver') {
                // Find nearest dropoff point
                const dropoff = carrier.pos.findClosestByPath<EnergyStructure>(FIND_MY_STRUCTURES, {
                    filter: (s): s is EnergyStructure =>
                        (s.structureType === STRUCTURE_SPAWN ||
                         s.structureType === STRUCTURE_EXTENSION) &&
                        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                });

                if (dropoff) {
                    if (carrier.pos.isNearTo(dropoff)) {
                        const amount = Math.min(
                            carrier.store[RESOURCE_ENERGY],
                            dropoff.store.getFreeCapacity(RESOURCE_ENERGY)
                        );
                        if (carrier.transfer(dropoff, RESOURCE_ENERGY) === OK) {
                            totalEnergyMoved += amount;
                        }
                    } else {
                        carrier.moveTo(dropoff);
                    }
                }
            }
        }

        memory.currentFlow = totalEnergyMoved;
        this.saveToMemory(memory);
    }

    private updateEfficiencyStats(): void {
        const memory = this.memory as EnergyCarryingMemory;
        const efficiency = memory.currentFlow > 0 ? memory.currentFlow / memory.requiredFlow : 0;
        this.updateEfficiency(efficiency);
    }
}
