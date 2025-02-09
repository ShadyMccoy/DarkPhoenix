import { BaseAction } from '../Action';
import { Node } from '../../Node';

export class SpawnHarvesterAction extends BaseAction {
    constructor(node: Node) {
        super(node);
        this.name = 'SpawnHarvester';
        this.cost = 3;
        this.preconditions = {
            'energy': 50  // Needs energy to spawn
        };
        this.effects = {
            'availableHarvester': 1
        };
    }

    perform(): boolean {
        // Implementation would go here
        return true;
    }
}
