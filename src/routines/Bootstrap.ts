import { NodeAgentRoutine, RoutineMemory } from "./NodeAgentRoutine";

interface BootstrapMemory extends RoutineMemory {
    phase: BootstrapPhase;
    minersSpawned: number;
    carriersSpawned: number;
    upgraderSpawned: boolean;
    spawnId?: Id<StructureSpawn>;
    controllerId?: Id<StructureController>;
}

enum BootstrapPhase {
    INIT = 'init',           // Initial assessment
    SPAWN_MINERS = 'miners', // Get initial mining operation running
    CARRIERS = 'carriers',   // Establish energy transport
    UPGRADE = 'upgrade',     // Start controller upgrading
    COMPLETE = 'complete'    // Bootstrap complete
}

export class Bootstrap extends NodeAgentRoutine {
    initialize(): void {
        this.saveToMemory({
            efficiency: 0,
            initialized: false,
            phase: BootstrapPhase.INIT,
            minersSpawned: 0,
            carriersSpawned: 0,
            upgraderSpawned: false
        } as BootstrapMemory);

        // Find critical structures
        const room = Game.rooms[this.node.position.roomName];
        if (!room) return;

        const spawn = this.node.position.findClosestByRange(FIND_MY_SPAWNS);
        const controller = room.controller;

        if (spawn) {
            (this.memory as BootstrapMemory).spawnId = spawn.id;
        }
        if (controller) {
            (this.memory as BootstrapMemory).controllerId = controller.id;
        }

        // Initial requirements
        this.node.addRequirement({
            type: 'miner',
            amount: 1,
            priority: 100  // Highest priority during bootstrap
        });
    }

    run(): void {
        const memory = this.memory as BootstrapMemory;
        const room = Game.rooms[this.node.position.roomName];
        if (!room) return;

        const spawn = memory.spawnId ? Game.getObjectById(memory.spawnId) : null;
        const controller = memory.controllerId ? Game.getObjectById(memory.controllerId) : null;

        if (!spawn || !controller) {
            console.log('Bootstrap: Critical structures not found');
            return;
        }

        switch (memory.phase) {
            case BootstrapPhase.INIT:
                this.handleInitPhase(room);
                break;
            case BootstrapPhase.SPAWN_MINERS:
                this.handleMinerPhase(room);
                break;
            case BootstrapPhase.CARRIERS:
                this.handleCarrierPhase(room);
                break;
            case BootstrapPhase.UPGRADE:
                this.handleUpgradePhase(room);
                break;
            case BootstrapPhase.COMPLETE:
                this.handleCompletePhase();
                break;
        }

        this.updateBootstrapEfficiency();
    }

    private handleInitPhase(room: Room): void {
        const memory = this.memory as BootstrapMemory;

        // Basic room assessment
        const sources = room.find(FIND_SOURCES);
        const availableEnergy = room.energyAvailable;
        const maxEnergy = room.energyCapacityAvailable;

        if (availableEnergy >= 200) {  // Minimum cost for a basic worker
            memory.phase = BootstrapPhase.SPAWN_MINERS;
            this.saveToMemory(memory);
        }
    }

    private handleMinerPhase(room: Room): void {
        const memory = this.memory as BootstrapMemory;
        const miners = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.role === 'miner'
        });

        // Check if we have enough miners
        if (miners.length >= 2) {  // Assuming 2 miners is enough for bootstrap
            memory.phase = BootstrapPhase.CARRIERS;

            // Add carrier requirement
            this.node.addRequirement({
                type: 'carrier',
                amount: 2,
                priority: 95
            });

            this.saveToMemory(memory);
            return;
        }

        // Request additional miners if needed
        const minerReq = this.node.getRequirements().find(r => r.type === 'miner');
        if (minerReq) {
            minerReq.amount = 2 - miners.length;
        }
    }

    private handleCarrierPhase(room: Room): void {
        const memory = this.memory as BootstrapMemory;
        const carriers = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.role === 'carrier'
        });

        if (carriers.length >= 2) {  // Basic energy transport established
            memory.phase = BootstrapPhase.UPGRADE;

            // Add upgrader requirement
            this.node.addRequirement({
                type: 'upgrader',
                amount: 1,
                priority: 90
            });

            this.saveToMemory(memory);
            return;
        }
    }

    private handleUpgradePhase(room: Room): void {
        const memory = this.memory as BootstrapMemory;
        const upgraders = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.role === 'upgrader'
        });

        if (upgraders.length > 0 && room.controller?.level === 2) {
            memory.phase = BootstrapPhase.COMPLETE;
            this.saveToMemory(memory);
            return;
        }
    }

    private handleCompletePhase(): void {

    }

    private updateBootstrapEfficiency(): void {
        const memory = this.memory as BootstrapMemory;

        // Calculate bootstrap efficiency based on phase completion and room state
        let efficiency = 0;
        switch (memory.phase) {
            case BootstrapPhase.INIT:
                efficiency = 0.1;
                break;
            case BootstrapPhase.SPAWN_MINERS:
                efficiency = 0.3;
                break;
            case BootstrapPhase.CARRIERS:
                efficiency = 0.5;
                break;
            case BootstrapPhase.UPGRADE:
                efficiency = 0.8;
                break;
            case BootstrapPhase.COMPLETE:
                efficiency = 1.0;
                break;
        }

        this.updateEfficiency(efficiency);
    }
}
