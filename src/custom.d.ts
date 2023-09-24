interface SourceMine {}
interface EnergyRoute {}

interface ConstructionSiteStruct {
    id: Id<ConstructionSite<BuildableStructureConstant>>;
    Builders: Id<Creep>[];
}

interface RoomMemory {
    sourceMines : SourceMine[];
    energyRoutes : EnergyRoute[];
    constructionSites : ConstructionSiteStruct[];
    routines : {
        [routineType : string] : string[];
    };
}

interface CreepMemory {
    role? : string;
}
