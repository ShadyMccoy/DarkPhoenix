import { RoomRoutine } from "RoomProgram";

export class Construction extends RoomRoutine {
    name = "construction";

    constructor(readonly constructionSiteId: Id<ConstructionSite>) {
        console.log(`constructionSiteId: ${constructionSiteId}`);

        let site = Game.getObjectById(constructionSiteId);
        if (site == null) { throw new Error("Construction site not found"); }

        super(site.pos, { builder: [] });
    }

    routine(room: Room): void {
        console.log('construction');
        this.BuildConstructionSite();
    }

    serialize(): any {
        return {
            name: this.name,
            position: this.position,
            creepIds: this.creepIds,
            constructionSiteId: this.constructionSiteId
        };
    }

    calcSpawnQueue(room: Room): void {
        if (this.creepIds['builder']?.length == 0) {
            this.spawnQueue.push({
                body: [WORK, CARRY, MOVE],
                pos: this.position,
                role: "builder"
            });
        }
    }

    BuildConstructionSite() {
        let ConstructionSite = Game.getObjectById(this.constructionSiteId);
        if (ConstructionSite == null) { return; }

        let builderIds = this.creepIds['builder'];
        if (builderIds == undefined) { return; }

        let builders = builderIds.map((builder) => {
            return Game.getObjectById(builder)!;
        });

        if (builders.length == 0) { return; }
        let builder = builders[0];

        if (builder.pos.getRangeTo(ConstructionSite.pos) > 3) {
            builder.moveTo(ConstructionSite.pos);
        } else {
            builder.build(ConstructionSite);
        }
    }
}
