import { BaseAction } from '../Action';
import { Node } from '../../Node';

export class ProfitAction extends BaseAction {
    constructor(node: Node) {
        super(node);
        this.name = 'GenerateProfit';
        this.cost = 0;  // The cost is already represented in the preconditions
        this.preconditions = {
            'controllerProgress': 1  // Requires controller progress
        };
        this.effects = {
            'dollars': 10  // Generates profit
        };
    }

    perform(): boolean {
        return true;
    }
}
