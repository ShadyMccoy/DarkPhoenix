import { BaseAction } from '../Action';
import { Node } from '../../Node';

export class AssetAction extends BaseAction {
    constructor(node: Node, assetType: string, amount: number) {
        super(node);
        this.name = `Asset_${assetType}`;
        this.cost = 0;  // Assets are free, they already exist
        this.preconditions = {};  // No preconditions, they're available
        this.effects = {
            [assetType]: amount
        };
    }

    perform(): boolean {
        return true;  // Assets always succeed, they represent existing resources
    }
}
