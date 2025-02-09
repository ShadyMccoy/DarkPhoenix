import { NodeAgentRoutine, RoutineMemory } from "./NodeAgentRoutine";

interface EnergyMiningMemory extends RoutineMemory {
    sourceId?: Id<Source>;
    minerAssignments: { [posKey: string]: Id<Creep> };
    currentOutput: number;
    maxOutput: number;
}

export class EnergyMining extends NodeAgentRoutine {
    initialize(): void {
        this.saveToMemory({
            efficiency: 0,
            minerAssignments: {},
            currentOutput: 0,
            maxOutput: 0
        } as EnergyMiningMemory);

        // Find closest source in territory
        const source = this.findSource();
        if (source) {
            (this.memory as EnergyMiningMemory).sourceId = source.id;
            this.calculateMaxOutput(source);
        }

        // Register initial miner requirement
        this.node.addRequirement({
            type: 'miner',
            amount: 0,  // Will be calculated based on harvest positions
            priority: 90
        });
    }

    run(): void {
        const memory = this.memory as EnergyMiningMemory;
        if (!memory.sourceId) return;

        const source = Game.getObjectById(memory.sourceId);
        if (!source) return;

        this.updateMinerAssignments();
        this.manageMining(source);
        this.updateEfficiencyStats();
    }

    private findSource(): Source | null {
        // Find source within node's territory
        const pos = this.node.position;
        const sources = pos.findInRange(FIND_SOURCES, 5);
        return sources[0] || null;
    }

    private calculateMaxOutput(source: Source): void {
        const memory = this.memory as EnergyMiningMemory;
        const harvestPositions = this.getHarvestPositions(source);
        memory.maxOutput = SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME * harvestPositions.length;
        this.saveToMemory(memory);
    }

    private getHarvestPositions(source: Source): RoomPosition[] {
        const positions: RoomPosition[] = [];
        const terrain = source.room.getTerrain();

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = source.pos.x + dx;
                const y = source.pos.y + dy;
                if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                    positions.push(new RoomPosition(x, y, source.pos.roomName));
                }
            }
        }

        return positions;
    }

    private updateMinerAssignments(): void {
        const memory = this.memory as EnergyMiningMemory;

        // Clean up dead miners
        for (const posKey in memory.minerAssignments) {
            const minerId = memory.minerAssignments[posKey];
            if (!Game.getObjectById(minerId)) {
                delete memory.minerAssignments[posKey];
            }
        }

        // Update miner requirements
        const source = Game.getObjectById(memory.sourceId!);
        if (!source) return;

        const positions = this.getHarvestPositions(source);
        const requiredMiners = positions.length - Object.keys(memory.minerAssignments).length;

        this.node.addRequirement({
            type: 'miner',
            amount: requiredMiners,
            priority: 90
        });
    }

    private manageMining(source: Source): void {
        const memory = this.memory as EnergyMiningMemory;
        let currentTick = 0;

        // Process each miner
        for (const posKey in memory.minerAssignments) {
            const minerId = memory.minerAssignments[posKey];
            const miner = Game.getObjectById(minerId);

            if (miner && miner.harvest(source) === OK) {
                currentTick += HARVEST_POWER;
            }
        }

        memory.currentOutput = currentTick;
        this.saveToMemory(memory);
    }

    private updateEfficiencyStats(): void {
        const memory = this.memory as EnergyMiningMemory;
        const efficiency = memory.maxOutput > 0 ?
            memory.currentOutput / memory.maxOutput : 0;
        this.updateEfficiency(efficiency);
    }
}
