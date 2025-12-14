import { Node } from "../Node";
import { NodeAgentRoutine, RoutineMemory } from "./NodeAgentRoutine";

export interface HarvestRoutineMemory extends RoutineMemory {
    targetSource?: Id<Source>;
}

export class HarvestRoutine extends NodeAgentRoutine {
    constructor(node: Node) {
        super(node);
        this.requirements = [
            { type: "work", size: 1 },
            { type: "carry", size: 1 },
            { type: "move", size: 1 }
        ];
        this.outputs = [
            { type: "energy", size: 50 }
        ];
        (this.memory as HarvestRoutineMemory).targetSource = undefined;
    }

    initialize(): void {
        // Find nearest source in node territory
        const sources = this.node.territory
            .map(pos => Game.rooms[pos.roomName]?.lookForAt(LOOK_SOURCES, pos.x, pos.y))
            .flat()
            .filter(source => source);

        if (sources.length > 0) {
            (this.memory as HarvestRoutineMemory).targetSource = sources[0].id;
        }
    }

    run(): void {
        // Simple harvest logic - spawn creep and harvest
        const creep = this.getAssignedCreep();
        if (!creep) {
            this.spawnCreep();
            return;
        }

        const source = Game.getObjectById((this.memory as HarvestRoutineMemory).targetSource!);
        if (source && creep.harvest(source) === ERR_NOT_IN_RANGE) {
            creep.moveTo(source);
        }
    }

    private getAssignedCreep(): Creep | null {
        // In a real implementation, this would track assigned creeps
        return null;
    }

    private spawnCreep(): void {
        // In a real implementation, this would spawn a creep with required parts
        console.log(`Spawning creep for harvest routine at node ${this.node.id}`);
    }

    protected calculateExpectedValue(): number {
        // Calculate value based on source energy capacity and distance
        return 100; // Simplified
    }

    // Market participation
    public getMarketBuyOrders(): Array<{ resourceType: string; quantity: number; maxPrice: number }> {
        // Harvesters need creep bodies to function
        return [
            { resourceType: 'creep_body', quantity: 3, maxPrice: 0.6 } // WORK, CARRY, MOVE
        ];
    }

    public getMarketSellOrders(): Array<{ resourceType: string; quantity: number; minPrice: number }> {
        // Harvesters sell energy they produce
        return [
            { resourceType: 'energy', quantity: 50, minPrice: 0.08 } // Sell harvested energy
        ];
    }

    public getResourceValue(resourceType: string): number {
        switch (resourceType) {
            case 'energy': return 0.1; // Energy is valuable
            case 'creep_body': return 0.5; // Creep bodies are moderately valuable
            default: return 0;
        }
    }
}
