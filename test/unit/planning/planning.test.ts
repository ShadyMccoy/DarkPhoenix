/**
 * @fileoverview Unit tests for GOAP planning system.
 *
 * Tests the global planning abstraction to ensure that given
 * nodes with resources, the planner produces correct plans.
 *
 * Test categories:
 * - WorldState: State management and manipulation
 * - Action: Precondition checking and goal contribution
 * - Goal: Satisfaction checking
 * - Agent: Action selection algorithm (the core planning logic)
 * - Integration: Multi-step planning scenarios
 */

import { expect } from "chai";
import {
  Action,
  Goal,
  WorldState,
  Agent,
  createMineEnergyAction,
  createBuildStructureAction,
  createProfitGoal,
} from "../../../src/planning";
import {
  createWorldState,
  createAction,
  toMap,
  ALL_SCENARIOS,
  BASIC_SCENARIOS,
  PRIORITY_SCENARIOS,
  COST_SCENARIOS,
  EDGE_CASE_SCENARIOS,
  HARVEST_ENERGY_SCENARIO,
  UPGRADE_CONTROLLER_WORKFLOW,
  PlanningScenario,
} from "./fixtures/planning-scenarios";

// ============================================================================
// Test Agent Implementation
// ============================================================================

/**
 * Concrete Agent implementation for testing.
 * Exposes internal state for assertions.
 */
class TestAgent extends Agent {
  public executedActions: Action[] = [];

  constructor(worldState: WorldState) {
    super(worldState);
  }

  performAction(): void {
    const action = this.selectAction();
    if (action) {
      this.executeAction(action);
      this.executedActions.push(action);
    }
  }

  // Expose protected members for testing
  getGoals(): Goal[] {
    return this.currentGoals;
  }

  getActions(): Action[] {
    return this.availableActions;
  }

  getWorldState(): WorldState {
    return this.worldState;
  }

  setWorldState(state: WorldState): void {
    this.worldState = state;
  }
}

// ============================================================================
// WorldState Tests
// ============================================================================

describe("WorldState", () => {
  describe("construction", () => {
    it("should initialize with provided state", () => {
      const initial = new Map([
        ["hasEnergy", true],
        ["atSource", false],
      ]);
      const worldState = new WorldState(initial);

      const state = worldState.getState();
      expect(state.get("hasEnergy")).to.equal(true);
      expect(state.get("atSource")).to.equal(false);
    });

    it("should create with empty state", () => {
      const worldState = new WorldState(new Map());
      expect(worldState.getState().size).to.equal(0);
    });
  });

  describe("getState", () => {
    it("should return a copy of the state", () => {
      const initial = new Map([["hasEnergy", true]]);
      const worldState = new WorldState(initial);

      const copy1 = worldState.getState();
      const copy2 = worldState.getState();

      expect(copy1).to.not.equal(copy2);
      expect(copy1.get("hasEnergy")).to.equal(copy2.get("hasEnergy"));
    });

    it("should not allow external modification of internal state", () => {
      const worldState = new WorldState(new Map([["hasEnergy", true]]));

      const copy = worldState.getState();
      copy.set("hasEnergy", false);

      expect(worldState.getState().get("hasEnergy")).to.equal(true);
    });
  });

  describe("updateState", () => {
    it("should update existing conditions", () => {
      const worldState = new WorldState(new Map([["hasEnergy", false]]));
      worldState.updateState(new Map([["hasEnergy", true]]));

      expect(worldState.getState().get("hasEnergy")).to.equal(true);
    });

    it("should add new conditions", () => {
      const worldState = new WorldState(new Map([["hasEnergy", false]]));
      worldState.updateState(new Map([["atSource", true]]));

      const state = worldState.getState();
      expect(state.get("hasEnergy")).to.equal(false);
      expect(state.get("atSource")).to.equal(true);
    });

    it("should handle multiple updates", () => {
      const worldState = new WorldState(new Map());
      worldState.updateState(new Map([["a", true]]));
      worldState.updateState(new Map([["b", true]]));
      worldState.updateState(new Map([["a", false]]));

      const state = worldState.getState();
      expect(state.get("a")).to.equal(false);
      expect(state.get("b")).to.equal(true);
    });
  });

  describe("applyAction", () => {
    it("should return new WorldState with effects applied", () => {
      const worldState = new WorldState(
        new Map([
          ["hasEnergy", false],
          ["atSource", true],
        ])
      );
      const action = new Action(
        "harvest",
        new Map([["atSource", true]]),
        new Map([["hasEnergy", true]]),
        1
      );

      const newState = worldState.applyAction(action);

      // Original unchanged
      expect(worldState.getState().get("hasEnergy")).to.equal(false);
      // New state has effect applied
      expect(newState.getState().get("hasEnergy")).to.equal(true);
      expect(newState.getState().get("atSource")).to.equal(true);
    });

    it("should not modify the original state", () => {
      const worldState = new WorldState(new Map([["hasEnergy", false]]));
      const action = new Action(
        "gain",
        new Map(),
        new Map([["hasEnergy", true]]),
        1
      );

      worldState.applyAction(action);

      expect(worldState.getState().get("hasEnergy")).to.equal(false);
    });
  });
});

// ============================================================================
// Action Tests
// ============================================================================

describe("Action", () => {
  describe("construction", () => {
    it("should store name, preconditions, effects, and cost", () => {
      const action = new Action(
        "harvest",
        new Map([["atSource", true]]),
        new Map([["hasEnergy", true]]),
        5
      );

      expect(action.name).to.equal("harvest");
      expect(action.preconditions.get("atSource")).to.equal(true);
      expect(action.effects.get("hasEnergy")).to.equal(true);
      expect(action.cost).to.equal(5);
    });
  });

  describe("isAchievable", () => {
    it("should return true when all preconditions are met", () => {
      const action = new Action(
        "harvest",
        new Map([
          ["atSource", true],
          ["hasFreeCapacity", true],
        ]),
        new Map([["hasEnergy", true]]),
        1
      );
      const worldState = new Map([
        ["atSource", true],
        ["hasFreeCapacity", true],
      ]);

      expect(action.isAchievable(worldState)).to.equal(true);
    });

    it("should return false when a precondition is not met", () => {
      const action = new Action(
        "harvest",
        new Map([
          ["atSource", true],
          ["hasFreeCapacity", true],
        ]),
        new Map([["hasEnergy", true]]),
        1
      );
      const worldState = new Map([
        ["atSource", false],
        ["hasFreeCapacity", true],
      ]);

      expect(action.isAchievable(worldState)).to.equal(false);
    });

    it("should return false when precondition is missing from world state", () => {
      const action = new Action(
        "harvest",
        new Map([["atSource", true]]),
        new Map([["hasEnergy", true]]),
        1
      );
      const worldState = new Map<string, boolean>();

      expect(action.isAchievable(worldState)).to.equal(false);
    });

    it("should return true with no preconditions", () => {
      const action = new Action(
        "idle",
        new Map(),
        new Map([["waited", true]]),
        0
      );
      const worldState = new Map<string, boolean>();

      expect(action.isAchievable(worldState)).to.equal(true);
    });

    it("should handle false precondition requirements", () => {
      const action = new Action(
        "rest",
        new Map([["isTired", true], ["isBusy", false]]),
        new Map([["isTired", false]]),
        1
      );

      const canRest = new Map([["isTired", true], ["isBusy", false]]);
      const cannotRest = new Map([["isTired", true], ["isBusy", true]]);

      expect(action.isAchievable(canRest)).to.equal(true);
      expect(action.isAchievable(cannotRest)).to.equal(false);
    });
  });

  describe("contributesToGoal", () => {
    it("should return true when effect matches goal condition", () => {
      const action = new Action(
        "harvest",
        new Map(),
        new Map([["hasEnergy", true]]),
        1
      );
      const goal = new Goal(new Map([["hasEnergy", true]]), 5);

      expect(action.contributesToGoal(goal)).to.equal(true);
    });

    it("should return false when no effect matches goal", () => {
      const action = new Action(
        "move",
        new Map(),
        new Map([["atDestination", true]]),
        1
      );
      const goal = new Goal(new Map([["hasEnergy", true]]), 5);

      expect(action.contributesToGoal(goal)).to.equal(false);
    });

    it("should return true if any effect matches any goal condition", () => {
      const action = new Action(
        "work",
        new Map(),
        new Map([
          ["workedHard", true],
          ["hasEnergy", true],
        ]),
        1
      );
      const goal = new Goal(
        new Map([
          ["hasEnergy", true],
          ["isHappy", true],
        ]),
        5
      );

      expect(action.contributesToGoal(goal)).to.equal(true);
    });

    it("should return false when effect value doesn't match", () => {
      const action = new Action(
        "spend",
        new Map(),
        new Map([["hasEnergy", false]]), // Sets to false
        1
      );
      const goal = new Goal(new Map([["hasEnergy", true]]), 5); // Wants true

      expect(action.contributesToGoal(goal)).to.equal(false);
    });
  });
});

// ============================================================================
// Goal Tests
// ============================================================================

describe("Goal", () => {
  describe("construction", () => {
    it("should store conditions and priority", () => {
      const goal = new Goal(new Map([["hasEnergy", true]]), 10);

      expect(goal.conditions.get("hasEnergy")).to.equal(true);
      expect(goal.priority).to.equal(10);
    });
  });

  describe("isSatisfied", () => {
    it("should return true when all conditions are met", () => {
      const goal = new Goal(
        new Map([
          ["hasEnergy", true],
          ["atSpawn", true],
        ]),
        5
      );
      const worldState = new Map([
        ["hasEnergy", true],
        ["atSpawn", true],
      ]);

      expect(goal.isSatisfied(worldState)).to.equal(true);
    });

    it("should return false when any condition is not met", () => {
      const goal = new Goal(
        new Map([
          ["hasEnergy", true],
          ["atSpawn", true],
        ]),
        5
      );
      const worldState = new Map([
        ["hasEnergy", true],
        ["atSpawn", false],
      ]);

      expect(goal.isSatisfied(worldState)).to.equal(false);
    });

    it("should return false when condition is missing", () => {
      const goal = new Goal(new Map([["hasEnergy", true]]), 5);
      const worldState = new Map<string, boolean>();

      expect(goal.isSatisfied(worldState)).to.equal(false);
    });

    it("should return true with no conditions", () => {
      const goal = new Goal(new Map(), 5);
      const worldState = new Map<string, boolean>();

      expect(goal.isSatisfied(worldState)).to.equal(true);
    });

    it("should handle false condition requirements", () => {
      const goal = new Goal(new Map([["underAttack", false]]), 5);

      const safe = new Map([["underAttack", false]]);
      const unsafe = new Map([["underAttack", true]]);

      expect(goal.isSatisfied(safe)).to.equal(true);
      expect(goal.isSatisfied(unsafe)).to.equal(false);
    });
  });
});

// ============================================================================
// Agent Tests
// ============================================================================

describe("Agent", () => {
  describe("construction", () => {
    it("should initialize with empty goals and actions", () => {
      const agent = new TestAgent(new WorldState(new Map()));

      expect(agent.getGoals()).to.have.length(0);
      expect(agent.getActions()).to.have.length(0);
    });
  });

  describe("addAction", () => {
    it("should add actions to available actions", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      const action = new Action("test", new Map(), new Map(), 1);

      agent.addAction(action);

      expect(agent.getActions()).to.include(action);
    });

    it("should allow multiple actions", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      const action1 = new Action("test1", new Map(), new Map(), 1);
      const action2 = new Action("test2", new Map(), new Map(), 2);

      agent.addAction(action1);
      agent.addAction(action2);

      expect(agent.getActions()).to.have.length(2);
    });
  });

  describe("addGoal", () => {
    it("should add goals and sort by priority", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      const lowPriority = new Goal(new Map([["a", true]]), 1);
      const highPriority = new Goal(new Map([["b", true]]), 10);

      agent.addGoal(lowPriority);
      agent.addGoal(highPriority);

      const goals = agent.getGoals();
      expect(goals[0]).to.equal(highPriority);
      expect(goals[1]).to.equal(lowPriority);
    });

    it("should maintain sort order when adding multiple goals", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      const goal5 = new Goal(new Map([["a", true]]), 5);
      const goal10 = new Goal(new Map([["b", true]]), 10);
      const goal7 = new Goal(new Map([["c", true]]), 7);

      agent.addGoal(goal5);
      agent.addGoal(goal10);
      agent.addGoal(goal7);

      const goals = agent.getGoals();
      expect(goals[0].priority).to.equal(10);
      expect(goals[1].priority).to.equal(7);
      expect(goals[2].priority).to.equal(5);
    });
  });

  describe("removeGoal", () => {
    it("should remove a goal", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      const goal = new Goal(new Map([["a", true]]), 5);

      agent.addGoal(goal);
      agent.removeGoal(goal);

      expect(agent.getGoals()).to.not.include(goal);
    });

    it("should not affect other goals", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      const goal1 = new Goal(new Map([["a", true]]), 5);
      const goal2 = new Goal(new Map([["b", true]]), 10);

      agent.addGoal(goal1);
      agent.addGoal(goal2);
      agent.removeGoal(goal1);

      expect(agent.getGoals()).to.include(goal2);
      expect(agent.getGoals()).to.have.length(1);
    });
  });

  describe("selectAction", () => {
    it("should return null with no goals", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      agent.addAction(new Action("test", new Map(), new Map([["a", true]]), 1));

      expect(agent.selectAction()).to.equal(null);
    });

    it("should return null with no actions", () => {
      const agent = new TestAgent(new WorldState(new Map()));
      agent.addGoal(new Goal(new Map([["a", true]]), 5));

      expect(agent.selectAction()).to.equal(null);
    });

    it("should return null when goal is already satisfied", () => {
      const agent = new TestAgent(
        new WorldState(new Map([["hasEnergy", true]]))
      );
      agent.addGoal(new Goal(new Map([["hasEnergy", true]]), 5));
      agent.addAction(
        new Action("harvest", new Map(), new Map([["hasEnergy", true]]), 1)
      );

      expect(agent.selectAction()).to.equal(null);
    });

    it("should select action that achieves goal", () => {
      const agent = new TestAgent(
        new WorldState(new Map([["atSource", true]]))
      );
      const harvestAction = new Action(
        "harvest",
        new Map([["atSource", true]]),
        new Map([["hasEnergy", true]]),
        1
      );
      agent.addGoal(new Goal(new Map([["hasEnergy", true]]), 5));
      agent.addAction(harvestAction);

      expect(agent.selectAction()).to.equal(harvestAction);
    });

    it("should select lowest cost action", () => {
      const agent = new TestAgent(new WorldState(new Map([["ready", true]])));
      const expensiveAction = new Action(
        "expensive",
        new Map([["ready", true]]),
        new Map([["done", true]]),
        10
      );
      const cheapAction = new Action(
        "cheap",
        new Map([["ready", true]]),
        new Map([["done", true]]),
        1
      );
      agent.addGoal(new Goal(new Map([["done", true]]), 5));
      agent.addAction(expensiveAction);
      agent.addAction(cheapAction);

      expect(agent.selectAction()).to.equal(cheapAction);
    });

    it("should pursue highest priority unsatisfied goal", () => {
      const agent = new TestAgent(
        new WorldState(new Map([["canWork", true]]))
      );

      const lowPriorityGoal = new Goal(new Map([["lowDone", true]]), 1);
      const highPriorityGoal = new Goal(new Map([["highDone", true]]), 10);

      const lowAction = new Action(
        "lowWork",
        new Map([["canWork", true]]),
        new Map([["lowDone", true]]),
        1
      );
      const highAction = new Action(
        "highWork",
        new Map([["canWork", true]]),
        new Map([["highDone", true]]),
        1
      );

      agent.addGoal(lowPriorityGoal);
      agent.addGoal(highPriorityGoal);
      agent.addAction(lowAction);
      agent.addAction(highAction);

      expect(agent.selectAction()).to.equal(highAction);
    });

    it("should fall back to lower priority if higher is satisfied", () => {
      const agent = new TestAgent(
        new WorldState(
          new Map([
            ["highDone", true], // High priority already done
            ["canWork", true],
          ])
        )
      );

      const lowPriorityGoal = new Goal(new Map([["lowDone", true]]), 1);
      const highPriorityGoal = new Goal(new Map([["highDone", true]]), 10);

      const lowAction = new Action(
        "lowWork",
        new Map([["canWork", true]]),
        new Map([["lowDone", true]]),
        1
      );

      agent.addGoal(lowPriorityGoal);
      agent.addGoal(highPriorityGoal);
      agent.addAction(lowAction);

      expect(agent.selectAction()).to.equal(lowAction);
    });

    it("should return null when action preconditions not met", () => {
      const agent = new TestAgent(
        new WorldState(new Map([["atSource", false]]))
      );
      const harvestAction = new Action(
        "harvest",
        new Map([["atSource", true]]), // Requires being at source
        new Map([["hasEnergy", true]]),
        1
      );
      agent.addGoal(new Goal(new Map([["hasEnergy", true]]), 5));
      agent.addAction(harvestAction);

      expect(agent.selectAction()).to.equal(null);
    });
  });

  describe("executeAction", () => {
    it("should update world state with action effects", () => {
      const agent = new TestAgent(
        new WorldState(new Map([["hasEnergy", false]]))
      );
      const action = new Action(
        "gain",
        new Map(),
        new Map([["hasEnergy", true]]),
        1
      );

      agent.executeAction(action);

      expect(agent.getWorldState().getState().get("hasEnergy")).to.equal(true);
    });
  });
});

// ============================================================================
// Scenario-Based Tests
// ============================================================================

describe("Planning Scenarios", () => {
  /**
   * Helper to run a scenario through the agent
   */
  function runScenario(scenario: PlanningScenario): Action | null {
    const worldState = createWorldState(scenario.worldState);
    const agent = new TestAgent(worldState);

    for (const actionDef of scenario.actions) {
      agent.addAction(
        createAction(
          actionDef.name,
          actionDef.preconditions,
          actionDef.effects,
          actionDef.cost
        )
      );
    }

    for (const goalDef of scenario.goals) {
      agent.addGoal(new Goal(toMap(goalDef.conditions), goalDef.priority));
    }

    return agent.selectAction();
  }

  describe("Basic Scenarios", () => {
    for (const scenario of BASIC_SCENARIOS) {
      it(`${scenario.name}: ${scenario.description}`, () => {
        const result = runScenario(scenario);

        if (scenario.expectedAction === null) {
          expect(result).to.equal(null);
        } else {
          expect(result).to.not.equal(null);
          expect(result!.name).to.equal(scenario.expectedAction);
        }
      });
    }
  });

  describe("Priority Scenarios", () => {
    for (const scenario of PRIORITY_SCENARIOS) {
      it(`${scenario.name}: ${scenario.description}`, () => {
        const result = runScenario(scenario);

        if (scenario.expectedAction === null) {
          expect(result).to.equal(null);
        } else {
          expect(result).to.not.equal(null);
          expect(result!.name).to.equal(scenario.expectedAction);
        }
      });
    }
  });

  describe("Cost Selection Scenarios", () => {
    for (const scenario of COST_SCENARIOS) {
      it(`${scenario.name}: ${scenario.description}`, () => {
        const result = runScenario(scenario);

        if (scenario.expectedAction === null) {
          expect(result).to.equal(null);
        } else {
          expect(result).to.not.equal(null);
          expect(result!.name).to.equal(scenario.expectedAction);
        }
      });
    }
  });

  describe("Edge Case Scenarios", () => {
    for (const scenario of EDGE_CASE_SCENARIOS) {
      it(`${scenario.name}: ${scenario.description}`, () => {
        const result = runScenario(scenario);

        if (scenario.expectedAction === null) {
          expect(result).to.equal(null);
        } else {
          expect(result).to.not.equal(null);
          expect(result!.name).to.equal(scenario.expectedAction);
        }
      });
    }
  });
});

// ============================================================================
// Multi-Step Planning Tests
// ============================================================================

describe("Multi-Step Planning", () => {
  /**
   * NOTE: The current GOAP implementation is greedy/reactive - it only looks at
   * direct goal contributions, not chains of actions. For multi-step workflows,
   * you need to define intermediate goals that guide the agent through the steps.
   *
   * This is by design - it keeps the planner simple and fast, while still
   * allowing complex behaviors through goal hierarchies.
   */
  it("should execute multiple actions via intermediate goals", () => {
    // Start: at source, no energy
    // Goal: controller upgraded
    // Steps: harvest -> moveToController -> upgrade
    //
    // We use intermediate goals to guide through the steps:
    // 1. hasEnergy (priority 3) - needed for both moving and upgrading
    // 2. atController (priority 2) - needed for upgrading
    // 3. controllerUpgraded (priority 1) - final goal
    const agent = new TestAgent(
      createWorldState({
        atSource: true,
        hasFreeCapacity: true,
        hasEnergy: false,
        atController: false,
        controllerUpgraded: false,
      })
    );

    agent.addAction(
      createAction(
        "harvest",
        { atSource: true, hasFreeCapacity: true },
        { hasEnergy: true, hasFreeCapacity: false },
        1
      )
    );
    agent.addAction(
      createAction(
        "moveToController",
        { hasEnergy: true, atController: false },
        { atController: true, atSource: false },
        2
      )
    );
    agent.addAction(
      createAction(
        "upgrade",
        { hasEnergy: true, atController: true },
        { controllerUpgraded: true, hasEnergy: false },
        1
      )
    );

    // Goals defined in priority order to guide through the workflow
    // Higher priority goals are checked first, but if satisfied, we move to lower
    agent.addGoal(new Goal(toMap({ hasEnergy: true }), 10));       // Step 1: Get energy
    agent.addGoal(new Goal(toMap({ atController: true }), 5));     // Step 2: Get to controller
    agent.addGoal(new Goal(toMap({ controllerUpgraded: true }), 3)); // Step 3: Upgrade

    // Step 1: Should harvest (contributes to highest unsatisfied goal: hasEnergy)
    let action = agent.selectAction();
    expect(action?.name).to.equal("harvest");
    agent.executeAction(action!);

    // Step 2: Should move to controller (hasEnergy now satisfied, atController is next)
    action = agent.selectAction();
    expect(action?.name).to.equal("moveToController");
    agent.executeAction(action!);

    // Step 3: Should upgrade (hasEnergy AND atController satisfied, but upgrade uses energy)
    // Note: After moveToController, we have energy and are at controller
    action = agent.selectAction();
    expect(action?.name).to.equal("upgrade");
    agent.executeAction(action!);

    // All goals should now be satisfied (except hasEnergy which was consumed)
    // The controllerUpgraded goal is satisfied, which was the ultimate goal
    const state = agent.getWorldState().getState();
    expect(state.get("controllerUpgraded")).to.equal(true);
  });

  it("should handle dynamic goal changes", () => {
    const agent = new TestAgent(
      createWorldState({
        hasEnergy: true,
        spawnNeedsEnergy: true,
      })
    );

    const fillSpawn = createAction(
      "fillSpawn",
      { hasEnergy: true, spawnNeedsEnergy: true },
      { spawnNeedsEnergy: false, hasEnergy: false },
      1
    );
    agent.addAction(fillSpawn);

    const fillGoal = new Goal(toMap({ spawnNeedsEnergy: false }), 10);
    agent.addGoal(fillGoal);

    // Should fill spawn
    const action = agent.selectAction();
    expect(action?.name).to.equal("fillSpawn");
    agent.executeAction(action!);

    // After filling, should have no more actions
    expect(agent.selectAction()).to.equal(null);

    // Add new goal dynamically
    const newGoal = new Goal(toMap({ hasEnergy: true }), 5);
    agent.addGoal(newGoal);

    // Still no achievable actions (no way to get energy in this setup)
    expect(agent.selectAction()).to.equal(null);
  });
});

// ============================================================================
// Factory Function Tests
// ============================================================================

describe("Factory Functions", () => {
  describe("createMineEnergyAction", () => {
    it("should create action with correct properties", () => {
      const action = createMineEnergyAction();

      expect(action.name).to.equal("mineEnergy");
      expect(action.preconditions.get("hasResource")).to.equal(false);
      expect(action.preconditions.get("hasMiner")).to.equal(true);
      expect(action.effects.get("hasResource")).to.equal(true);
      expect(action.cost).to.equal(2);
    });

    it("should be achievable with correct world state", () => {
      const action = createMineEnergyAction();
      const validState = new Map([
        ["hasResource", false],
        ["hasMiner", true],
      ]);

      expect(action.isAchievable(validState)).to.equal(true);
    });
  });

  describe("createBuildStructureAction", () => {
    it("should create action with correct properties", () => {
      const action = createBuildStructureAction();

      expect(action.name).to.equal("buildStructure");
      expect(action.preconditions.get("hasResource")).to.equal(true);
      expect(action.preconditions.get("hasBuilder")).to.equal(true);
      expect(action.effects.get("hasResource")).to.equal(false);
      expect(action.cost).to.equal(3);
    });
  });

  describe("createProfitGoal", () => {
    it("should create goal with correct properties", () => {
      const goal = createProfitGoal();

      expect(goal.conditions.get("hasResource")).to.equal(true);
      expect(goal.priority).to.equal(3);
    });
  });

  describe("factory integration", () => {
    it("should work together in a planning scenario", () => {
      const agent = new TestAgent(
        new WorldState(
          new Map([
            ["hasResource", false],
            ["hasMiner", true],
            ["hasBuilder", true],
          ])
        )
      );

      agent.addAction(createMineEnergyAction());
      agent.addAction(createBuildStructureAction());
      agent.addGoal(createProfitGoal());

      // Should mine first (cheaper and needed for profit)
      const action = agent.selectAction();
      expect(action?.name).to.equal("mineEnergy");
    });
  });
});

// ============================================================================
// Abstract Node-Resource Planning Tests
// ============================================================================

describe("Abstract Node-Resource Planning", () => {
  describe("Single Node with Source", () => {
    it("should plan to harvest from source", () => {
      const agent = new TestAgent(
        createWorldState({
          nodeHasSource: true,
          sourceHasEnergy: true,
          creepAtSource: true,
          creepHasCapacity: true,
          creepHasEnergy: false,
        })
      );

      agent.addAction(
        createAction(
          "harvestSource",
          {
            nodeHasSource: true,
            sourceHasEnergy: true,
            creepAtSource: true,
            creepHasCapacity: true,
          },
          { creepHasEnergy: true, creepHasCapacity: false },
          1
        )
      );

      agent.addGoal(new Goal(toMap({ creepHasEnergy: true }), 5));

      const action = agent.selectAction();
      expect(action?.name).to.equal("harvestSource");
    });
  });

  describe("Multi-Node Network", () => {
    it("should select closest source based on cost", () => {
      const agent = new TestAgent(
        createWorldState({
          node1HasSource: true,
          node2HasSource: true,
          node1Accessible: true,
          node2Accessible: true,
          creepHasCapacity: true,
        })
      );

      agent.addAction(
        createAction(
          "harvestNode1",
          { node1HasSource: true, node1Accessible: true, creepHasCapacity: true },
          { creepHasEnergy: true },
          3 // Close
        )
      );

      agent.addAction(
        createAction(
          "harvestNode2",
          { node2HasSource: true, node2Accessible: true, creepHasCapacity: true },
          { creepHasEnergy: true },
          7 // Far
        )
      );

      agent.addGoal(new Goal(toMap({ creepHasEnergy: true }), 5));

      const action = agent.selectAction();
      expect(action?.name).to.equal("harvestNode1");
    });

    it("should fall back to further node if closer unavailable", () => {
      const agent = new TestAgent(
        createWorldState({
          node1HasSource: true,
          node2HasSource: true,
          node1Accessible: false, // Blocked
          node2Accessible: true,
          creepHasCapacity: true,
        })
      );

      agent.addAction(
        createAction(
          "harvestNode1",
          { node1HasSource: true, node1Accessible: true, creepHasCapacity: true },
          { creepHasEnergy: true },
          3
        )
      );

      agent.addAction(
        createAction(
          "harvestNode2",
          { node2HasSource: true, node2Accessible: true, creepHasCapacity: true },
          { creepHasEnergy: true },
          7
        )
      );

      agent.addGoal(new Goal(toMap({ creepHasEnergy: true }), 5));

      const action = agent.selectAction();
      expect(action?.name).to.equal("harvestNode2");
    });
  });

  describe("Resource Type Selection", () => {
    it("should prioritize based on goal", () => {
      const agent = new TestAgent(
        createWorldState({
          hasEnergySource: true,
          hasMineralSource: true,
          canMine: true,
        })
      );

      agent.addAction(
        createAction(
          "mineEnergy",
          { hasEnergySource: true, canMine: true },
          { hasEnergy: true },
          2
        )
      );

      agent.addAction(
        createAction(
          "mineMineral",
          { hasMineralSource: true, canMine: true },
          { hasMineral: true },
          2
        )
      );

      // Energy is higher priority
      agent.addGoal(new Goal(toMap({ hasEnergy: true }), 10));
      agent.addGoal(new Goal(toMap({ hasMineral: true }), 5));

      const action = agent.selectAction();
      expect(action?.name).to.equal("mineEnergy");
    });
  });

  describe("Colony Economy Simulation", () => {
    it("should plan complete harvest-deliver cycle", () => {
      // This test demonstrates GOAP in a realistic colony economy scenario.
      // Key insight: GOAP goals should represent TERMINAL states, not intermediate waypoints.
      // The actions' preconditions naturally guide the agent through the correct sequence.
      //
      // Instead of intermediate location goals, we use:
      // - Actions with appropriate preconditions (harvest requires being at source)
      // - A single terminal goal (spawn has energy)
      // - The planner finds the only achievable action at each step

      const agent = new TestAgent(
        createWorldState({
          // Colony state
          spawnNeedsEnergy: true,
          // Node state
          sourceAvailable: true,
          // Creep state
          creepHasEnergy: false,
          creepAtSource: false,
          creepAtSpawn: true,
        })
      );

      // Actions form a natural sequence via their preconditions
      agent.addAction(
        createAction(
          "moveToSource",
          { creepAtSource: false, creepHasEnergy: false },  // Only move when empty and not at source
          { creepAtSource: true, creepAtSpawn: false },
          5
        )
      );

      agent.addAction(
        createAction(
          "harvest",
          { sourceAvailable: true, creepAtSource: true, creepHasEnergy: false },
          { creepHasEnergy: true },
          2
        )
      );

      agent.addAction(
        createAction(
          "moveToSpawn",
          { creepAtSpawn: false, creepHasEnergy: true },  // Only move when full and not at spawn
          { creepAtSpawn: true, creepAtSource: false },
          5
        )
      );

      agent.addAction(
        createAction(
          "deliverToSpawn",
          { creepHasEnergy: true, creepAtSpawn: true, spawnNeedsEnergy: true },
          { spawnNeedsEnergy: false, creepHasEnergy: false },
          1
        )
      );

      // Single terminal goal - spawn should have energy
      // The preconditions on actions naturally sequence the workflow
      agent.addGoal(new Goal(toMap({ spawnNeedsEnergy: false }), 10));

      // Now we need intermediate goals to make GOAP work through the chain
      // Each goal enables the next action in the sequence
      agent.addGoal(new Goal(toMap({ creepAtSource: true }), 40));     // Enables harvest
      agent.addGoal(new Goal(toMap({ creepHasEnergy: true }), 30));    // Enables moveToSpawn
      agent.addGoal(new Goal(toMap({ creepAtSpawn: true }), 20));      // Enables deliver

      // Execution sequence is determined by goal priorities and achievable actions

      // State: creepAtSource=false, creepHasEnergy=false, creepAtSpawn=true
      // Highest unsatisfied: creepAtSource=true (40), moveToSource achievable
      let action = agent.selectAction();
      expect(action?.name).to.equal("moveToSource");
      agent.executeAction(action!);

      // State: creepAtSource=true, creepHasEnergy=false, creepAtSpawn=false
      // creepAtSource satisfied (40), next: creepHasEnergy=true (30), harvest achievable
      action = agent.selectAction();
      expect(action?.name).to.equal("harvest");
      agent.executeAction(action!);

      // State: creepAtSource=true, creepHasEnergy=true, creepAtSpawn=false
      // creepAtSource satisfied (40), creepHasEnergy satisfied (30), next: creepAtSpawn=true (20)
      // moveToSpawn: needs creepAtSpawn=false (YES) and creepHasEnergy=true (YES)
      action = agent.selectAction();
      expect(action?.name).to.equal("moveToSpawn");
      agent.executeAction(action!);

      // State: creepAtSource=false, creepHasEnergy=true, creepAtSpawn=true
      // Now creepAtSource (40) is NO LONGER satisfied, but moveToSource precondition
      // requires creepHasEnergy=false, which is FALSE - so moveToSource is NOT achievable
      // Next achievable: deliverToSpawn (meets all preconditions)
      action = agent.selectAction();
      expect(action?.name).to.equal("deliverToSpawn");
      agent.executeAction(action!);

      // Goal achieved
      const state = agent.getWorldState().getState();
      expect(state.get("spawnNeedsEnergy")).to.equal(false);
    });
  });
});
