export interface GoapState {
    [key: string]: number;  // Resource amounts, e.g., { "energy": 100 }
}

export interface GoapAction {
    name: string;
    cost: number;
    preconditions: GoapState;
    effects: GoapState;
}

export interface GoapPlan {
    actions: GoapAction[];
    totalCost: number;
}
