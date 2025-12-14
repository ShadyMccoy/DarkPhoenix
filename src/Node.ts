import { Agent } from "./Agent";

export class Node {
  public id: string;
  public position: RoomPosition; // Position of the node in the room
  public assets: any[]; // Array to hold any assets associated with the node
  public memory: any; // Local memory for the node's state
  public height: number; // Height of the node
  public territory: RoomPosition[]; // Tiles assigned to this node
  public connections?: string[];

  private agents: Agent[] = [];

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
    // Run all agents in this node
    for (const agent of this.agents) {
      try {
        agent.run();
      } catch (error) {
        console.log(`Error running agent in node ${this.id}:`, error);
      }
    }
  }

  // Agent management
  public addAgent(agent: Agent): void {
    this.agents.push(agent);
  }

  public removeAgent(agent: Agent): void {
    this.agents = this.agents.filter(a => a !== agent);
  }

  public getAgents(): Agent[] {
    return this.agents;
  }

  // Resource management
  public getAvailableResources(): { [resourceType: string]: number } {
    // Calculate available resources in node territory
    const resources: { [resourceType: string]: number } = {};

    for (const pos of this.territory) {
      const room = Game.rooms[pos.roomName];
      if (!room) continue;

      // Count energy in storage/containers
      const structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
      for (const structure of structures) {
        if (structure.structureType === STRUCTURE_STORAGE || structure.structureType === STRUCTURE_CONTAINER) {
          const store = (structure as StructureStorage | StructureContainer).store;
          for (const resourceType in store) {
            resources[resourceType] = (resources[resourceType] || 0) + store[resourceType as ResourceConstant];
          }
        }
      }

      // Count dropped resources
      const dropped = room.lookForAt(LOOK_RESOURCES, pos.x, pos.y);
      for (const resource of dropped) {
        resources[resource.resourceType] = (resources[resource.resourceType] || 0) + resource.amount;
      }
    }

    return resources;
  }
}
