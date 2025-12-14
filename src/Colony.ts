import { RoomGeography } from "./RoomGeography";
import { Node } from "./Node";
import { ColonyMemory } from "./types/Colony";
import { MarketSystem } from "./MarketSystem";

export class Colony {
  private roomGeography: RoomGeography;
  public nodes: { [id: string]: Node };
  public memory: ColonyMemory;
  public id: string;
  public rootRoom: Room;
  public marketSystem: MarketSystem;

  constructor(rootRoom: Room, colonyId?: string) {
    this.rootRoom = rootRoom;
    this.nodes = {};
    this.roomGeography = new RoomGeography(this.nodes);
    if (colonyId && Memory.colonies[colonyId]) {
      this.memory = this.migrateColonyMemory(Memory.colonies[colonyId]);
      this.id = colonyId;
    } else {
      this.memory = this.initializeColonyMemory(rootRoom);
      this.id = this.memory.id;
    }

    // Initialize market system
    this.marketSystem = new MarketSystem(this.memory, this.nodes);
  }

  private createAndCheckAdjacentNodes(room: Room, distanceThreshold: number): void {
    const nodeIds = Object.keys(Memory.nodeNetwork?.nodes || {});
    const roomPosition = room.controller?.pos;

    const nearbyNodeIds = nodeIds.filter(nodeId => {
      const nodeData = Memory.nodeNetwork.nodes[nodeId];
      const nodePosition = new RoomPosition(nodeData.pos.x, nodeData.pos.y, nodeData.pos.roomName);
      const distance = roomPosition?.getRangeTo(nodePosition) || Infinity;
      return distance <= distanceThreshold;
    });

    for (const nodeId of nearbyNodeIds) {
      if (!this.memory.nodeIds.includes(nodeId)) {
        const nodeData = Memory.nodeNetwork.nodes[nodeId];
        const nodePosition = new RoomPosition(nodeData.pos.x, nodeData.pos.y, nodeData.pos.roomName);
        const node = new Node(nodeId, nodePosition, nodeData.height);
        this.nodes[nodeId] = node;
        this.memory.nodeIds.push(nodeId);
      }
    }

    RoomGeography.pruneEdges(this.roomGeography.getEdges(), this.nodes);
  }

  private initializeColonyMemory(rootRoom: Room): ColonyMemory {
    const colonyId = `colony-${rootRoom.name}-${Game.time}`;

    if (!Memory.colonies) Memory.colonies = {};

    if (!Memory.colonies[colonyId]) {
      Memory.colonies[colonyId] = {
        id: colonyId,
        rootRoomName: rootRoom.name,
        roomNames: [rootRoom.name],
        nodeIds: [],
        energyLedger: {
          income: 0,
          expenses: 0,
          net: 0,
          lastUpdate: Game.time
        },
        roiMetrics: {},
        actionQueue: [],
        screepsBucks: 100, // Starting currency
        marketPrices: {},
        marketOrders: [],
        currentPlan: null,
        lastPlanUpdate: Game.time
      };
    }

    return Memory.colonies[colonyId];
  }

  private migrateColonyMemory(existingMemory: any): ColonyMemory {
    // Migrate old colony memory to new format
    const migrated: ColonyMemory = {
      id: existingMemory.id,
      rootRoomName: existingMemory.rootRoomName,
      roomNames: existingMemory.roomNames || [existingMemory.rootRoomName],
      nodeIds: existingMemory.nodeIds || [],
      energyLedger: existingMemory.energyLedger || {
        income: 0,
        expenses: 0,
        net: 0,
        lastUpdate: Game.time
      },
      roiMetrics: existingMemory.roiMetrics || {},
      actionQueue: existingMemory.actionQueue || [],
      screepsBucks: existingMemory.screepsBucks || 100,
      marketPrices: existingMemory.marketPrices || {},
      marketOrders: existingMemory.marketOrders || [],
      currentPlan: existingMemory.currentPlan || null,
      lastPlanUpdate: existingMemory.lastPlanUpdate || Game.time
    };

    // Update the memory in place
    Memory.colonies[existingMemory.id] = migrated;
    return migrated;
  }

  run(): void {
    this.checkNewRooms();
    this.runNodes();
    this.updateColonyConnectivity();
    this.processMarketOperations();
    this.updatePlanning();
  }

  private checkNewRooms(): void {
    // Check for connected rooms we have vision of but haven't analyzed
    for (const roomName of this.memory.roomNames) {
      const room = Game.rooms[roomName];
      if (room && !this.hasAnalyzedRoom(room)) {
        RoomGeography.updateNetwork(room);
        this.createAndCheckAdjacentNodes(room, 50);
      }
    }
  }

  private isPointOnLineSegment(start: RoomPosition, end: RoomPosition, point: RoomPosition): boolean {
    const crossProduct = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
    if (Math.abs(crossProduct) > 0.0001) return false; // Not collinear

    const dotProduct = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
    if (dotProduct < 0) return false; // Point is behind the start point

    const squaredLengthBA = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
    if (dotProduct > squaredLengthBA) return false; // Point is beyond the end point

    return true; // Point is on the line segment
  }

  private hasAnalyzedRoom(room: Room): boolean {
    return this.memory.nodeIds.some(nodeId => nodeId.includes(room.name));
  }

  private updateColonyConnectivity(): void {
    // Check if colony has become disconnected
    const connectedNodes = new Set<string>();
    const toExplore = [this.memory.nodeIds[0]];

    while (toExplore.length > 0) {
      const nodeId = toExplore.pop()!;
      if (connectedNodes.has(nodeId)) continue;

      connectedNodes.add(nodeId);
      const connections = RoomGeography.getConnectedNodes(nodeId);

      for (const connectedId of connections) {
        if (this.memory.nodeIds.includes(connectedId)) {
          toExplore.push(connectedId);
        }
      }
    }
  }

  private runNodes(): void {
    for (const nodeId in this.nodes) {
      try {
        this.nodes[nodeId].run();
      } catch (error) {
        console.log(`Error running node in colony`, error);
      }
    }
  }

  private loadExistingNodes(): void {
    if (!Memory.nodeNetwork?.nodes) return;

    for (const [nodeId, nodeData] of Object.entries(Memory.nodeNetwork.nodes)) {
      // Only load nodes in rooms we have vision of
      if (Game.rooms[nodeData.pos.roomName]) {
        const node = new Node(
          nodeId,
          new RoomPosition(nodeData.pos.x, nodeData.pos.y, nodeData.pos.roomName),
          nodeData.height
        );
        this.nodes[nodeId] = node;
      }
    }
  }

  public getEnergyBalance(): number {
    return this.rootRoom.energyAvailable - this.rootRoom.energyCapacityAvailable * 0.5;
  }

  public getTopPriorityAction(): any {
    // Simple prioritization based on energy levels
    if (this.getEnergyBalance() < 0) {
      return { type: 'spawn', routineType: 'harvest', priority: 1.0 };
    } else {
      return { type: 'spawn', routineType: 'upgrade', priority: 0.8 };
    }
  }

  // Resource optimization based on energy balance
  private optimizeResourceAllocation(): void {
    const energyBalance = this.getEnergyBalance();

    // If energy is low, prioritize harvesting
    if (energyBalance < 0) {
      console.log(`Colony ${this.id}: Low energy, prioritizing harvesting`);
    }

    // If energy is high, prioritize upgrading or building
    if (energyBalance > 50) {
      console.log(`Colony ${this.id}: Surplus energy, prioritizing upgrading`);
    }

    // Track basic metrics
    this.updateColonyMetrics();
  }

  private updateColonyMetrics(): void {
    const totalNodes = Object.keys(this.nodes).length;
    const energyEfficiency = this.rootRoom.energyAvailable / Math.max(1, this.rootRoom.energyCapacityAvailable);

    console.log(`Colony ${this.id}: ${totalNodes} nodes, energy efficiency: ${(energyEfficiency * 100).toFixed(1)}%, ScreepsBucks: ${this.marketSystem.getScreepsBucks()}`);
  }

  // Market operations
  private processMarketOperations(): void {
    // Match buy and sell orders
    this.marketSystem.matchOrders();

    // Clean up old fulfilled orders (keep last 50)
    if (this.memory.marketOrders.length > 50) {
      this.memory.marketOrders = this.memory.marketOrders
        .filter(order => !order.fulfilled)
        .concat(this.memory.marketOrders.filter(order => order.fulfilled).slice(-25));
    }
  }

  // Planning system
  private updatePlanning(): void {
    // Update plan every 100 ticks or if no current plan
    if (!this.memory.currentPlan || Game.time - this.memory.lastPlanUpdate > 100) {
      const newPlan = this.marketSystem.generateOptimalPlan();
      if (newPlan) {
        this.memory.currentPlan = newPlan;
        this.memory.lastPlanUpdate = Game.time;
        console.log(`Colony ${this.id}: Generated new plan with ${newPlan.steps.length} steps, expected value: ${newPlan.totalValue} ScreepsBucks`);
      }
    }

    // Execute current plan
    this.executeCurrentPlan();
  }

  private executeCurrentPlan(): void {
    if (!this.memory.currentPlan || this.memory.currentPlan.status !== 'executing') {
      // Start executing plan if it exists
      if (this.memory.currentPlan && this.memory.currentPlan.status === 'pending') {
        this.memory.currentPlan.status = 'executing';
      }
      return;
    }

    // Execute pending steps
    for (const step of this.memory.currentPlan.steps) {
      if (step.status === 'pending') {
        this.executePlanStep(step);
      }
    }

    // Check if plan is complete
    const completedSteps = this.memory.currentPlan.steps.filter(s => s.status === 'completed').length;
    if (completedSteps === this.memory.currentPlan.steps.length) {
      this.memory.currentPlan.status = 'completed';
      console.log(`Colony ${this.id}: Plan completed successfully`);
    }
  }

  private executePlanStep(step: any): void {
    switch (step.type) {
      case 'spawn_routine':
        if (step.routineType && this.nodes[step.nodeId]) {
          // Simplified: just mark as completed for now
          // In full implementation, this would spawn the actual routine
          step.status = 'completed';
          step.endTime = Game.time;
          console.log(`Colony ${this.id}: Executed ${step.routineType} routine spawn at node ${step.nodeId}`);
        }
        break;
      // Add other step types as needed
    }
  }
}
