import { GoapState, GoapAction, GoapPlan } from './interfaces';

interface PlanNode {
    action: GoapAction | null;
    state: GoapState;
    cost: number;
    parent: PlanNode | null;
}

export class GoapPlanner {
    findPlan(
        availableActions: GoapAction[],
        currentState: GoapState,
        goalState: GoapState
    ): GoapPlan | null {
        const startNode: PlanNode = {
            action: null,
            state: currentState,
            cost: 0,
            parent: null
        };

        // Simple forward search for demonstration
        const plan = this.search(startNode, availableActions, goalState);

        console.log('plan', JSON.stringify(plan));
        if (!plan) return null;


        // Convert search result to plan
        const actions: GoapAction[] = [];
        let node: PlanNode | null = plan;
        let totalCost = node.cost;

        while (node.parent !== null) {
            if (node.action) {
                actions.unshift(node.action);
            }
            node = node.parent;
        }

        return { actions, totalCost };
    }

    private search(
        startNode: PlanNode,
        actions: GoapAction[],
        goalState: GoapState
    ): PlanNode | null {
        const visited = new Set<string>();
        const queue: PlanNode[] = [startNode];

        while (queue.length > 0) {
            const current = queue.shift()!;

            if (this.satisfiesState(current.state, goalState)) {
                return current;
            }

            const stateKey = JSON.stringify(current.state);
            if (visited.has(stateKey)) continue;
            visited.add(stateKey);

            // Try each action
            for (const action of actions) {
                if (this.satisfiesState(current.state, action.preconditions)) {
                    const newState = this.applyEffects(current.state, action.effects);
                    queue.push({
                        action: action,
                        state: newState,
                        cost: current.cost + action.cost,
                        parent: current
                    });
                }
            }
        }

        return null;
    }

    private satisfiesState(current: GoapState, required: GoapState): boolean {
        return Object.entries(required).every(
            ([key, value]) => (current[key] || 0) >= value
        );
    }

    private applyEffects(state: GoapState, effects: GoapState): GoapState {
        const newState = { ...state };
        Object.entries(effects).forEach(([key, value]) => {
            newState[key] = (newState[key] || 0) + value;
        });
        return newState;
    }
}
