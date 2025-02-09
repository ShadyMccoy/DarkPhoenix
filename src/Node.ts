import { NodeRoutine } from "routines/NodeRoutine";
import { NodeAgentRoutine } from "./routines/NodeAgentRoutine";
import { GoapState, GoapAction, GoapPlan } from './goap/interfaces';
import { GoapPlanner } from './goap/Planner';
import { AssetAction } from './goap/actions/AssetAction';
import { HarvestEnergyAction } from './goap/actions/HarvestEnergyAction';
import { SpawnHarvesterAction } from './goap/actions/SpawnHarvesterAction';
import { UpgradeControllerAction } from './goap/actions/UpgradeControllerAction';

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
    initialized: boolean;
}

interface NodeOptions {
    position?: RoomPosition;  // Optional position
    assets?: { type: string; amount: number }[];  // Optional assets
}

export class Node {
    private readonly _position?: RoomPosition;  // Make _position optional
    private routines: NodeAgentRoutine[] = [];
    private memory: RoutineMemory;
    private planner: GoapPlanner;
    private currentState: GoapState;
    private availableActions: GoapAction[];
    private currentPlan: GoapPlan | null;

    constructor({ position, assets = [] }: NodeOptions = {}) {
        this._position = position;  // Assign directly, can be undefined
        this.memory = {
            initialized: false
        };
        this.planner = new GoapPlanner();
        this.currentState = {};
        this.availableActions = [];
        this.currentPlan = null;

        this.loadAssetActions(assets);
        this.loadActions();
    }

    private loadAssetActions(assets: { type: string, amount: number }[]): void {
        assets.forEach(asset => {
            this.registerAction(new AssetAction(this, asset.type, asset.amount));
        });
    }

    private loadActions(): void {
        // Regular actions that can use the assets
        this.registerAction(new HarvestEnergyAction(this));
        this.registerAction(new SpawnHarvesterAction(this));
        this.registerAction(new UpgradeControllerAction(this));
    }

    get position(): RoomPosition | undefined {
        return this._position;
    }

    get name(): string {
        return `node-${this.position?.roomName}-${this.position?.x}-${this.position?.y}`;
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
        // Update state
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
    }

    // Helper method for resource requirements
    needsResource(type: string, amount: number): boolean {
        const requirement = this.requirements.find(r => r.type === type);
        return requirement !== undefined && requirement.amount >= amount;
    }

    serialize(): any {
        return {
            position: {
                x: this._position?.x,
                y: this._position?.y,
                roomName: this._position?.roomName
            },
            name: this.name,
            active: this.active,
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

    calculateOptimalRoutines(): void {
        //todo
    }

    private getAssets(): { type: string, size: number }[] {
        // Implementation depends on how you're storing assets
        return [];  // TODO: Implement based on your asset storage
    }

    // Update node's current state (e.g., resource amounts)
    updateState(newState: GoapState): void {
        this.currentState = { ...this.currentState, ...newState };
    }

    // Register available actions for this node
    registerAction(action: GoapAction): void {
        this.availableActions.push(action);
    }

    // Plan actions to reach a goal state
    planFor(goalState: GoapState): void {
        this.currentPlan = this.planner.findPlan(
            this.availableActions,
            this.currentState,
            goalState
        );
    }

    // Get current plan
    getCurrentPlan(): GoapPlan | null {
        return this.currentPlan;
    }
}
