import { RoomRoutine } from "RoomProgram";
import { SourceMine } from "SourceMine";

export class EnergyMining extends RoomRoutine {
    name = 'energy mining';
    private sourceMine!: SourceMine

    constructor(pos: RoomPosition) {
        super(pos, { harvester: [] });
     }

    routine(room: Room): void {
        console.log('energy mining');
        if (this.sourceMine == undefined) { return; }

        let source = Game.getObjectById(this.sourceMine.sourceId);
        if (source == null) { return; }
        this.HarvestAssignedEnergySource();
    }

    calcSpawnQueue(room: Room): void {
        let spawns = room.find(FIND_MY_SPAWNS);
        let spawn = spawns[0];
        if (spawn == undefined) return;

        this.spawnQueue = [];

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
        console.log('deserialize energy mining ' +JSON.stringify(data));
        super.deserialize(data);
        this.sourceMine = data.sourceMine;
    }

    setSourceMine(sourceMine: SourceMine) {
        this.sourceMine = sourceMine;
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
