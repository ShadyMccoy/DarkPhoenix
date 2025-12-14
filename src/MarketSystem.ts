import { ColonyMemory, MarketOrder, ActionPlan, ActionStep } from "./types/Colony";
import { Node } from "./Node";
import { NodeAgentRoutine } from "./routines/NodeAgentRoutine";

export class MarketSystem {
  private colonyMemory: ColonyMemory;
  private nodes: { [id: string]: Node };
  private getTime: () => number;

  constructor(colonyMemory: ColonyMemory, nodes: { [id: string]: Node }, getTime?: () => number) {
    this.colonyMemory = colonyMemory;
    this.nodes = nodes;
    this.getTime = getTime || (() => Game.time);
    this.initializeMarket();
  }

  private initializeMarket(): void {
    // Initialize default market prices
    if (!this.colonyMemory.marketPrices) {
      this.colonyMemory.marketPrices = {
        'energy': 0.1, // 0.1 ScreepsBucks per energy
        'control_points': 1.0, // 1 ScreepsBuck per control point
        'construction_progress': 0.2, // 0.2 ScreepsBucks per construction progress
        'energy_transport': 0.05, // 0.05 ScreepsBucks per energy transported
        'creep_body': 0.5, // 0.5 ScreepsBucks per creep body part
        'controller_access': 2.0, // 2 ScreepsBucks for controller access
        'spawn_access': 1.5 // 1.5 ScreepsBucks for spawn access
      };
    }

    // Initialize ScreepsBucks if not set
    if (this.colonyMemory.screepsBucks === undefined) {
      this.colonyMemory.screepsBucks = 100; // Starting balance
    }

    // Initialize market orders array
    if (!this.colonyMemory.marketOrders) {
      this.colonyMemory.marketOrders = [];
    }
  }

  // Market operations
  public createBuyOrder(resourceType: string, quantity: number, maxPricePerUnit: number, buyerId: string): string {
    const order: MarketOrder = {
      id: `buy_${this.getTime()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'buy',
      resourceType,
      quantity,
      pricePerUnit: maxPricePerUnit,
      buyerId,
      fulfilled: false,
      created: this.getTime()
    };

    this.colonyMemory.marketOrders.push(order);
    return order.id;
  }

  public createSellOrder(resourceType: string, quantity: number, minPricePerUnit: number, sellerId: string): string {
    const order: MarketOrder = {
      id: `sell_${this.getTime()}_${Math.random().toString(36).substr(2, 9)}`,
      type: 'sell',
      resourceType,
      quantity,
      pricePerUnit: minPricePerUnit,
      sellerId,
      fulfilled: false,
      created: this.getTime()
    };

    this.colonyMemory.marketOrders.push(order);
    return order.id;
  }

  public matchOrders(): void {
    const buyOrders = this.colonyMemory.marketOrders.filter((o: MarketOrder) => o.type === 'buy' && !o.fulfilled);
    const sellOrders = this.colonyMemory.marketOrders.filter((o: MarketOrder) => o.type === 'sell' && !o.fulfilled);

    for (const buyOrder of buyOrders) {
      const matchingSell = sellOrders.find((sell: MarketOrder) =>
        sell.resourceType === buyOrder.resourceType &&
        sell.pricePerUnit <= buyOrder.pricePerUnit &&
        !sell.fulfilled
      );

      if (matchingSell) {
        this.executeTrade(buyOrder, matchingSell);
      }
    }
  }

  private executeTrade(buyOrder: MarketOrder, sellOrder: MarketOrder): void {
    const tradeQuantity = Math.min(buyOrder.quantity, sellOrder.quantity);
    const tradePrice = sellOrder.pricePerUnit; // Seller sets the price
    const totalCost = tradeQuantity * tradePrice;

    // Check if colony has enough ScreepsBucks
    if (this.colonyMemory.screepsBucks >= totalCost) {
      // Execute trade
      this.colonyMemory.screepsBucks -= totalCost;

      // Mark orders as fulfilled
      buyOrder.fulfilled = true;
      sellOrder.fulfilled = true;

      console.log(`Market trade executed: ${tradeQuantity} ${buyOrder.resourceType} for ${totalCost} ScreepsBucks`);
    }
  }

  // Planning system using A* search
  public generateOptimalPlan(): ActionPlan | null {
    const startState = this.getCurrentState();
    const goalState = this.calculateGoalState();

    const planner = new ActionPlanner(this.nodes, this.colonyMemory.marketPrices, this.getTime);
    return planner.findOptimalPlan(startState, goalState);
  }

  private getCurrentState(): MarketState {
    const state: MarketState = {
      resources: {},
      activeRoutines: [],
      screepsBucks: this.colonyMemory.screepsBucks
    };

    // Count current resources across all nodes
    for (const node of Object.values(this.nodes)) {
      const nodeResources = node.getAvailableResources();
      for (const [resourceType, amount] of Object.entries(nodeResources)) {
        state.resources[resourceType] = (state.resources[resourceType] || 0) + (amount as number);
      }
    }

    return state;
  }

  private calculateGoalState(): MarketState {
    // Goal is to maximize ScreepsBucks while maintaining essential operations
    const goalState = this.getCurrentState();

    // Increase ScreepsBucks target
    goalState.screepsBucks = this.colonyMemory.screepsBucks + 50;

    // Ensure minimum energy reserves
    goalState.resources['energy'] = Math.max(goalState.resources['energy'] || 0, 1000);

    return goalState;
  }

  public getScreepsBucks(): number {
    return this.colonyMemory.screepsBucks;
  }

  public getMarketPrice(resourceType: string): number {
    return this.colonyMemory.marketPrices[resourceType] || 0;
  }

  public setMarketPrice(resourceType: string, price: number): void {
    this.colonyMemory.marketPrices[resourceType] = price;
  }
}

export interface MarketState {
  resources: { [resourceType: string]: number };
  activeRoutines: string[]; // Routine IDs
  screepsBucks: number;
}

export class ActionPlanner {
  private nodes: { [id: string]: Node };
  private marketPrices: { [resourceType: string]: number };
  private getTime: () => number;

  constructor(nodes: { [id: string]: Node }, marketPrices: { [resourceType: string]: number }, getTime?: () => number) {
    this.nodes = nodes;
    this.marketPrices = marketPrices;
    this.getTime = getTime || (() => Game.time);
  }

  public findOptimalPlan(startState: MarketState, goalState: MarketState): ActionPlan | null {
    // Simplified A* implementation for market planning
    // In a full implementation, this would explore different combinations of actions

    const possibleActions = this.generatePossibleActions(startState);

    // For now, return a simple plan with the highest value action
    if (possibleActions.length === 0) return null;

    const bestAction = possibleActions.reduce((best, current) =>
      (current.value || 0) > (best.value || 0) ? current : best
    );

    const plan: ActionPlan = {
      id: `plan_${this.getTime()}_${Math.random().toString(36).substr(2, 9)}`,
      steps: [bestAction],
      totalValue: bestAction.value || 0,
      totalCost: bestAction.cost || 0,
      estimatedDuration: 100, // Simplified estimate
      created: this.getTime(),
      status: 'pending'
    };

    return plan;
  }

  private generatePossibleActions(state: MarketState): ActionStep[] {
    const actions: ActionStep[] = [];

    // Generate possible routine spawning actions
    for (const [nodeId, node] of Object.entries(this.nodes)) {
      // Harvest action
      if (this.canSpawnHarvestRoutine(node, state)) {
        actions.push({
          id: `harvest_${nodeId}_${this.getTime()}`,
          type: 'spawn_routine',
          nodeId,
          routineType: 'harvest',
          dependencies: [],
          status: 'pending',
          value: this.calculateActionValue('harvest', node),
          cost: this.calculateActionCost('harvest', node)
        });
      }

      // Upgrade action
      if (this.canSpawnUpgradeRoutine(node, state)) {
        actions.push({
          id: `upgrade_${nodeId}_${this.getTime()}`,
          type: 'spawn_routine',
          nodeId,
          routineType: 'upgrade',
          dependencies: [],
          status: 'pending',
          value: this.calculateActionValue('upgrade', node),
          cost: this.calculateActionCost('upgrade', node)
        });
      }

      // Build action
      if (this.canSpawnBuildRoutine(node, state)) {
        actions.push({
          id: `build_${nodeId}_${this.getTime()}`,
          type: 'spawn_routine',
          nodeId,
          routineType: 'build',
          dependencies: [],
          status: 'pending',
          value: this.calculateActionValue('build', node),
          cost: this.calculateActionCost('build', node)
        });
      }

      // Transport action
      if (this.canSpawnTransportRoutine(node, state)) {
        actions.push({
          id: `transport_${nodeId}_${this.getTime()}`,
          type: 'spawn_routine',
          nodeId,
          routineType: 'transport',
          dependencies: [],
          status: 'pending',
          value: this.calculateActionValue('transport', node),
          cost: this.calculateActionCost('transport', node)
        });
      }
    }

    return actions;
  }

  private canSpawnHarvestRoutine(node: Node, state: MarketState): boolean {
    // Check if node has energy sources and we have capacity for more harvesting
    return state.resources['energy'] < 2000; // Simplified condition
  }

  private canSpawnUpgradeRoutine(node: Node, state: MarketState): boolean {
    // Check if we have energy and controller access
    return (state.resources['energy'] || 0) > 100;
  }

  private canSpawnBuildRoutine(node: Node, state: MarketState): boolean {
    // Check if we have energy and construction sites
    return (state.resources['energy'] || 0) > 50;
  }

  private canSpawnTransportRoutine(node: Node, state: MarketState): boolean {
    // Check if we have energy to transport
    return (state.resources['energy'] || 0) > 200;
  }

  private calculateActionValue(actionType: string, node: Node): number {
    const prices = this.marketPrices;

    switch (actionType) {
      case 'harvest': return (prices['energy'] || 0) * 50; // Expected energy value
      case 'upgrade': return prices['control_points'] || 0; // Control points value
      case 'build': return (prices['construction_progress'] || 0) * 5; // Construction value
      case 'transport': return (prices['energy_transport'] || 0) * 50; // Transport value
      default: return 0;
    }
  }

  private calculateActionCost(actionType: string, node: Node): number {
    // Simplified cost calculation
    switch (actionType) {
      case 'harvest': return (this.marketPrices['creep_body'] || 0) * 5; // Creep cost
      case 'upgrade': return (this.marketPrices['creep_body'] || 0) * 3; // Creep cost
      case 'build': return (this.marketPrices['creep_body'] || 0) * 3; // Creep cost
      case 'transport': return (this.marketPrices['creep_body'] || 0) * 4; // Creep cost
      default: return 0;
    }
  }
}
