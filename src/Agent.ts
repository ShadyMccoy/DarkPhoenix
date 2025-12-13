export class Action {
    constructor(
        public name: string,
        public preconditions: Map<string, boolean>,
        public effects: Map<string, boolean>,
        public cost: number
    ) { }

    isAchievable(worldState: Map<string, boolean>): boolean {
        for (const [condition, value] of this.preconditions.entries()) {
            if (worldState.get(condition) !== value) {
                return false;
            }
        }
        return true;
    }

    contributesToGoal(goal: Goal): boolean {
        for (const [condition, value] of goal.conditions.entries()) {
            if (this.effects.get(condition) === value) {
                return true;
            }
        }
        return false;
    }
}

export class Goal {
    constructor(
        public conditions: Map<string, boolean>,
        public priority: number
    ) { }

    isSatisfied(worldState: Map<string, boolean>): boolean {
        for (const [condition, value] of this.conditions.entries()) {
            if (worldState.get(condition) !== value) {
                return false;
            }
        }
        return true;
    }
}

export class WorldState {
    private state: Map<string, boolean>;

    constructor(initialState: Map<string, boolean>) {
        this.state = initialState;
    }

    updateState(newState: Map<string, boolean>): void {
        for (const [condition, value] of newState.entries()) {
            this.state.set(condition, value);
        }
    }

    getState(): Map<string, boolean> {
        return new Map(this.state);
    }

    applyAction(action: Action): WorldState {
        const newState = new WorldState(this.getState());
        newState.updateState(action.effects);
        return newState;
    }
}

export abstract class Agent {
    protected currentGoals: Goal[];
    protected availableActions: Action[];
    protected worldState: WorldState;

    constructor(initialWorldState: WorldState) {
        this.currentGoals = [];
        this.availableActions = [];
        this.worldState = initialWorldState;
    }

    addAction(action: Action): void {
        this.availableActions.push(action);
    }

    addGoal(goal: Goal): void {
        this.currentGoals.push(goal);
        this.currentGoals.sort((a, b) => b.priority - a.priority);
    }

    removeGoal(goal: Goal): void {
        this.currentGoals = this.currentGoals.filter(g => g !== goal);
    }

    selectAction(): Action | null {
        const currentState = this.worldState.getState();

        // Find the highest priority unsatisfied goal
        for (const goal of this.currentGoals) {
            if (goal.isSatisfied(currentState)) {
                continue; // Goal already satisfied, check next
            }

            // Find an achievable action that contributes to this goal
            // Sort by cost to prefer cheaper actions
            const candidateActions = this.availableActions
                .filter(action =>
                    action.isAchievable(currentState) &&
                    action.contributesToGoal(goal)
                )
                .sort((a, b) => a.cost - b.cost);

            if (candidateActions.length > 0) {
                return candidateActions[0];
            }
        }

        return null;
    }

    executeAction(action: Action): void {
        this.worldState.updateState(action.effects);
    }

    abstract performAction(): void;
}

// Example actions - kept for reference but can be instantiated elsewhere
export const createMineEnergyAction = () => new Action(
    'mineEnergy',
    new Map([['hasResource', false], ['hasMiner', true]]),
    new Map([['hasResource', true]]),
    2
);

export const createBuildStructureAction = () => new Action(
    'buildStructure',
    new Map([['hasResource', true], ['hasBuilder', true]]),
    new Map([['hasResource', false]]),
    3
);

export const createProfitGoal = () => new Goal(new Map([['hasResource', true]]), 3);
