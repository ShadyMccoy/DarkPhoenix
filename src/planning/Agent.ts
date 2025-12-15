/**
 * @fileoverview GOAP (Goal-Oriented Action Planning) system.
 *
 * This module provides a framework for goal-oriented behavior planning
 * using the GOAP pattern. Agents pursue goals by selecting actions
 * based on preconditions, effects, and costs.
 *
 * ## GOAP Overview
 *
 * GOAP is a planning technique where:
 * 1. **Goals** define desired world states
 * 2. **Actions** transform the world state (with preconditions and effects)
 * 3. **Planner** finds action sequences that achieve goals
 *
 * This enables emergent behavior without hardcoded state machines.
 *
 * ## Usage
 *
 * 1. Define actions with preconditions and effects
 * 2. Add goals with priority levels
 * 3. Agent selects actions that satisfy highest-priority unsatisfied goal
 *
 * @module planning/Agent
 */

/**
 * An action that can be executed to change the world state.
 *
 * Actions are the building blocks of GOAP plans. Each action has:
 * - Preconditions: What must be true to execute
 * - Effects: What becomes true after execution
 * - Cost: Used for action selection (prefer lower cost)
 *
 * @example
 * const harvestAction = new Action(
 *   'harvest',
 *   new Map([['atSource', true], ['hasFreeCapacity', true]]),
 *   new Map([['hasEnergy', true]]),
 *   1
 * );
 */
export class Action {
  /**
   * Creates a new action.
   *
   * @param name - Unique identifier for the action
   * @param preconditions - Conditions that must be true to execute
   * @param effects - Conditions that become true after execution
   * @param cost - Action cost (lower is preferred)
   */
  constructor(
    public name: string,
    public preconditions: Map<string, boolean>,
    public effects: Map<string, boolean>,
    public cost: number
  ) {}

  /**
   * Checks if this action can be executed in the given world state.
   *
   * @param worldState - Current world state
   * @returns True if all preconditions are met
   */
  isAchievable(worldState: Map<string, boolean>): boolean {
    for (const [condition, value] of this.preconditions.entries()) {
      if (worldState.get(condition) !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if this action contributes toward a goal.
   *
   * An action contributes if any of its effects match goal conditions.
   *
   * @param goal - Goal to check against
   * @returns True if action helps achieve the goal
   */
  contributesToGoal(goal: Goal): boolean {
    for (const [condition, value] of goal.conditions.entries()) {
      if (this.effects.get(condition) === value) {
        return true;
      }
    }
    return false;
  }
}

/**
 * A goal representing a desired world state.
 *
 * Goals drive agent behavior. Higher priority goals are pursued first.
 *
 * @example
 * const fillSpawnGoal = new Goal(
 *   new Map([['spawnFull', true]]),
 *   10 // High priority
 * );
 */
export class Goal {
  /**
   * Creates a new goal.
   *
   * @param conditions - World state conditions that satisfy this goal
   * @param priority - Goal priority (higher = more important)
   */
  constructor(
    public conditions: Map<string, boolean>,
    public priority: number
  ) {}

  /**
   * Checks if this goal is satisfied by the current world state.
   *
   * @param worldState - Current world state
   * @returns True if all goal conditions are met
   */
  isSatisfied(worldState: Map<string, boolean>): boolean {
    for (const [condition, value] of this.conditions.entries()) {
      if (worldState.get(condition) !== value) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Tracks and manipulates world state for planning.
 *
 * World state is represented as boolean conditions that can be
 * queried and modified by actions.
 *
 * @example
 * const world = new WorldState(new Map([
 *   ['hasEnergy', false],
 *   ['atSpawn', true]
 * ]));
 */
export class WorldState {
  private state: Map<string, boolean>;

  /**
   * Creates a new world state.
   *
   * @param initialState - Initial condition values
   */
  constructor(initialState: Map<string, boolean>) {
    this.state = initialState;
  }

  /**
   * Updates the world state with new values.
   *
   * @param newState - Conditions to update
   */
  updateState(newState: Map<string, boolean>): void {
    for (const [condition, value] of newState.entries()) {
      this.state.set(condition, value);
    }
  }

  /**
   * Gets a copy of the current state.
   *
   * @returns Copy of the state map
   */
  getState(): Map<string, boolean> {
    return new Map(this.state);
  }

  /**
   * Creates a new world state with an action's effects applied.
   *
   * @param action - Action whose effects to apply
   * @returns New world state with effects applied
   */
  applyAction(action: Action): WorldState {
    const newState = new WorldState(this.getState());
    newState.updateState(action.effects);
    return newState;
  }
}

/**
 * Abstract base class for GOAP agents.
 *
 * Agents maintain goals and available actions, selecting the best
 * action to pursue their highest-priority unsatisfied goal.
 *
 * Subclasses implement `performAction()` to execute selected actions.
 */
export abstract class Agent {
  /** Goals ordered by priority (highest first) */
  protected currentGoals: Goal[];

  /** Actions available to this agent */
  protected availableActions: Action[];

  /** Current world state as perceived by the agent */
  protected worldState: WorldState;

  /**
   * Creates a new agent.
   *
   * @param initialWorldState - Initial world state
   */
  constructor(initialWorldState: WorldState) {
    this.currentGoals = [];
    this.availableActions = [];
    this.worldState = initialWorldState;
  }

  /**
   * Adds an action to the agent's repertoire.
   *
   * @param action - Action to add
   */
  addAction(action: Action): void {
    this.availableActions.push(action);
  }

  /**
   * Adds a goal for the agent to pursue.
   *
   * Goals are automatically sorted by priority.
   *
   * @param goal - Goal to add
   */
  addGoal(goal: Goal): void {
    this.currentGoals.push(goal);
    this.currentGoals.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Removes a goal from the agent.
   *
   * @param goal - Goal to remove
   */
  removeGoal(goal: Goal): void {
    this.currentGoals = this.currentGoals.filter((g) => g !== goal);
  }

  /**
   * Selects the best action to perform.
   *
   * Selection process:
   * 1. Find highest-priority unsatisfied goal
   * 2. Find achievable actions that contribute to it
   * 3. Return lowest-cost action
   *
   * @returns Best action, or null if none available
   */
  selectAction(): Action | null {
    const currentState = this.worldState.getState();

    // Find the highest priority unsatisfied goal
    for (const goal of this.currentGoals) {
      if (goal.isSatisfied(currentState)) {
        continue; // Goal already satisfied, check next
      }

      // Find an achievable action that contributes to this goal
      const candidateActions = this.availableActions
        .filter(
          (action) =>
            action.isAchievable(currentState) && action.contributesToGoal(goal)
        )
        .sort((a, b) => a.cost - b.cost);

      if (candidateActions.length > 0) {
        return candidateActions[0];
      }
    }

    return null;
  }

  /**
   * Executes an action and updates world state.
   *
   * @param action - Action to execute
   */
  executeAction(action: Action): void {
    this.worldState.updateState(action.effects);
  }

  /**
   * Performs the agent's action for this tick.
   *
   * Must be implemented by subclasses to define actual behavior.
   */
  abstract performAction(): void;
}

// ============================================================================
// Example Factory Functions
// ============================================================================

/**
 * Creates a standard "mine energy" action.
 *
 * Preconditions: No energy, has miner
 * Effects: Has energy
 * Cost: 2
 */
export const createMineEnergyAction = () =>
  new Action(
    "mineEnergy",
    new Map([
      ["hasResource", false],
      ["hasMiner", true],
    ]),
    new Map([["hasResource", true]]),
    2
  );

/**
 * Creates a standard "build structure" action.
 *
 * Preconditions: Has energy, has builder
 * Effects: Uses energy
 * Cost: 3
 */
export const createBuildStructureAction = () =>
  new Action(
    "buildStructure",
    new Map([
      ["hasResource", true],
      ["hasBuilder", true],
    ]),
    new Map([["hasResource", false]]),
    3
  );

/**
 * Creates a standard profit goal.
 *
 * Conditions: Has resource
 * Priority: 3
 */
export const createProfitGoal = () =>
  new Goal(new Map([["hasResource", true]]), 3);
