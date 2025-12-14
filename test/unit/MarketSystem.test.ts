import { expect } from 'chai';
import { MarketSystem, ActionPlanner, MarketState } from '../../src/MarketSystem';
import { ColonyMemory } from '../../src/types/Colony';
import { Node } from '../../src/Node';

describe('MarketSystem', () => {
  let colonyMemory: ColonyMemory;
  let nodes: { [id: string]: Node };
  let marketSystem: MarketSystem;

  beforeEach(() => {
    // Initialize test colony memory
    colonyMemory = {
      id: 'test-colony',
      rootRoomName: 'W1N1',
      roomNames: ['W1N1'],
      nodeIds: ['node1', 'node2'],
      energyLedger: {
        income: 0,
        expenses: 0,
        net: 0,
        lastUpdate: 0
      },
      roiMetrics: {},
      actionQueue: [],
      screepsBucks: 100,
      marketPrices: {
        'energy': 0.1,
        'control_points': 1.0
      },
      marketOrders: [],
      currentPlan: null,
      lastPlanUpdate: 0
    };

    // Create mock nodes
    nodes = {
      'node1': {
        id: 'node1',
        position: new RoomPosition(25, 25, 'W1N1'),
        assets: [],
        memory: {},
        height: 1,
        territory: [new RoomPosition(25, 25, 'W1N1')],
        connections: [],
        agents: [],
        localPlan: () => {},
        updateMemory: () => {},
        getMemory: () => null,
        run: () => {},
        addAgent: () => {},
        removeAgent: () => {},
        getAgents: () => [],
        getAvailableResources: () => ({ 'energy': 1000, 'control_points': 0 })
      } as unknown as Node,
      'node2': {
        id: 'node2',
        position: new RoomPosition(30, 30, 'W1N1'),
        assets: [],
        memory: {},
        height: 1,
        territory: [new RoomPosition(30, 30, 'W1N1')],
        connections: [],
        agents: [],
        localPlan: () => {},
        updateMemory: () => {},
        getMemory: () => null,
        run: () => {},
        addAgent: () => {},
        removeAgent: () => {},
        getAgents: () => [],
        getAvailableResources: () => ({ 'energy': 500, 'control_points': 1 })
      } as unknown as Node
    };

    marketSystem = new MarketSystem(colonyMemory, nodes, () => 12345);
  });

  describe('Initialization', () => {
    it('should initialize with default market prices', () => {
      expect(marketSystem.getMarketPrice('energy')).to.equal(0.1);
      expect(marketSystem.getMarketPrice('control_points')).to.equal(1.0);
    });

    it('should initialize with starting ScreepsBucks', () => {
      expect(marketSystem.getScreepsBucks()).to.equal(100);
    });
  });

  describe('Market Orders', () => {
    it('should create buy orders', () => {
      const orderId = marketSystem.createBuyOrder('energy', 100, 0.15, 'test-buyer');
      expect(orderId).to.be.a('string');
      expect(colonyMemory.marketOrders).to.have.lengthOf(1);
      expect(colonyMemory.marketOrders[0].type).to.equal('buy');
      expect(colonyMemory.marketOrders[0].resourceType).to.equal('energy');
    });

    it('should create sell orders', () => {
      const orderId = marketSystem.createSellOrder('energy', 50, 0.08, 'test-seller');
      expect(orderId).to.be.a('string');
      expect(colonyMemory.marketOrders).to.have.lengthOf(1);
      expect(colonyMemory.marketOrders[0].type).to.equal('sell');
    });

    it('should match buy and sell orders', () => {
      marketSystem.createBuyOrder('energy', 100, 0.15, 'buyer');
      marketSystem.createSellOrder('energy', 50, 0.1, 'seller');

      marketSystem.matchOrders();

      // Should have executed a trade
      expect(marketSystem.getScreepsBucks()).to.be.lessThan(100); // Buyer paid
      expect(colonyMemory.marketOrders.filter((o: any) => o.fulfilled)).to.have.lengthOf(2);
    });
  });

  describe('Planning', () => {
    it('should generate optimal action plans', () => {
      const plan = marketSystem.generateOptimalPlan();
      expect(plan).to.not.be.null;
      expect(plan!.steps).to.be.an('array');
      expect(plan!.totalValue).to.be.at.least(0);
    });
  });
});

describe('ActionPlanner', () => {
  let planner: ActionPlanner;
  let nodes: { [id: string]: Node };

  beforeEach(() => {
    nodes = {
      'node1': {
        id: 'node1',
        position: new RoomPosition(25, 25, 'W1N1'),
        assets: [],
        memory: {},
        height: 1,
        territory: [new RoomPosition(25, 25, 'W1N1')],
        connections: [],
        agents: [],
        localPlan: () => {},
        updateMemory: () => {},
        getMemory: () => null,
        run: () => {},
        addAgent: () => {},
        removeAgent: () => {},
        getAgents: () => [],
        getAvailableResources: () => ({ 'energy': 1000 })
      } as unknown as Node
    };

    const marketPrices = { 'energy': 0.1, 'control_points': 1.0 };
    planner = new ActionPlanner(nodes, marketPrices, () => 12345);
  });

  describe('Plan Generation', () => {
    it('should generate possible actions for current state', () => {
      const startState: MarketState = {
        resources: { 'energy': 1000 },
        activeRoutines: [],
        screepsBucks: 100
      };

      const goalState: MarketState = {
        resources: { 'energy': 1500 },
        activeRoutines: ['harvest'],
        screepsBucks: 150
      };

      const plan = planner.findOptimalPlan(startState, goalState);
      expect(plan).to.not.be.null;
      expect(plan!.steps).to.have.lengthOf.at.least(1);
    });
  });
});
