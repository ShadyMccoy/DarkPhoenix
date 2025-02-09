import { BaseAction } from '../Action';
import { Node } from '../../Node';

export class UpgradeControllerAction extends BaseAction {
    constructor(node: Node) {
        super(node);
        this.name = 'UpgradeController';
        this.cost = 2;
        this.preconditions = {
            'energy': 20,
            'availableUpgrader': 1
        };
        this.effects = {
            'controllerProgress': 1
        };
    }

    perform(): boolean {
        // Implementation would go here
        return true;
    }
}
