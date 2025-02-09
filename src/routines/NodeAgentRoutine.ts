import { Node } from "../Node";

export interface RoutineMemory {
    initialized: boolean;
    assets?: { type: string, size: number }[];  // New field for storing assets
    expectedValue?: number;  // New field for storing expected value
}


export abstract class NodeAgentRoutine {
    protected node: Node;
    protected memory: RoutineMemory;
    protected requirements: { type: string, size: number }[] = [];
    protected outputs: { type: string, size: number }[] = [];
    protected expectedValue: number = 0;

    constructor(node: Node) {
        this.node = node;
        this.memory = {
            initialized: false,
            assets: []  // Initialize assets array
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

        // Ensure assets are available before running routine
        if (!this.memory.assets || this.memory.assets.length === 0) {
            throw new Error('Assets must be set before running routine');
        }

        this.expectedValue = this.calculateExpectedValue();
        this.memory.expectedValue = this.expectedValue;

        this.run();
    }

    // Memory management
    protected saveToMemory(memory: RoutineMemory): void {
        this.memory = memory;
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

    // Add getter methods to access the collections
    public getRequirements(): { type: string, size: number }[] {
        return this.requirements;
    }

    public getOutputs(): { type: string, size: number }[] {
        return this.outputs;
    }

    // Add method to set assets
    public setAssets(assets: { type: string, size: number }[]): void {
        if (!this.memory.assets) {
            this.memory.assets = [];
        }
        this.memory.assets = assets;
    }

    // Add method to get assets
    public getAssets(): { type: string, size: number }[] {
        return this.memory.assets || [];
    }

    // Add method to calculate and set expected value
    protected abstract calculateExpectedValue(): number;

    public getExpectedValue(): number {
        return this.expectedValue;
    }

    public isInitialized(): boolean {
        return this.memory.initialized;
    }
}
