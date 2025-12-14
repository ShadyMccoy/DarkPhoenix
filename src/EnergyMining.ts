import { RoomRoutine } from "./RoomProgram";
import { SourceMine } from "./SourceMine";

export class EnergyMining extends RoomRoutine {
    name = 'energy mining';
    private sourceMine!: SourceMine;
    private lastEnergyHarvested: number = 0;

    constructor(pos: RoomPosition) {
        super(pos, { harvester: [] });

        // Define what this routine needs to operate
        this.requirements = [
            { type: 'work', size: 2 },   // 2 WORK parts per harvester
            { type: 'move', size: 1 },   // 1 MOVE part per harvester
            { type: 'spawn_time', size: 150 } // Spawn cost in ticks
        ];

        // Define what this routine produces
        this.outputs = [
            { type: 'energy', size: 10 }  // ~10 energy/tick with 2 WORK parts
        ];
    }

    /**
     * Calculate expected value based on source capacity and harvester efficiency.
     */
    protected calculateExpectedValue(): number {
        if (!this.sourceMine) return 0;

        // Each WORK part harvests 2 energy/tick
        // With 2 WORK parts per harvester and potential for multiple harvesters
        const workParts = this.creepIds['harvester'].length * 2;
        const energyPerTick = workParts * 2;

        // Cost is spawn energy (200 for [WORK, WORK, MOVE])
        const spawnCost = this.creepIds['harvester'].length * 200;

        // Value is energy harvested minus amortized spawn cost
        // Assuming creep lives 1500 ticks, amortize spawn cost
        const amortizedCost = spawnCost / 1500;

        return energyPerTick - amortizedCost;
    }

    routine(room: Room): void {
        if (!this.sourceMine) { return; }

        let source = Game.getObjectById(this.sourceMine.sourceId);
        if (source == null) { return; }

        this.HarvestAssignedEnergySource();
        this.createConstructionSiteOnEnergyPiles();
    }

    calcSpawnQueue(room: Room): void {
        this.spawnQueue = [];

        if (!this.sourceMine || !this.sourceMine.HarvestPositions) { return; }

        let spawns = room.find(FIND_MY_SPAWNS);
        let spawn = spawns[0];
        if (spawn == undefined) return;

        if (this.creepIds['harvester'].length < this.sourceMine.HarvestPositions.length) {
            this.spawnQueue.push({
                body: [WORK, WORK, MOVE],
                pos: spawn.pos,
                role: "harvester"
            });
        }
    }

    serialize(): any {
        return {
            name: this.name,
            position: this.position,
            creepIds: this.creepIds,
            sourceMine: this.sourceMine
        };
    }

    deserialize(data: any): void {
        super.deserialize(data);
        this.sourceMine = data.sourceMine;
    }

    setSourceMine(sourceMine: SourceMine) {
        this.sourceMine = sourceMine;
    }

    private createConstructionSiteOnEnergyPiles() {
        _.forEach(this.sourceMine.HarvestPositions.slice(0, 2), (harvestPos) => {
            let pos = new RoomPosition(harvestPos.x, harvestPos.y, harvestPos.roomName);
            let structures = pos.lookFor(LOOK_STRUCTURES);
            let containers = structures.filter(s => s.structureType == STRUCTURE_CONTAINER);
            if (containers.length == 0) {

                let energyPile = pos.lookFor(LOOK_ENERGY).filter(e => e.amount > 500);

                if (energyPile.length > 0) {

                    let constructionSites = pos.lookFor(LOOK_CONSTRUCTION_SITES).filter(s => s.structureType == STRUCTURE_CONTAINER);
                    if (constructionSites.length == 0) {
                        pos.createConstructionSite(STRUCTURE_CONTAINER);
                    }
                }
            }
        });
    }

    private HarvestAssignedEnergySource() {
        let source = Game.getObjectById(this.sourceMine.sourceId);
        if (source == null) { return; }

        for (let p = 0; p < this.sourceMine.HarvestPositions.length; p++) {
            let pos = this.sourceMine.HarvestPositions[p];
            HarvestPosAssignedEnergySource(Game.getObjectById(this.creepIds['harvester']?.[p]), source, pos);
        };
    }
}

function HarvestPosAssignedEnergySource(creep: Creep | null, source: Source | null, destination: RoomPosition | null) {
    if (creep == null) { return; }
    if (source == null) { return; }
    if (destination == null) { return; }

    creep.say('harvest op');

    new RoomVisual(creep.room.name).line(creep.pos, destination);
    creep.moveTo(new RoomPosition(destination.x, destination.y, destination.roomName), { maxOps: 50 });

    creep.harvest(source);
}
