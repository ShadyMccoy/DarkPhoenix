// Augment Screeps global types (ambient declaration)
interface RoomMemory {
    routines: {
        [routineType: string]: any[];
    };
    worldGraph?: any;
    world?: any;
}

interface CreepMemory {
    role?: string;
}
