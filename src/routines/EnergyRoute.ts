import { NodeAgentRoutine, RoutineMemory } from "./NodeAgentRoutine";

interface RoutePoint {
    nodeId: string;
    pos: RoomPosition;
    type: 'source' | 'destination';
}

interface CarrierAssignment {
    creepId: Id<Creep>;
    currentTask: 'pickup' | 'deliver' | 'idle';
    targetNodeId?: string;
}

interface EnergyRouteMemory extends RoutineMemory {
    sourceNodeId: string;
    destinationNodeId: string;
    path: RoomPosition[];
    requiredAmount: number;
    currentFlow: number;
    carrierAssignments: { [creepId: string]: CarrierAssignment };
    lastPathUpdate: number;
    efficiency: number;
    initialized: boolean;
}

export class EnergyRoute extends NodeAgentRoutine {
    private readonly PATH_UPDATE_FREQUENCY = 100;  // Update path every 100 ticks

    initialize(): void {
        this.saveToMemory({
            efficiency: 0,
            initialized: false,
            sourceNodeId: '',
            destinationNodeId: '',
            path: [],
            requiredAmount: 0,
            currentFlow: 0,
            carrierAssignments: {},
            lastPathUpdate: 0
        } as EnergyRouteMemory);

        // Initial carrier requirement (will be adjusted based on distance and flow)
        this.node.addRequirement({
            type: 'carrier',
            amount: 0,
            priority: 80
        });
    }

    setRoute(sourceNodeId: string, destinationNodeId: string, requiredAmount: number): void {
        const memory = this.memory as EnergyRouteMemory;
        memory.sourceNodeId = sourceNodeId;
        memory.destinationNodeId = destinationNodeId;
        memory.requiredAmount = requiredAmount;
        memory.lastPathUpdate = 0;  // Force path update
        this.saveToMemory(memory);
    }

    run(): void {
        const memory = this.memory as EnergyRouteMemory;

        if (!memory.sourceNodeId || !memory.destinationNodeId) {
            return;
        }

        this.updatePath();
        this.cleanupCarriers();
        this.calculateRequiredCarriers();
        this.processCarriers();
        this.monitorFlow();
        this.updateRouteEfficiency();
    }

    private updatePath(): void {
        const memory = this.memory as EnergyRouteMemory;

        if (Game.time - memory.lastPathUpdate < this.PATH_UPDATE_FREQUENCY) {
            return;
        }

        // Get source and destination positions from node messages
        const sourcePos = this.getNodePosition(memory.sourceNodeId);
        const destPos = this.getNodePosition(memory.destinationNodeId);

        if (!sourcePos || !destPos) {
            console.log(`EnergyRoute: Cannot find positions for route ${memory.sourceNodeId} -> ${memory.destinationNodeId}`);
            return;
        }

        // Calculate optimal path
        const path = this.calculatePath(sourcePos, destPos);
        if (path) {
            memory.path = path;
            memory.lastPathUpdate = Game.time;
            this.saveToMemory(memory);
        }
    }

    private calculatePath(start: RoomPosition, end: RoomPosition): RoomPosition[] {
        const result = PathFinder.search(start, { pos: end, range: 1 }, {
            plainCost: 2,
            swampCost: 10,
            roomCallback: (roomName) => {
                // Add custom path costs here if needed
                return new PathFinder.CostMatrix;
            }
        });

        return result.path;
    }

    private cleanupCarriers(): void {
        const memory = this.memory as EnergyRouteMemory;
        const newAssignments: typeof memory.carrierAssignments = {};

        for (const [creepId, assignment] of Object.entries(memory.carrierAssignments)) {
            if (Game.getObjectById(creepId as Id<Creep>)) {
                newAssignments[creepId] = assignment;
            }
        }

        memory.carrierAssignments = newAssignments;
        this.saveToMemory(memory);
    }

    private calculateRequiredCarriers(): void {
        const memory = this.memory as EnergyRouteMemory;

        if (!memory.path.length) return;

        // Calculate based on path length and required flow
        const pathLength = memory.path.length;
        const roundTripTime = pathLength * 2;  // Time for full trip
        const carryCapacity = CARRY_CAPACITY * 2;  // Assume work parts

        const requiredCarriers = Math.ceil(
            (memory.requiredAmount * roundTripTime) / (carryCapacity * CREEP_LIFE_TIME)
        );

        // Update carrier requirement
        const requirement = this.node.getRequirements().find(r => r.type === 'carrier');
        if (requirement) {
            requirement.amount = requiredCarriers;
        }
    }

    private processCarriers(): void {
        const memory = this.memory as EnergyRouteMemory;
        let totalTransferred = 0;

        for (const [creepId, assignment] of Object.entries(memory.carrierAssignments)) {
            const creep = Game.getObjectById(creepId as Id<Creep>);
            if (!creep) continue;

            if (assignment.currentTask === 'pickup') {
                const result = this.handlePickup(creep, memory.sourceNodeId);
                if (result) {
                    assignment.currentTask = 'deliver';
                    assignment.targetNodeId = memory.destinationNodeId;
                }
            } else if (assignment.currentTask === 'deliver') {
                const result = this.handleDelivery(creep, memory.destinationNodeId);
                if (result) {
                    totalTransferred += creep.store.getCapacity(RESOURCE_ENERGY);
                    assignment.currentTask = 'pickup';
                    assignment.targetNodeId = memory.sourceNodeId;
                }
            }
        }

        memory.currentFlow = totalTransferred;
        this.saveToMemory(memory);
    }

    private handlePickup(creep: Creep, nodeId: string): boolean {
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            return true;
        }

        return false;
    }

    private handleDelivery(creep: Creep, nodeId: string): boolean {
        if (creep.store[RESOURCE_ENERGY] === 0) {
            return true;
        }

        return false;
    }

    private monitorFlow(): void {
        const memory = this.memory as EnergyRouteMemory;

    }

    private updateRouteEfficiency(): void {
        const memory = this.memory as EnergyRouteMemory;

        // Calculate efficiency based on actual vs required flow
        const efficiency = memory.requiredAmount > 0 ?
            memory.currentFlow / memory.requiredAmount : 0;

        this.updateEfficiency(efficiency);
    }

    private getNodePosition(nodeId: string): RoomPosition | null {
        // This would need to be implemented based on how node positions are stored/accessed
        // For now, return null as placeholder
        return null;
    }
}
