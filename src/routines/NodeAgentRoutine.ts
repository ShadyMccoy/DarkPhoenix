import { NodeRoutine } from "../NodeRoutine";

export interface RoutineMemory {
    efficiency: number;
    initialized: boolean;
}

export abstract class NodeAgentRoutine {
    protected node: NodeRoutine;
    protected memory: RoutineMemory;

    constructor(node: NodeRoutine) {
        this.node = node;
        this.memory = {
            efficiency: 0,
            initialized: false
        };
    }

    abstract initialize(): void;
    abstract run(): void;

    // Core routine lifecycle methods
    process(): void {
        if (!this.memory.initialized) {
            this.initialize();
            this.memory.initialized = true;
        }

        this.run();
        this.reportEfficiency();
    }

    // Memory management
    protected saveToMemory(memory: RoutineMemory): void {
        this.memory = memory;
    }

    // Efficiency reporting
    protected updateEfficiency(value: number): void {
        this.memory.efficiency = value;
    }

    private reportEfficiency(): void {
    }

    // Serialization
    serialize(): any {
        return {
            memory: this.memory
        };
    }

    deserialize(data: any): void {
        this.memory = data.memory;
    }
}
