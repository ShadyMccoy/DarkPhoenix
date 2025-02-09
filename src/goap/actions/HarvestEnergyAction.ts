import { BaseAction } from '../Action';
import { Node } from '../../Node';

export class HarvestEnergyAction extends BaseAction {
    constructor(node: Node) {
        super(node);
        this.name = 'HarvestEnergy';
        this.cost = 1;
        this.preconditions = {
            'availableHarvester': 1
        };
        this.effects = {
            'energy': 10
        };
    }

    perform(): boolean {
        // Implementation would go here
        return true;
    }
}
