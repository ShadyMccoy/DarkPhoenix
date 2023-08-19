interface SourceMine {}
interface EnergyRoute {}

interface RoomMemory {
    sourceMines : SourceMine[];
    energyRoutes : EnergyRoute[];
}

interface CreepMemory {
    role? : string;
}
