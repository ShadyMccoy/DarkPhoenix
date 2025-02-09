import { NodeAgentRoutine } from "./routines/NodeAgentRoutine";

export interface NodeRequirement {
    type: string;
    amount: number;
    priority: number;
}

export interface NodeOutput {
    type: string;
    amount: number;
    destination?: string;  // ID of receiving node
}

export interface RoutineMemory {
    efficiency: number;
    initialized: boolean;
}

export class NodeRoutine {
    private readonly _position: RoomPosition;
    private routines: NodeAgentRoutine[] = [];
    private memory: RoutineMemory;

    constructor(position: RoomPosition) {
        this._position = position;
        this.memory = {
            efficiency: 0,
            initialized: false
        };
    }

    get position(): RoomPosition {
        return this._position;
    }

    get name(): string {
        return `node-${this.position.roomName}-${this.position.x}-${this.position.y}`;
    }

    addRoutine(routine: NodeAgentRoutine): void {
        this.routines.push(routine);
        routine.initialize();
    }

    run(): void {
        for (const routine of this.routines) {
            try {
                routine.run();
            } catch (error) {
                console.log(`Error running routine in node ${this.name}:`, error);
            }
        }
    }

    // Core properties
    protected outputs: NodeOutput[] = [];
    protected positions: RoomPosition[] = [];  // A node can span multiple positions/rooms
    protected creepIds: { [role: string]: Id<Creep>[] } = {};

    // State tracking
    protected active: boolean = false;
    protected efficiency: number = 0;  // 0-1 rating of how well the node is performing

    // Core methods
    initialize(): void {
        // Setup initial state
        this.active = true;
    }

    process(): void {
        // Main routine logic
        this.run();
    }

    update(): void {
        // Update state and efficiency
        this.removeDeadCreeps();
    }

    // Requirement management
    addRequirement(req: NodeRequirement): void {
        const existing = this.requirements.find(r => r.type === req.type);
        if (existing) {
            existing.amount = Math.max(existing.amount, req.amount);
            existing.priority = Math.max(existing.priority, req.priority);
        } else {
            this.requirements.push(req);
        }
    }

    getRequirements(): NodeRequirement[] {
        return this.requirements;
    }

    // Output management
    addOutput(output: NodeOutput): void {
        const existing = this.outputs.find(o => o.type === output.type);
        if (existing) {
            existing.amount = output.amount;
        } else {
            this.outputs.push(output);
        }
    }

    getOutputs(): NodeOutput[] {
        return this.outputs;
    }

    // State management
    isActive(): boolean {
        return this.active;
    }

    getEfficiency(): number {
        return this.efficiency;
    }

    // Position management
    addPosition(pos: RoomPosition): void {
        this.positions.push(pos);
    }

    getPositions(): RoomPosition[] {
        return this.positions;
    }

    // Creep management
    protected removeDeadCreeps(): void {
        for (const role in this.creepIds) {
            this.creepIds[role] = this.creepIds[role].filter(id => Game.getObjectById(id) !== null);
        }
    }

    protected assignCreep(creep: Creep, role: string): void {
        if (!this.creepIds[role]) {
            this.creepIds[role] = [];
        }
        this.creepIds[role].push(creep.id);
        creep.memory.nodeId = this.name;
        creep.memory.role = role;
    }

    // Helper method for resource requirements
    needsResource(type: string, amount: number): boolean {
        const requirement = this.requirements.find(r => r.type === type);
        return requirement !== undefined && requirement.amount >= amount;
    }

    serialize(): any {
        return {
            position: {
                x: this._position.x,
                y: this._position.y,
                roomName: this._position.roomName
            },
            name: this.name,
            active: this.active,
            efficiency: this.efficiency,
            requirements: this.requirements,
            outputs: this.outputs,
            positions: this.positions.map(pos => ({
                x: pos.x,
                y: pos.y,
                roomName: pos.roomName
            })),
            creepIds: this.creepIds,
            memory: this.memory
        };
    }

    private requirements: NodeRequirement[] = [];
}
