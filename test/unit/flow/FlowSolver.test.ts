import { expect } from "chai";
import {
  FlowSource,
  FlowSink,
  FlowEdge,
  FlowProblem,
  FlowConstraints,
  SinkType,
  PriorityContext,
  SOURCE_ENERGY_PER_TICK,
  MINER_OVERHEAD_PER_TICK,
  DEFAULT_CONSTRAINTS,
  DEFAULT_SINK_PRIORITIES,
  createFlowSource,
  createFlowSink,
  createEdgeId,
  calculateRoundTrip,
  calculateCarryParts,
  calculateHaulerCostPerTick,
  chebyshevDistance,
  Position,
} from "../../../src/flow/FlowTypes";
import { FlowSolver, solveIteratively, calculateEfficiency } from "../../../src/flow/FlowSolver";
import { PriorityManager, PRIORITY_PRESETS, describePriority } from "../../../src/flow/PriorityManager";

describe("FlowTypes", () => {
  describe("constants", () => {
    it("should have correct SOURCE_ENERGY_PER_TICK", () => {
      // 3000 capacity / 300 regen = 10 energy/tick
      expect(SOURCE_ENERGY_PER_TICK).to.equal(10);
    });

    it("should have correct MINER_OVERHEAD_PER_TICK", () => {
      // 650 cost / 1500 lifetime ≈ 0.433
      expect(MINER_OVERHEAD_PER_TICK).to.be.closeTo(0.433, 0.001);
    });
  });

  describe("createFlowSource()", () => {
    it("should create source with correct fields", () => {
      const source = createFlowSource(
        "abc123",
        "node-1",
        { x: 25, y: 25, roomName: "E1N1" }
      );

      expect(source.id).to.equal("source-abc123");
      expect(source.nodeId).to.equal("node-1");
      expect(source.gameId).to.equal("abc123");
      expect(source.capacity).to.equal(SOURCE_ENERGY_PER_TICK);
      expect(source.assigned).to.be.false;
    });

    it("should allow custom capacity", () => {
      const source = createFlowSource(
        "abc",
        "node-1",
        { x: 0, y: 0, roomName: "E1N1" },
        15
      );
      expect(source.capacity).to.equal(15);
    });
  });

  describe("createFlowSink()", () => {
    it("should create sink with default priority", () => {
      const sink = createFlowSink(
        "spawn",
        "xyz789",
        "node-1",
        { x: 25, y: 25, roomName: "E1N1" },
        10,
        50
      );

      expect(sink.id).to.equal("spawn-xyz789");
      expect(sink.type).to.equal("spawn");
      expect(sink.priority).to.equal(DEFAULT_SINK_PRIORITIES["spawn"]);
      expect(sink.demand).to.equal(10);
      expect(sink.capacity).to.equal(50);
      expect(sink.allocation).to.equal(0);
    });

    it("should allow custom priority", () => {
      const sink = createFlowSink(
        "controller",
        "ctrl1",
        "node-1",
        { x: 0, y: 0, roomName: "E1N1" },
        50,
        100,
        42
      );
      expect(sink.priority).to.equal(42);
    });
  });

  describe("createEdgeId()", () => {
    it("should create sorted edge ID", () => {
      expect(createEdgeId("source-a", "sink-b")).to.equal("sink-b|source-a");
      expect(createEdgeId("sink-b", "source-a")).to.equal("sink-b|source-a");
    });
  });

  describe("calculateRoundTrip()", () => {
    it("should return 2D + 2", () => {
      expect(calculateRoundTrip(30)).to.equal(62);
      expect(calculateRoundTrip(10)).to.equal(22);
      expect(calculateRoundTrip(50)).to.equal(102);
    });
  });

  describe("calculateCarryParts()", () => {
    it("should calculate CARRY parts for flow at distance", () => {
      // CARRY = flowRate * roundTrip / 50
      // At D=30, rt=62, flow=10: CARRY = 10 * 62 / 50 = 12.4
      expect(calculateCarryParts(10, 30)).to.be.closeTo(12.4, 0.1);
    });

    it("should scale with flow rate", () => {
      const carry10 = calculateCarryParts(10, 30);
      const carry20 = calculateCarryParts(20, 30);
      expect(carry20).to.be.closeTo(carry10 * 2, 0.1);
    });

    it("should scale with distance", () => {
      const carry30 = calculateCarryParts(10, 30);
      const carry60 = calculateCarryParts(10, 60);
      expect(carry60).to.be.greaterThan(carry30);
    });
  });

  describe("chebyshevDistance()", () => {
    it("should return max of dx, dy for same room", () => {
      const a: Position = { x: 10, y: 10, roomName: "E1N1" };
      const b: Position = { x: 20, y: 15, roomName: "E1N1" };
      expect(chebyshevDistance(a, b)).to.equal(10);
    });

    it("should return 0 for same position", () => {
      const p: Position = { x: 25, y: 25, roomName: "E1N1" };
      expect(chebyshevDistance(p, p)).to.equal(0);
    });
  });
});

describe("FlowSolver", () => {
  // Helper to create a minimal flow problem
  function createMinimalProblem(distance: number = 30): FlowProblem {
    const source = createFlowSource(
      "source1",
      "node-1",
      { x: 0, y: 0, roomName: "E1N1" }
    );

    const spawn = createFlowSink(
      "spawn",
      "spawn1",
      "node-1",
      { x: distance, y: 0, roomName: "E1N1" },
      10, // demand
      50  // capacity
    );

    const controller = createFlowSink(
      "controller",
      "ctrl1",
      "node-1",
      { x: distance, y: distance, roomName: "E1N1" },
      50, // demand (wants all available)
      100
    );

    const edges: FlowEdge[] = [
      {
        id: createEdgeId(source.id, spawn.id),
        fromId: source.id,
        toId: spawn.id,
        distance,
        roundTrip: calculateRoundTrip(distance),
        carryParts: 0,
        flowRate: 0,
        spawnCostPerTick: 0,
        hasRoads: false,
      },
      {
        id: createEdgeId(source.id, controller.id),
        fromId: source.id,
        toId: controller.id,
        distance: Math.round(distance * 1.414), // diagonal
        roundTrip: calculateRoundTrip(Math.round(distance * 1.414)),
        carryParts: 0,
        flowRate: 0,
        spawnCostPerTick: 0,
        hasRoads: false,
      },
    ];

    return {
      sources: [source],
      sinks: [spawn, controller], // spawn first (higher priority)
      edges,
      constraints: DEFAULT_CONSTRAINTS,
    };
  }

  describe("solve()", () => {
    it("should assign miners to all sources", () => {
      const problem = createMinimalProblem();
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      expect(solution.miners).to.have.length(1);
      expect(solution.miners[0].sourceId).to.equal("source-source1");
      expect(solution.miners[0].harvestRate).to.equal(SOURCE_ENERGY_PER_TICK);
    });

    it("should calculate total harvest", () => {
      const problem = createMinimalProblem();
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      expect(solution.totalHarvest).to.equal(10);
    });

    it("should calculate mining overhead", () => {
      const problem = createMinimalProblem();
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      expect(solution.miningOverhead).to.be.closeTo(MINER_OVERHEAD_PER_TICK, 0.01);
    });

    it("should allocate to higher priority sinks first", () => {
      const problem = createMinimalProblem();
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      // Spawn has priority 100, controller has priority 60
      const spawnAlloc = solution.sinkAllocations.find(a => a.sinkType === "spawn");
      const ctrlAlloc = solution.sinkAllocations.find(a => a.sinkType === "controller");

      expect(spawnAlloc).to.exist;
      expect(ctrlAlloc).to.exist;

      // Spawn should get its full demand (10)
      expect(spawnAlloc!.allocated).to.equal(10);
    });

    it("should return sustainable economy", () => {
      const problem = createMinimalProblem();
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      expect(solution.isSustainable).to.be.true;
      expect(solution.netEnergy).to.be.greaterThan(0);
    });

    it("should calculate efficiency", () => {
      const problem = createMinimalProblem();
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      expect(solution.efficiency).to.be.greaterThan(0);
      expect(solution.efficiency).to.be.lessThan(100);
    });
  });

  describe("two-source scenario", () => {
    function createTwoSourceProblem(distance: number): FlowProblem {
      const source1 = createFlowSource(
        "s1",
        "node-1",
        { x: 0, y: 0, roomName: "E1N1" }
      );
      const source2 = createFlowSource(
        "s2",
        "node-2",
        { x: distance * 2, y: 0, roomName: "E1N1" }
      );

      const spawn = createFlowSink(
        "spawn",
        "spawn1",
        "node-spawn",
        { x: distance, y: 0, roomName: "E1N1" },
        5,
        50
      );

      const controller = createFlowSink(
        "controller",
        "ctrl1",
        "node-ctrl",
        { x: distance, y: distance, roomName: "E1N1" },
        100,
        100
      );

      const edges: FlowEdge[] = [
        // Source 1 edges
        {
          id: createEdgeId(source1.id, spawn.id),
          fromId: source1.id,
          toId: spawn.id,
          distance,
          roundTrip: calculateRoundTrip(distance),
          carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false,
        },
        {
          id: createEdgeId(source1.id, controller.id),
          fromId: source1.id,
          toId: controller.id,
          distance: Math.round(distance * 1.414),
          roundTrip: calculateRoundTrip(Math.round(distance * 1.414)),
          carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false,
        },
        // Source 2 edges
        {
          id: createEdgeId(source2.id, spawn.id),
          fromId: source2.id,
          toId: spawn.id,
          distance,
          roundTrip: calculateRoundTrip(distance),
          carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false,
        },
        {
          id: createEdgeId(source2.id, controller.id),
          fromId: source2.id,
          toId: controller.id,
          distance: Math.round(distance * 1.414),
          roundTrip: calculateRoundTrip(Math.round(distance * 1.414)),
          carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false,
        },
      ];

      return {
        sources: [source1, source2],
        sinks: [spawn, controller],
        edges,
        constraints: DEFAULT_CONSTRAINTS,
      };
    }

    it("should assign miners to both sources", () => {
      const problem = createTwoSourceProblem(30);
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      expect(solution.miners).to.have.length(2);
      expect(solution.totalHarvest).to.equal(20);
    });

    it("should distribute energy to sinks", () => {
      const problem = createTwoSourceProblem(30);
      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      const spawnAlloc = solution.sinkAllocations.find(a => a.sinkType === "spawn");
      const ctrlAlloc = solution.sinkAllocations.find(a => a.sinkType === "controller");

      expect(spawnAlloc!.allocated).to.equal(5); // spawn gets its demand
      expect(ctrlAlloc!.allocated).to.equal(15); // remaining goes to controller
    });

    it("should have higher efficiency at shorter distances", () => {
      const solver = new FlowSolver();

      const problem10 = createTwoSourceProblem(10);
      const problem50 = createTwoSourceProblem(50);

      const sol10 = solver.solve(problem10);
      const sol50 = solver.solve(problem50);

      expect(sol10.efficiency).to.be.greaterThan(sol50.efficiency);
    });
  });

  describe("priority-based allocation", () => {
    it("should allocate to construction before controller during build phase", () => {
      const source = createFlowSource("s1", "node-1", { x: 0, y: 0, roomName: "E1N1" });

      const spawn = createFlowSink("spawn", "sp1", "node-1",
        { x: 10, y: 0, roomName: "E1N1" }, 2, 50, 100);

      const construction = createFlowSink("construction", "cs1", "node-1",
        { x: 15, y: 0, roomName: "E1N1" }, 5, 10, 88); // high priority

      const controller = createFlowSink("controller", "ct1", "node-1",
        { x: 20, y: 0, roomName: "E1N1" }, 50, 100, 12); // low priority

      const edges: FlowEdge[] = [
        { id: "source-s1|spawn-sp1", fromId: source.id, toId: spawn.id,
          distance: 10, roundTrip: 22, carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false },
        { id: "construction-cs1|source-s1", fromId: source.id, toId: construction.id,
          distance: 15, roundTrip: 32, carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false },
        { id: "controller-ct1|source-s1", fromId: source.id, toId: controller.id,
          distance: 20, roundTrip: 42, carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false },
      ];

      const problem: FlowProblem = {
        sources: [source],
        sinks: [spawn, construction, controller], // sorted by priority
        edges,
        constraints: DEFAULT_CONSTRAINTS,
      };

      const solver = new FlowSolver();
      const solution = solver.solve(problem);

      const spawnAlloc = solution.sinkAllocations.find(a => a.sinkType === "spawn")!;
      const constAlloc = solution.sinkAllocations.find(a => a.sinkType === "construction")!;
      const ctrlAlloc = solution.sinkAllocations.find(a => a.sinkType === "controller")!;

      // Spawn gets full demand
      expect(spawnAlloc.allocated).to.equal(2);
      // Construction gets its demand (5)
      expect(constAlloc.allocated).to.equal(5);
      // Controller gets remainder (10 - 2 - 5 = 3)
      expect(ctrlAlloc.allocated).to.equal(3);
    });
  });
});

describe("PriorityManager", () => {
  describe("calculatePriorities()", () => {
    it("should return spawn as critical (100)", () => {
      const manager = new PriorityManager();
      const context = PriorityManager.createMockContext();
      const priorities = manager.calculatePriorities(context);

      expect(priorities.get("spawn")).to.equal(100);
    });

    it("should increase tower priority during attack", () => {
      const manager = new PriorityManager();

      const peacefulContext = PriorityManager.createMockContext({ underAttack: false, hostileCreeps: 0 });
      const attackContext = PriorityManager.createMockContext({ underAttack: true, hostileCreeps: 3 });

      const peacefulPri = manager.calculatePriorities(peacefulContext).get("tower")!;
      const attackPri = manager.calculatePriorities(attackContext).get("tower")!;

      expect(attackPri).to.be.greaterThan(peacefulPri);
      expect(attackPri).to.be.greaterThan(90);
    });

    it("should reduce controller priority during construction", () => {
      const manager = new PriorityManager();

      const normalContext = PriorityManager.createMockContext({ constructionSites: 0 });
      const buildContext = PriorityManager.createMockContext({
        constructionSites: 5,
        ticksSinceRclUp: 1000,
      });

      const normalPri = manager.calculatePriorities(normalContext).get("controller")!;
      const buildPri = manager.calculatePriorities(buildContext).get("controller")!;

      expect(buildPri).to.be.lessThan(normalPri);
      expect(buildPri).to.be.lessThan(20);
    });

    it("should increase extension priority when spawn queue waiting", () => {
      const manager = new PriorityManager();

      const idleContext = PriorityManager.createMockContext({ spawnQueueSize: 0 });
      const busyContext = PriorityManager.createMockContext({
        spawnQueueSize: 3,
        extensionEnergy: 0,
        extensionCapacity: 1000,
      });

      const idlePri = manager.calculatePriorities(idleContext).get("extension")!;
      const busyPri = manager.calculatePriorities(busyContext).get("extension")!;

      expect(busyPri).to.be.greaterThan(idlePri);
      expect(busyPri).to.be.greaterThan(85);
    });
  });

  describe("PRIORITY_PRESETS", () => {
    it("should have normal preset", () => {
      const priorities = PRIORITY_PRESETS.normal();
      expect(priorities.get("spawn")).to.equal(100);
      expect(priorities.get("controller")).to.be.greaterThan(50);
    });

    it("should have buildPhase preset with low controller", () => {
      const priorities = PRIORITY_PRESETS.buildPhase();
      expect(priorities.get("construction")).to.be.greaterThan(80);
      expect(priorities.get("controller")).to.be.lessThan(20);
    });

    it("should have defense preset with high tower", () => {
      const priorities = PRIORITY_PRESETS.defense();
      expect(priorities.get("tower")).to.be.greaterThan(95);
    });

    it("should have emergency preset with minimal non-critical", () => {
      const priorities = PRIORITY_PRESETS.emergency();
      expect(priorities.get("spawn")).to.equal(100);
      expect(priorities.get("controller")).to.be.lessThan(10);
      expect(priorities.get("storage")).to.equal(0);
    });
  });

  describe("describePriority()", () => {
    it("should describe priority levels", () => {
      expect(describePriority(100)).to.equal("Critical");
      expect(describePriority(85)).to.equal("High");
      expect(describePriority(65)).to.equal("Normal");
      expect(describePriority(45)).to.equal("Low");
      expect(describePriority(25)).to.equal("Minimal");
      expect(describePriority(5)).to.equal("Negligible");
    });
  });
});

describe("Economy Scenarios (from minimal-economy)", () => {
  /**
   * These tests verify the solver matches expected efficiency
   * from the minimal-economy.ts demo calculations.
   */

  describe("single source at D=30", () => {
    it("should achieve ~91-92% efficiency", () => {
      // From minimal-economy: 1:1 no roads at D=30 = 91.7%
      const source = createFlowSource("s1", "n1", { x: 0, y: 0, roomName: "E1N1" });
      const spawn = createFlowSink("spawn", "sp1", "n1",
        { x: 30, y: 0, roomName: "E1N1" }, 2, 50);
      const controller = createFlowSink("controller", "ct1", "n1",
        { x: 30, y: 30, roomName: "E1N1" }, 50, 100);

      const edges: FlowEdge[] = [
        { id: "source-s1|spawn-sp1", fromId: source.id, toId: spawn.id,
          distance: 30, roundTrip: 62, carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false },
        { id: "controller-ct1|source-s1", fromId: source.id, toId: controller.id,
          distance: 42, roundTrip: 86, carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false },
      ];

      const problem: FlowProblem = {
        sources: [source],
        sinks: [spawn, controller],
        edges,
        constraints: DEFAULT_CONSTRAINTS,
      };

      const solution = solveIteratively(problem);

      // Efficiency should be in the 80-95% range
      expect(solution.efficiency).to.be.greaterThan(80);
      expect(solution.efficiency).to.be.lessThan(95);
      expect(solution.isSustainable).to.be.true;
    });
  });

  describe("efficiency scaling with distance", () => {
    function createScenario(distance: number): FlowProblem {
      const source = createFlowSource("s1", "n1", { x: 0, y: 0, roomName: "E1N1" });
      const spawn = createFlowSink("spawn", "sp1", "n1",
        { x: distance, y: 0, roomName: "E1N1" }, 2, 50);
      const controller = createFlowSink("controller", "ct1", "n1",
        { x: distance, y: distance, roomName: "E1N1" }, 50, 100);

      return {
        sources: [source],
        sinks: [spawn, controller],
        edges: [
          { id: createEdgeId(source.id, spawn.id), fromId: source.id, toId: spawn.id,
            distance, roundTrip: calculateRoundTrip(distance),
            carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false },
          { id: createEdgeId(source.id, controller.id), fromId: source.id, toId: controller.id,
            distance: Math.round(distance * 1.414), roundTrip: calculateRoundTrip(Math.round(distance * 1.414)),
            carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false },
        ],
        constraints: DEFAULT_CONSTRAINTS,
      };
    }

    it("should have higher efficiency at D=10 than D=50", () => {
      const sol10 = solveIteratively(createScenario(10));
      const sol50 = solveIteratively(createScenario(50));

      expect(sol10.efficiency).to.be.greaterThan(sol50.efficiency);
    });

    it("should have higher efficiency at D=30 than D=100", () => {
      const sol30 = solveIteratively(createScenario(30));
      const sol100 = solveIteratively(createScenario(100));

      expect(sol30.efficiency).to.be.greaterThan(sol100.efficiency);
    });

    it("should show efficiency decreasing with distance", () => {
      const distances = [10, 20, 30, 50, 75, 100];
      let prevEfficiency = 100;

      for (const d of distances) {
        const solution = solveIteratively(createScenario(d));
        expect(solution.efficiency).to.be.lessThan(prevEfficiency);
        prevEfficiency = solution.efficiency;
      }
    });
  });

  describe("large-scale scenario (20 sources)", () => {
    function createLargeScenario(): FlowProblem {
      const sources: FlowSource[] = [];
      const sinks: FlowSink[] = [];
      const edges: FlowEdge[] = [];

      // Create 20 sources spread around
      for (let i = 0; i < 20; i++) {
        const x = (i % 5) * 20 + 10;
        const y = Math.floor(i / 5) * 20 + 10;
        sources.push(createFlowSource(`s${i}`, `n${i}`,
          { x, y, roomName: "E1N1" }));
      }

      // Create 5 spawns
      for (let i = 0; i < 5; i++) {
        const x = i * 20 + 15;
        const y = 50;
        const sink = createFlowSink("spawn", `sp${i}`, `nsp${i}`,
          { x, y, roomName: "E1N1" }, 20, 100);
        sinks.push(sink);

        // Create edges from nearby sources
        for (const source of sources) {
          const dx = Math.abs(source.position.x - x);
          const dy = Math.abs(source.position.y - y);
          const dist = Math.max(dx, dy);

          edges.push({
            id: createEdgeId(source.id, sink.id),
            fromId: source.id,
            toId: sink.id,
            distance: dist,
            roundTrip: calculateRoundTrip(dist),
            carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false,
          });
        }
      }

      // Create 5 controllers
      for (let i = 0; i < 5; i++) {
        const x = i * 20 + 15;
        const y = 90;
        const sink = createFlowSink("controller", `ct${i}`, `nct${i}`,
          { x, y, roomName: "E1N1" }, 50, 100);
        sinks.push(sink);

        // Create edges from nearby sources
        for (const source of sources) {
          const dx = Math.abs(source.position.x - x);
          const dy = Math.abs(source.position.y - y);
          const dist = Math.max(dx, dy);

          edges.push({
            id: createEdgeId(source.id, sink.id),
            fromId: source.id,
            toId: sink.id,
            distance: dist,
            roundTrip: calculateRoundTrip(dist),
            carryParts: 0, flowRate: 0, spawnCostPerTick: 0, hasRoads: false,
          });
        }
      }

      // Sort sinks by priority (spawns first)
      sinks.sort((a, b) => b.priority - a.priority);

      return {
        sources,
        sinks,
        edges,
        constraints: DEFAULT_CONSTRAINTS,
      };
    }

    it("should handle 20 sources", () => {
      const problem = createLargeScenario();
      const solution = solveIteratively(problem);

      expect(solution.miners).to.have.length(20);
      expect(solution.totalHarvest).to.equal(200);
    });

    it("should be sustainable", () => {
      const problem = createLargeScenario();
      const solution = solveIteratively(problem);

      expect(solution.isSustainable).to.be.true;
    });

    it("should achieve reasonable efficiency", () => {
      const problem = createLargeScenario();
      const solution = solveIteratively(problem);

      // Large-scale should still be efficient (>80%)
      expect(solution.efficiency).to.be.greaterThan(80);
    });

    it("should allocate to all controllers", () => {
      const problem = createLargeScenario();
      const solution = solveIteratively(problem);

      const ctrlAllocations = solution.sinkAllocations.filter(a => a.sinkType === "controller");
      const totalCtrl = ctrlAllocations.reduce((sum, a) => sum + a.allocated, 0);

      // Should have significant energy going to controllers
      expect(totalCtrl).to.be.greaterThan(100);
    });
  });
});

describe("calculateEfficiency()", () => {
  it("should return 0 for zero harvest", () => {
    expect(calculateEfficiency(0, 0)).to.equal(0);
    expect(calculateEfficiency(0, 10)).to.equal(0);
  });

  it("should return correct percentage", () => {
    expect(calculateEfficiency(100, 10)).to.equal(90);
    expect(calculateEfficiency(100, 20)).to.equal(80);
    expect(calculateEfficiency(100, 50)).to.equal(50);
  });

  it("should handle negative net (overhead > harvest)", () => {
    expect(calculateEfficiency(100, 150)).to.equal(-50);
  });
});
