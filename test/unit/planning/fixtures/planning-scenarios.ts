/**
 * @fileoverview Planning scenario fixtures for GOAP testing.
 *
 * These fixtures provide abstract test scenarios for planning:
 * - Node configurations with resources (sources, minerals, etc.)
 * - Expected planner outputs for given inputs
 * - Edge cases and complex multi-goal scenarios
 *
 * Each scenario includes:
 * - Initial world state
 * - Available actions
 * - Goals to achieve
 * - Expected selected action (or null)
 */

import { Action, Goal, WorldState } from "../../../../src/planning";

// ============================================================================
// Types
// ============================================================================

/**
 * Action definition for test scenarios.
 */
export interface ActionDef {
  name: string;
  preconditions: Record<string, boolean>;
  effects: Record<string, boolean>;
  cost: number;
}

/**
 * Goal definition for test scenarios.
 */
export interface GoalDef {
  conditions: Record<string, boolean>;
  priority: number;
}

/**
 * A complete planning scenario for testing.
 */
export interface PlanningScenario {
  name: string;
  description: string;
  worldState: Record<string, boolean>;
  actions: ActionDef[];
  goals: GoalDef[];
  expectedAction: string | null;
}

// ============================================================================
// World State Helpers
// ============================================================================

/**
 * Creates a WorldState from a plain object.
 */
export function createWorldState(
  state: Record<string, boolean>
): WorldState {
  return new WorldState(new Map(Object.entries(state)));
}

/**
 * Creates a Map from a plain object for preconditions/effects.
 */
export function toMap(obj: Record<string, boolean>): Map<string, boolean> {
  return new Map(Object.entries(obj));
}

// ============================================================================
// Action Factories
// ============================================================================

/**
 * Creates an action with a simpler interface.
 */
export function createAction(
  name: string,
  preconditions: Record<string, boolean>,
  effects: Record<string, boolean>,
  cost: number
): Action {
  return new Action(name, toMap(preconditions), toMap(effects), cost);
}

// ============================================================================
// Simple Single-Goal Scenarios
// ============================================================================

/**
 * Basic harvesting scenario:
 * - Node has a source
 * - Creep needs to harvest energy
 */
export const HARVEST_ENERGY_SCENARIO: PlanningScenario = {
  name: "Harvest energy from source",
  description: "Creep at source with capacity should harvest",
  worldState: {
    atSource: true,
    hasFreeCapacity: true,
    hasEnergy: false,
  },
  actions: [
    {
      name: "harvest",
      preconditions: { atSource: true, hasFreeCapacity: true },
      effects: { hasEnergy: true },
      cost: 1,
    },
    {
      name: "moveTo",
      preconditions: { atSource: false },
      effects: { atSource: true },
      cost: 2,
    },
  ],
  goals: [{ conditions: { hasEnergy: true }, priority: 5 }],
  expectedAction: "harvest",
};

/**
 * Need to move first scenario:
 * - Not at source yet
 * - Should select moveTo action
 */
export const MOVE_TO_SOURCE_SCENARIO: PlanningScenario = {
  name: "Move to source before harvesting",
  description: "Creep not at source should move first",
  worldState: {
    atSource: false,
    hasFreeCapacity: true,
    hasEnergy: false,
  },
  actions: [
    {
      name: "harvest",
      preconditions: { atSource: true, hasFreeCapacity: true },
      effects: { hasEnergy: true },
      cost: 1,
    },
    {
      name: "moveTo",
      preconditions: { atSource: false },
      effects: { atSource: true },
      cost: 2,
    },
  ],
  goals: [{ conditions: { atSource: true }, priority: 5 }],
  expectedAction: "moveTo",
};

/**
 * Goal already satisfied scenario:
 * - Creep already has energy
 * - No action should be selected
 */
export const GOAL_SATISFIED_SCENARIO: PlanningScenario = {
  name: "Goal already satisfied",
  description: "No action when goal is already met",
  worldState: {
    atSource: true,
    hasFreeCapacity: false,
    hasEnergy: true,
  },
  actions: [
    {
      name: "harvest",
      preconditions: { atSource: true, hasFreeCapacity: true },
      effects: { hasEnergy: true },
      cost: 1,
    },
  ],
  goals: [{ conditions: { hasEnergy: true }, priority: 5 }],
  expectedAction: null,
};

// ============================================================================
// Multi-Goal Priority Scenarios
// ============================================================================

/**
 * Multiple goals with different priorities:
 * - High priority goal: keep spawn filled
 * - Low priority goal: build structures
 */
export const MULTI_GOAL_PRIORITY_SCENARIO: PlanningScenario = {
  name: "Multiple goals with priorities",
  description: "Higher priority goal should be pursued first",
  worldState: {
    hasEnergy: true,
    spawnNeedsEnergy: true,
    constructionSiteExists: true,
    atSpawn: true,
  },
  actions: [
    {
      name: "transferToSpawn",
      preconditions: { hasEnergy: true, atSpawn: true, spawnNeedsEnergy: true },
      effects: { hasEnergy: false, spawnNeedsEnergy: false },
      cost: 1,
    },
    {
      name: "build",
      preconditions: { hasEnergy: true, constructionSiteExists: true },
      effects: { hasEnergy: false },
      cost: 2,
    },
  ],
  goals: [
    { conditions: { spawnNeedsEnergy: false }, priority: 10 }, // High priority
    { conditions: { constructionSiteExists: false }, priority: 3 }, // Low priority
  ],
  expectedAction: "transferToSpawn",
};

/**
 * Lower priority goal when higher is satisfied:
 * - Spawn is full (high priority satisfied)
 * - Should work on construction (lower priority)
 */
export const FALLBACK_TO_LOWER_PRIORITY: PlanningScenario = {
  name: "Fall back to lower priority goal",
  description: "Pursue lower priority when higher is satisfied",
  worldState: {
    hasEnergy: true,
    spawnNeedsEnergy: false, // High priority goal already satisfied
    constructionSiteExists: true,
    atSpawn: true,
  },
  actions: [
    {
      name: "transferToSpawn",
      preconditions: { hasEnergy: true, atSpawn: true, spawnNeedsEnergy: true },
      effects: { hasEnergy: false, spawnNeedsEnergy: false },
      cost: 1,
    },
    {
      name: "build",
      preconditions: { hasEnergy: true, constructionSiteExists: true },
      effects: { hasEnergy: false, constructionSiteExists: false },
      cost: 2,
    },
  ],
  goals: [
    { conditions: { spawnNeedsEnergy: false }, priority: 10 },
    { conditions: { constructionSiteExists: false }, priority: 3 },
  ],
  expectedAction: "build",
};

// ============================================================================
// Cost Selection Scenarios
// ============================================================================

/**
 * Multiple actions for same goal, different costs:
 * - Two ways to get energy, one cheaper
 */
export const COST_SELECTION_SCENARIO: PlanningScenario = {
  name: "Select lowest cost action",
  description: "When multiple actions work, choose cheapest",
  worldState: {
    nearSource: true,
    nearContainer: true,
    hasFreeCapacity: true,
    hasEnergy: false,
  },
  actions: [
    {
      name: "harvestSource",
      preconditions: { nearSource: true, hasFreeCapacity: true },
      effects: { hasEnergy: true },
      cost: 3, // Slower
    },
    {
      name: "withdrawContainer",
      preconditions: { nearContainer: true, hasFreeCapacity: true },
      effects: { hasEnergy: true },
      cost: 1, // Faster
    },
  ],
  goals: [{ conditions: { hasEnergy: true }, priority: 5 }],
  expectedAction: "withdrawContainer", // Cheaper option
};

/**
 * Same cost actions - first added should be selected (stable sort)
 */
export const SAME_COST_SCENARIO: PlanningScenario = {
  name: "Same cost actions",
  description: "With equal costs, selection is deterministic",
  worldState: {
    optionA: true,
    optionB: true,
    goalAchieved: false,
  },
  actions: [
    {
      name: "actionA",
      preconditions: { optionA: true },
      effects: { goalAchieved: true },
      cost: 5,
    },
    {
      name: "actionB",
      preconditions: { optionB: true },
      effects: { goalAchieved: true },
      cost: 5,
    },
  ],
  goals: [{ conditions: { goalAchieved: true }, priority: 5 }],
  // Both have same cost, first one in sorted order wins
  expectedAction: "actionA",
};

// ============================================================================
// Resource Node Scenarios (Abstract Colony Planning)
// ============================================================================

/**
 * Room with single source:
 * - One source available
 * - Should plan to mine it
 */
export const SINGLE_SOURCE_ROOM: PlanningScenario = {
  name: "Room with single source",
  description: "Plan mining operation for single source",
  worldState: {
    sourceCount: true, // Has at least one source
    hasMiner: true,
    hasCarrier: true,
    spawnHasEnergy: false,
    sourceBeingMined: false,
  },
  actions: [
    {
      name: "assignMinerToSource",
      preconditions: { sourceCount: true, hasMiner: true, sourceBeingMined: false },
      effects: { sourceBeingMined: true },
      cost: 1,
    },
    {
      name: "carryEnergyToSpawn",
      preconditions: { sourceBeingMined: true, hasCarrier: true },
      effects: { spawnHasEnergy: true },
      cost: 2,
    },
  ],
  goals: [
    { conditions: { spawnHasEnergy: true }, priority: 10 },
    { conditions: { sourceBeingMined: true }, priority: 5 },
  ],
  expectedAction: "assignMinerToSource", // Need to mine first
};

/**
 * Room with multiple sources:
 * - Two sources, should prioritize
 */
export const MULTI_SOURCE_ROOM: PlanningScenario = {
  name: "Room with multiple sources",
  description: "Plan mining for multiple sources",
  worldState: {
    source1Available: true,
    source2Available: true,
    source1Closer: true,
    hasMiner: true,
  },
  actions: [
    {
      name: "mineSource1",
      preconditions: { source1Available: true, hasMiner: true },
      effects: { hasEnergy: true },
      cost: 2, // Closer
    },
    {
      name: "mineSource2",
      preconditions: { source2Available: true, hasMiner: true },
      effects: { hasEnergy: true },
      cost: 4, // Further
    },
  ],
  goals: [{ conditions: { hasEnergy: true }, priority: 5 }],
  expectedAction: "mineSource1", // Closer source
};

// ============================================================================
// No Valid Action Scenarios
// ============================================================================

/**
 * No action achievable:
 * - Preconditions not met for any action
 */
export const NO_ACHIEVABLE_ACTION: PlanningScenario = {
  name: "No achievable action",
  description: "Return null when no action preconditions are met",
  worldState: {
    atSource: false,
    hasFreeCapacity: false, // Can't harvest
    hasEnergy: false,
  },
  actions: [
    {
      name: "harvest",
      preconditions: { atSource: true, hasFreeCapacity: true },
      effects: { hasEnergy: true },
      cost: 1,
    },
  ],
  goals: [{ conditions: { hasEnergy: true }, priority: 5 }],
  expectedAction: null,
};

/**
 * Action available but doesn't contribute to goal:
 */
export const ACTION_DOESNT_CONTRIBUTE: PlanningScenario = {
  name: "Action doesn't contribute to goal",
  description: "Available action doesn't help achieve goal",
  worldState: {
    canMove: true,
    hasEnergy: false,
  },
  actions: [
    {
      name: "moveAround",
      preconditions: { canMove: true },
      effects: { moved: true }, // Doesn't provide energy
      cost: 1,
    },
  ],
  goals: [{ conditions: { hasEnergy: true }, priority: 5 }],
  expectedAction: null,
};

// ============================================================================
// Complex Multi-Step Scenarios
// ============================================================================

/**
 * Upgrade controller workflow:
 * - Need energy to upgrade
 * - Need to be at controller to upgrade
 * - Multiple steps required
 */
export const UPGRADE_CONTROLLER_WORKFLOW: PlanningScenario = {
  name: "Upgrade controller workflow",
  description: "Multi-step planning for controller upgrade",
  worldState: {
    hasEnergy: false,
    atController: false,
    atSource: true,
    hasFreeCapacity: true,
  },
  actions: [
    {
      name: "harvest",
      preconditions: { atSource: true, hasFreeCapacity: true },
      effects: { hasEnergy: true, hasFreeCapacity: false },
      cost: 1,
    },
    {
      name: "moveToController",
      preconditions: { hasEnergy: true, atController: false },
      effects: { atController: true, atSource: false },
      cost: 2,
    },
    {
      name: "upgradeController",
      preconditions: { hasEnergy: true, atController: true },
      effects: { hasEnergy: false, controllerUpgraded: true },
      cost: 1,
    },
  ],
  goals: [{ conditions: { controllerUpgraded: true }, priority: 5 }],
  // First step: harvest (only achievable action that starts the chain)
  expectedAction: "harvest",
};

/**
 * Defense priority scenario:
 * - Under attack, should prioritize defense
 */
export const DEFENSE_PRIORITY: PlanningScenario = {
  name: "Defense takes priority",
  description: "Combat goals override economic goals",
  worldState: {
    underAttack: true,
    hasTower: true,
    towerHasEnergy: true,
    hasEnergy: true,
    constructionSiteExists: true,
  },
  actions: [
    {
      name: "activateTowerDefense",
      preconditions: { underAttack: true, hasTower: true, towerHasEnergy: true },
      effects: { underAttack: false },
      cost: 1,
    },
    {
      name: "build",
      preconditions: { hasEnergy: true, constructionSiteExists: true },
      effects: { constructionSiteExists: false },
      cost: 2,
    },
  ],
  goals: [
    { conditions: { underAttack: false }, priority: 100 }, // Critical priority
    { conditions: { constructionSiteExists: false }, priority: 3 },
  ],
  expectedAction: "activateTowerDefense",
};

// ============================================================================
// Edge Cases
// ============================================================================

/**
 * Empty goals list:
 */
export const NO_GOALS: PlanningScenario = {
  name: "No goals defined",
  description: "Return null when no goals exist",
  worldState: {
    hasEnergy: true,
  },
  actions: [
    {
      name: "doSomething",
      preconditions: { hasEnergy: true },
      effects: { didSomething: true },
      cost: 1,
    },
  ],
  goals: [],
  expectedAction: null,
};

/**
 * Empty actions list:
 */
export const NO_ACTIONS: PlanningScenario = {
  name: "No actions available",
  description: "Return null when no actions defined",
  worldState: {
    needsEnergy: true,
  },
  actions: [],
  goals: [{ conditions: { needsEnergy: false }, priority: 5 }],
  expectedAction: null,
};

/**
 * All goals satisfied:
 */
export const ALL_GOALS_SATISFIED: PlanningScenario = {
  name: "All goals already satisfied",
  description: "Return null when all goals met",
  worldState: {
    hasEnergy: true,
    spawnFull: true,
    controllerUpgraded: true,
  },
  actions: [
    {
      name: "harvest",
      preconditions: {},
      effects: { hasEnergy: true },
      cost: 1,
    },
  ],
  goals: [
    { conditions: { hasEnergy: true }, priority: 5 },
    { conditions: { spawnFull: true }, priority: 10 },
  ],
  expectedAction: null,
};

// ============================================================================
// Scenario Collections
// ============================================================================

export const ALL_SCENARIOS: PlanningScenario[] = [
  HARVEST_ENERGY_SCENARIO,
  MOVE_TO_SOURCE_SCENARIO,
  GOAL_SATISFIED_SCENARIO,
  MULTI_GOAL_PRIORITY_SCENARIO,
  FALLBACK_TO_LOWER_PRIORITY,
  COST_SELECTION_SCENARIO,
  SAME_COST_SCENARIO,
  SINGLE_SOURCE_ROOM,
  MULTI_SOURCE_ROOM,
  NO_ACHIEVABLE_ACTION,
  ACTION_DOESNT_CONTRIBUTE,
  UPGRADE_CONTROLLER_WORKFLOW,
  DEFENSE_PRIORITY,
  NO_GOALS,
  NO_ACTIONS,
  ALL_GOALS_SATISFIED,
];

export const BASIC_SCENARIOS: PlanningScenario[] = [
  HARVEST_ENERGY_SCENARIO,
  MOVE_TO_SOURCE_SCENARIO,
  GOAL_SATISFIED_SCENARIO,
];

export const PRIORITY_SCENARIOS: PlanningScenario[] = [
  MULTI_GOAL_PRIORITY_SCENARIO,
  FALLBACK_TO_LOWER_PRIORITY,
  DEFENSE_PRIORITY,
];

export const COST_SCENARIOS: PlanningScenario[] = [
  COST_SELECTION_SCENARIO,
  SAME_COST_SCENARIO,
  MULTI_SOURCE_ROOM,
];

export const EDGE_CASE_SCENARIOS: PlanningScenario[] = [
  NO_ACHIEVABLE_ACTION,
  ACTION_DOESNT_CONTRIBUTE,
  NO_GOALS,
  NO_ACTIONS,
  ALL_GOALS_SATISFIED,
];
