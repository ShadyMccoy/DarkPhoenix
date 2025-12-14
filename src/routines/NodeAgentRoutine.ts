import { Node } from "../Node";

export interface RoutineMemory {
  initialized: boolean;
  assets?: { type: string; size: number }[]; // New field for storing assets
  expectedValue?: number; // New field for storing expected value
  performanceHistory?: {
    tick: number;
    expectedValue: number;
    actualValue: number;
    cost: number;
  }[];
  // Routine-specific memory fields
  targetSource?: Id<Source>;
  targetStorage?: Id<StructureStorage | StructureContainer>;
  targetController?: Id<StructureController>;
  targetConstructionSite?: Id<ConstructionSite>;
}

export abstract class NodeAgentRoutine {
  protected node: Node;
  protected memory: RoutineMemory;
  protected requirements: { type: string; size: number }[] = [];
  protected outputs: { type: string; size: number }[] = [];
  protected expectedValue = 0;

  constructor(node: Node) {
    this.node = node;
    this.memory = {
      initialized: false,
      assets: [], // Initialize assets array
      performanceHistory: [] // Initialize performance history
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
      throw new Error("Assets must be set before running routine");
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
  public getRequirements(): { type: string; size: number }[] {
    return this.requirements;
  }

  public getOutputs(): { type: string; size: number }[] {
    return this.outputs;
  }

  // Add method to set assets
  public setAssets(assets: { type: string; size: number }[]): void {
    if (!this.memory.assets) {
      this.memory.assets = [];
    }
    this.memory.assets = assets;
  }

  // Add method to get assets
  public getAssets(): { type: string; size: number }[] {
    return this.memory.assets || [];
  }

  // Add method to calculate and set expected value
  protected abstract calculateExpectedValue(): number;

  public getExpectedValue(): number {
    return this.expectedValue;
  }

  // Performance tracking
  protected recordPerformance(actualValue: number, cost: number): void {
    if (!this.memory.performanceHistory) {
      this.memory.performanceHistory = [];
    }

    this.memory.performanceHistory.push({
      tick: Game.time,
      expectedValue: this.expectedValue,
      actualValue,
      cost
    });

    // Keep only last 100 entries
    if (this.memory.performanceHistory.length > 100) {
      this.memory.performanceHistory = this.memory.performanceHistory.slice(-100);
    }

    // Report to colony for ROI tracking
    this.reportToColony(actualValue, cost);
  }

  private reportToColony(actualValue: number, cost: number): void {
    // Find the colony this routine belongs to
    for (const colony of Object.values(Memory.colonies || {})) {
      if (colony.nodeIds.includes(this.node.id)) {
        // This is a simplified approach - in practice you'd need a better way to find the colony
        // For now, we'll assume the colony tracks this through other means
        break;
      }
    }
  }

  public getAverageROI(): number {
    if (!this.memory.performanceHistory || this.memory.performanceHistory.length === 0) {
      return 0;
    }

    const totalROI = this.memory.performanceHistory.reduce((sum, record) => {
      const roi = (record.actualValue - record.cost) / record.cost;
      return sum + roi;
    }, 0);

    return totalROI / this.memory.performanceHistory.length;
  }

  public isInitialized(): boolean {
    return this.memory.initialized;
  }

  // Market participation methods
  public getMarketBuyOrders(): Array<{ resourceType: string; quantity: number; maxPrice: number }> {
    // Routines can override this to specify what they want to buy
    return [];
  }

  public getMarketSellOrders(): Array<{ resourceType: string; quantity: number; minPrice: number }> {
    // Routines can override this to specify what they want to sell
    return [];
  }

  public canProvideResource(resourceType: string, quantity: number): boolean {
    // Check if this routine can provide the requested resource
    const outputs = this.getOutputs();
    const relevantOutput = outputs.find(output => output.type === resourceType);
    return relevantOutput ? relevantOutput.size >= quantity : false;
  }

  public canConsumeResource(resourceType: string, quantity: number): boolean {
    // Check if this routine can consume the requested resource
    const requirements = this.getRequirements();
    const relevantRequirement = requirements.find(req => req.type === resourceType);
    return relevantRequirement ? relevantRequirement.size >= quantity : false;
  }

  public getResourceValue(resourceType: string): number {
    // Get the market value of resources this routine produces or consumes
    // This would be overridden by specific routines
    return 0;
  }
}
