/**
 * @fileoverview Goal-Oriented Action Planning (GOAP) implementation.
 *
 * Provides core GOAP primitives for AI decision making:
 * - WorldState: Represents the current state of the world as boolean predicates
 * - Action: Represents an action with preconditions, effects, and cost
 * - Goal: Represents a desired state to achieve
 * - Agent: Base class for entities that use GOAP planning
 *
 * @module planning/GOAP
 */

/**
 * Represents the state of the world as a set of boolean predicates.
 *
 * WorldState is mutable via updateState but applyAction returns a new instance.
 */
export class WorldState {
  private state: Map<string, boolean>;

  constructor(state: Map<string, boolean> = new Map()) {
    // Copy to prevent external modifications
    this.state = new Map(state);
  }

  /**
   * Gets a copy of the current state map.
   */
  getState(): Map<string, boolean> {
    return new Map(this.state);
  }

  /**
   * Gets the value of a predicate.
   */
  get(key: string): boolean | undefined {
    return this.state.get(key);
  }

  /**
   * Checks if a predicate exists and is true.
   */
  isTrue(key: string): boolean {
    return this.state.get(key) === true;
  }

  /**
   * Checks if a predicate exists and is false.
   */
  isFalse(key: string): boolean {
    return this.state.get(key) === false;
  }

  /**
   * Creates a new WorldState with the given predicate set.
   */
  set(key: string, value: boolean): WorldState {
    const newState = new Map(this.state);
    newState.set(key, value);
    return new WorldState(newState);
  }

  /**
   * Updates the internal state with the given updates (mutable).
   */
  updateState(updates: Map<string, boolean>): void {
    for (const [key, value] of updates) {
      this.state.set(key, value);
    }
  }

  /**
   * Checks if this world state satisfies all conditions in the given map.
   */
  satisfies(conditions: Map<string, boolean>): boolean {
    for (const [key, value] of conditions) {
      if (this.state.get(key) !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Applies an action's effects to create a new world state.
   */
  applyAction(action: Action): WorldState {
    const newState = new Map(this.state);
    for (const [key, value] of action.effects) {
      newState.set(key, value);
    }
    return new WorldState(newState);
  }

  /**
   * Applies effects to create a new world state.
   */
  applyEffects(effects: Map<string, boolean>): WorldState {
    const newState = new Map(this.state);
    for (const [key, value] of effects) {
      newState.set(key, value);
    }
    return new WorldState(newState);
  }

  /**
   * Returns the underlying state map (for iteration).
   */
  entries(): IterableIterator<[string, boolean]> {
    return this.state.entries();
  }

  /**
   * Returns the number of predicates.
   */
  get size(): number {
    return this.state.size;
  }
}

/**
 * Represents a goal to achieve - a set of conditions that should be true.
 */
export class Goal {
  readonly conditions: Map<string, boolean>;
  readonly priority: number;

  constructor(conditions: Map<string, boolean>, priority: number) {
    this.conditions = new Map(conditions);
    this.priority = priority;
  }

  /**
   * Checks if this goal is satisfied by the given world state.
   */
  isSatisfied(worldState: Map<string, boolean>): boolean {
    for (const [key, value] of this.conditions) {
      if (worldState.get(key) !== value) {
        return false;
      }
    }
    return true;
  }
}

/**
 * Represents an action that can be taken to change world state.
 *
 * Actions have:
 * - Preconditions that must be true to execute
 * - Effects that change the world state when executed
 * - A cost used for planning optimization
 */
export class Action {
  readonly name: string;
  readonly preconditions: Map<string, boolean>;
  readonly effects: Map<string, boolean>;
  readonly cost: number;

  constructor(
    name: string,
    preconditions: Map<string, boolean>,
    effects: Map<string, boolean>,
    cost: number
  ) {
    this.name = name;
    this.preconditions = new Map(preconditions);
    this.effects = new Map(effects);
    this.cost = cost;
  }

  /**
   * Checks if this action can be executed given a world state map.
   */
  isAchievable(worldState: Map<string, boolean>): boolean {
    for (const [key, value] of this.preconditions) {
      if (worldState.get(key) !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if this action can be executed in the given WorldState.
   */
  canExecute(worldState: WorldState): boolean {
    return worldState.satisfies(this.preconditions);
  }

  /**
   * Applies this action's effects to the world state.
   */
  execute(worldState: WorldState): WorldState {
    return worldState.applyEffects(this.effects);
  }

  /**
   * Checks if this action contributes to achieving a goal.
   */
  contributesToGoal(goal: Goal): boolean {
    for (const [key, value] of goal.conditions) {
      if (this.effects.get(key) === value) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if this action contributes to achieving goal conditions.
   */
  contributesTo(goalConditions: Map<string, boolean>): boolean {
    for (const [key, value] of goalConditions) {
      if (this.effects.get(key) === value) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Abstract base class for GOAP agents.
 *
 * Agents maintain a world state, a set of goals, and available actions.
 * The selectAction method implements the core planning algorithm.
 */
export abstract class Agent {
  protected worldState: WorldState;
  protected currentGoals: Goal[] = [];
  protected availableActions: Action[] = [];

  constructor(worldState: WorldState) {
    this.worldState = worldState;
  }

  /**
   * Adds an action to the available actions.
   */
  addAction(action: Action): void {
    this.availableActions.push(action);
  }

  /**
   * Adds a goal and maintains priority sorting (highest first).
   */
  addGoal(goal: Goal): void {
    this.currentGoals.push(goal);
    this.currentGoals.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Removes a goal from the current goals.
   */
  removeGoal(goal: Goal): void {
    const index = this.currentGoals.indexOf(goal);
    if (index !== -1) {
      this.currentGoals.splice(index, 1);
    }
  }

  /**
   * Selects the best action to achieve the highest priority unsatisfied goal.
   *
   * Algorithm:
   * 1. Iterate through goals in priority order (highest first)
   * 2. Skip goals that are already satisfied
   * 3. Find all achievable actions that contribute to the goal
   * 4. Return the lowest cost action
   *
   * @returns The best action to take, or null if no action is available
   */
  selectAction(): Action | null {
    if (this.currentGoals.length === 0 || this.availableActions.length === 0) {
      return null;
    }

    const stateMap = this.worldState.getState();

    // Find the highest priority unsatisfied goal
    for (const goal of this.currentGoals) {
      if (goal.isSatisfied(stateMap)) {
        continue;
      }

      // Find achievable actions that contribute to this goal
      const validActions = this.availableActions.filter(
        (action) =>
          action.isAchievable(stateMap) && action.contributesToGoal(goal)
      );

      if (validActions.length > 0) {
        // Sort by cost and return lowest cost action
        validActions.sort((a, b) => a.cost - b.cost);
        return validActions[0];
      }
    }

    return null;
  }

  /**
   * Executes an action, applying its effects to the world state.
   */
  executeAction(action: Action): void {
    this.worldState.updateState(action.effects);
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Creates a standard "mine energy" action.
 */
export function createMineEnergyAction(): Action {
  return new Action(
    "mineEnergy",
    new Map([
      ["hasResource", false],
      ["hasMiner", true],
    ]),
    new Map([["hasResource", true]]),
    2
  );
}

/**
 * Creates a standard "build structure" action.
 */
export function createBuildStructureAction(): Action {
  return new Action(
    "buildStructure",
    new Map([
      ["hasResource", true],
      ["hasBuilder", true],
    ]),
    new Map([["hasResource", false]]),
    3
  );
}

/**
 * Creates a standard "profit" goal (acquire resources).
 */
export function createProfitGoal(): Goal {
  return new Goal(new Map([["hasResource", true]]), 3);
}
