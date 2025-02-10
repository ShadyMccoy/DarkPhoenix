export class Node {
    public id: string; // Unique identifier for the node
    public position: RoomPosition; // Position of the node in the room
    public assets: any[]; // Array to hold any assets associated with the node
    public memory: any; // Local memory for the node's state
    public height: number; // Height of the node
    public territory: RoomPosition[]; // Tiles assigned to this node
    public connections?: string[];

    constructor(id: string, position: RoomPosition, height: number, assets: any[] = []) {
        this.id = id;
        this.position = position;
        this.height = height; // Initialize height
        this.assets = assets;
        this.memory = {}; // Initialize local memory
        this.territory = []; // Initialize territory
        this.connections = []; // Initialize connections if needed
    }

    // Method for local planning logic
    public localPlan(): void {
        console.log(`Node ${this.id} at ${this.position} is planning locally.`);
    }

    // Method to update local memory
    public updateMemory(key: string, value: any): void {
        this.memory[key] = value;
    }

    // Method to retrieve local memory
    public getMemory(key: string): any {
        return this.memory[key];
    }

    // Add a stub run method so that Colony can call it
    public run(): void {
        // TODO: Implement actual node behavior
        console.log(`Running node ${this.id}`);
    }
}
