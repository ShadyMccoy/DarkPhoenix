import { GoapAction, GoapState } from './interfaces';
import { Node } from '../Node';

export abstract class BaseAction implements GoapAction {
    name: string;
    cost: number;
    preconditions: GoapState;
    effects: GoapState;
    protected node: Node;

    constructor(node: Node) {
        this.node = node;
        this.name = '';
        this.cost = 0;
        this.preconditions = {};
        this.effects = {};
    }

    // Optional: Add methods that actions might need
    abstract perform(): boolean;
}
