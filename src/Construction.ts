import { RoomRoutine } from "./RoomProgram";

export class Construction extends RoomRoutine {
    name = "construction";
    private _constructionSiteId: Id<ConstructionSite>;
    private _isComplete: boolean;

    constructor(constructionSiteId: Id<ConstructionSite>, position?: RoomPosition) {
        const site = Game.getObjectById(constructionSiteId);
        const pos = position || site?.pos || new RoomPosition(25, 25, "sim");

        super(pos, { builder: [] });

        this._constructionSiteId = constructionSiteId;
        this._isComplete = !site && !position;
    }

    get constructionSiteId(): Id<ConstructionSite> {
        return this._constructionSiteId;
    }

    get isComplete(): boolean {
        return this._isComplete || Game.getObjectById(this._constructionSiteId) == null;
    }

    routine(room: Room): void {
        if (this.isComplete) { return; }
        this.BuildConstructionSite();
    }

    serialize(): any {
        return {
            name: this.name,
            position: this.position,
            creepIds: this.creepIds,
            constructionSiteId: this._constructionSiteId
        };
    }

    deserialize(data: any): void {
        super.deserialize(data);
        this._constructionSiteId = data.constructionSiteId;
    }

    calcSpawnQueue(room: Room): void {
        this.spawnQueue = [];

        if (this.isComplete) { return; }

        if (this.creepIds.builder.length == 0) {
            this.spawnQueue.push({
                body: [WORK, CARRY, MOVE],
                pos: this.position,
                role: "builder"
            });
        }
    }

    BuildConstructionSite() {
        let constructionSite = Game.getObjectById(this._constructionSiteId);
        if (constructionSite == null) {
            this._isComplete = true;
            return;
        }

        let builderIds = this.creepIds['builder'];
        if (builderIds == undefined || builderIds.length == 0) { return; }

        let builders = builderIds
            .map((id) => Game.getObjectById(id))
            .filter((builder): builder is Creep => builder != null);

        if (builders.length == 0) { return; }
        let builder = builders[0];

        if (builder.store.energy == 0) {
            if (this.pickupEnergyPile(builder)) { return; }
        }

        if (builder.pos.getRangeTo(constructionSite.pos) > 3) {
            builder.moveTo(constructionSite.pos);
        } else {
            builder.build(constructionSite);
        }
    }

    pickupEnergyPile(creep: Creep): boolean {
        let droppedEnergies = creep.room.find(FIND_DROPPED_RESOURCES, {
            filter: (resource) => resource.resourceType == RESOURCE_ENERGY && resource.amount > 50
        });

        if (droppedEnergies.length == 0) return false;

        let sortedEnergies = _.sortBy(droppedEnergies, e => creep.pos.getRangeTo(e.pos));
        let e = sortedEnergies[0];

        creep.say('pickup energy');
        new RoomVisual(creep.room.name).line(creep.pos.x, creep.pos.y, e.pos.x, e.pos.y);

        creep.moveTo(e, { maxOps: 50, range: 1 });
        creep.pickup(e);

        return true;
    }
}
