import { Node } from "../Node";
import { NodeAgentRoutine } from "./NodeAgentRoutine";

export class NodeRoutine extends NodeAgentRoutine {
    private subRoutines: NodeAgentRoutine[] = [];

    constructor(node: Node, routines: NodeAgentRoutine[]) {
        super(node);
        this.subRoutines = routines;

        // Combine requirements and outputs from all subroutines
        this.requirements = this.combineRequirements();
        this.outputs = this.combineOutputs();
    }

    private combineRequirements(): { type: string, size: number }[] {
        const combined = new Map<string, number>();

        this.subRoutines.forEach(routine => {
            routine.getRequirements().forEach(req => {
                const current = combined.get(req.type) || 0;
                combined.set(req.type, current + req.size);
            });
        });

        return Array.from(combined.entries()).map(([type, size]) => ({ type, size }));
    }

    private combineOutputs(): { type: string, size: number }[] {
        const combined = new Map<string, number>();

        this.subRoutines.forEach(routine => {
            routine.getOutputs().forEach(output => {
                const current = combined.get(output.type) || 0;
                combined.set(output.type, current + output.size);
            });
        });

        return Array.from(combined.entries()).map(([type, size]) => ({ type, size }));
    }

    protected calculateExpectedValue(): number {
        // Sum the expected values of all subroutines
        return this.subRoutines.reduce((sum, routine) => {
            return sum + routine.getExpectedValue();
        }, 0);
    }

    initialize(): void {
        // Initialize all subroutines
        this.subRoutines.forEach(routine => {
            if (!routine.isInitialized()) {
                routine.initialize();
            }
        });
    }

    run(): void {
        // Run all subroutines
        this.subRoutines.forEach(routine => routine.process());
    }

    // Override setAssets to distribute assets to subroutines
    public setAssets(assets: { type: string, size: number }[]): void {
        super.setAssets(assets);
        // You might want to implement logic here to distribute assets
        // among subroutines based on their requirements
        this.subRoutines.forEach(routine => routine.setAssets(assets));
    }
}
