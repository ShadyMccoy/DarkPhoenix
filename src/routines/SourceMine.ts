import { NodeAgentRoutine, RoutineMemory } from "./NodeAgentRoutine";

interface SourceMineMemory extends RoutineMemory {
    sourceId: Id<Source>;
    harvestPositions: RoomPosition[];
    minerAssignments: { [posKey: string]: Id<Creep> };
    currentOutput: number;
    maxOutput: number;
}

export class SourceMine extends NodeAgentRoutine {
    private source: Source | null = null;

    initialize(): void {
        const source = this.findSource();
        if (!source) {
            console.log(`SourceMine: No source found near ${this.node.position}`);
            return;
        }

        const harvestPositions = this.findHarvestPositions(source);
        const maxOutput = SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME * harvestPositions.length;

        this.saveToMemory({
            efficiency: 0,
            initialized: false,
            sourceId: source.id,
            harvestPositions,
            minerAssignments: {},
            currentOutput: 0,
            maxOutput
        } as SourceMineMemory);

        // Add miner requirements based on harvest positions
        this.node.addRequirement({
            type: 'miner',
            amount: harvestPositions.length,
            priority: 90
        });

        // Register this source's potential output
        this.node.addOutput({
            type: 'energy',
            amount: 0  // Will be updated as miners work
        });
    }

    run(): void {
        const memory = this.memory as SourceMineMemory;
        this.source = Game.getObjectById(memory.sourceId);
        if (!this.source) return;

        this.cleanupDeadMiners();
        this.assignMiners();
        this.processMiners();
        this.updateEfficiencyStats();
    }

    private findSource(): Source | null {
        const room = Game.rooms[this.node.position.roomName];
        if (!room) return null;

        // First try to find a source at our position
        const sourceAtPos = this.node.position.lookFor(LOOK_SOURCES)[0];
        if (sourceAtPos) return sourceAtPos;

        // Otherwise find the nearest source
        return this.node.position.findClosestByPath(
            room.find(FIND_SOURCES)
        );
    }

    private findHarvestPositions(source: Source): RoomPosition[] {
        const positions: RoomPosition[] = [];
        const terrain = source.room.getTerrain();

        // Check all adjacent positions
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;

                const x = source.pos.x + dx;
                const y = source.pos.y + dy;

                if (x < 0 || x > 49 || y < 0 || y > 49) continue;

                if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                    positions.push(new RoomPosition(x, y, source.room.name));
                }
            }
        }

        return positions;
    }

    private cleanupDeadMiners(): void {
        const memory = this.memory as SourceMineMemory;
        const newAssignments: typeof memory.minerAssignments = {};

        for (const [posKey, minerId] of Object.entries(memory.minerAssignments)) {
            if (Game.getObjectById(minerId)) {
                newAssignments[posKey] = minerId;
            }
        }

        memory.minerAssignments = newAssignments;
        this.saveToMemory(memory);
    }

    private assignMiners(): void {
        const memory = this.memory as SourceMineMemory;
        if (!this.source) return;

        // Find all unassigned mining positions
        const unassignedPositions = memory.harvestPositions.filter(pos => {
            const posKey = `${pos.x},${pos.y}`;
            return !memory.minerAssignments[posKey] ||
                   !Game.getObjectById(memory.minerAssignments[posKey]);
        });

        if (unassignedPositions.length === 0) return;

        // Find idle miners
        const room = Game.rooms[this.source.room.name];
        if (!room) return;

        const idleMiners = room.find(FIND_MY_CREEPS, {
            filter: (c): c is Creep =>
                c.memory.role === 'miner' &&
                !c.memory.busy &&
                c.pos.inRangeTo(this.source!.pos, 5)
        });

        // Assign miners to positions
        for (const pos of unassignedPositions) {
            const closestMiner = pos.findClosestByPath(idleMiners);
            if (closestMiner) {
                const posKey = `${pos.x},${pos.y}`;
                memory.minerAssignments[posKey] = closestMiner.id;
                closestMiner.memory.busy = true;
                _.pull(idleMiners, closestMiner);
            }
        }

        this.saveToMemory(memory);
    }

    private processMiners(): void {
        const memory = this.memory as SourceMineMemory;
        if (!this.source) return;

        let totalHarvested = 0;

        // Process each miner assignment
        for (const [posKey, minerId] of Object.entries(memory.minerAssignments)) {
            const miner = Game.getObjectById(minerId);
            if (!miner) continue;

            const [x, y] = posKey.split(',').map(Number);
            const targetPos = new RoomPosition(x, y, this.source.room.name);

            if (!miner.pos.isEqualTo(targetPos)) {
                miner.moveTo(targetPos);
            } else if (this.source.energy > 0) {
                const harvestResult = miner.harvest(this.source);
                if (harvestResult === OK) {
                    totalHarvested += HARVEST_POWER;
                }
            }
        }

        memory.currentOutput = totalHarvested;
        this.updateEfficiency(memory.currentOutput / memory.maxOutput);
        this.saveToMemory(memory);

        // Update node's energy output
        this.node.addOutput({
            type: 'energy',
            amount: memory.currentOutput
        });
    }

    private updateEfficiencyStats(): void {
        const memory = this.memory as SourceMineMemory;

        // Calculate efficiency as current output vs maximum possible output
        const efficiency = memory.maxOutput > 0 ?
            memory.currentOutput / memory.maxOutput : 0;

        this.updateEfficiency(efficiency);
    }
}
