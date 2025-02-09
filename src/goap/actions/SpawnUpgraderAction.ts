import { BaseAction } from '../Action';
import { Node } from '../../Node';

export class SpawnUpgraderAction extends BaseAction {
    constructor(node: Node) {
        super(node);
        this.name = 'SpawnUpgrader';
        this.cost = 3;  // Cost to spawn an upgrader
        this.preconditions = {
            'energy': 50  // Requires energy to spawn
        };
        this.effects = {
            'availableUpgrader': 1  // Produces one upgrader
        };
    }

    perform(): boolean {
        // Implementation for spawning an upgrader
        console.log('Spawning an upgrader...');
        return true;  // Indicate success
    }
}
