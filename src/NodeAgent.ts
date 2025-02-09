import { NodeRoutine, NodeRequirement, NodeOutput } from "./NodeRoutine";

interface NodeConnection {
    from: string;  // Source node ID
    to: string;    // Destination node ID
    type: string;  // Resource/service type
    amount: number;
}

export class NodeAgent {
    private nodes: Map<string, NodeRoutine> = new Map();
    private connections: NodeConnection[] = [];
    private worldState: Map<string, boolean> = new Map();

    constructor() {
        // Initialize basic world state
        this.worldState.set('initialized', true);
    }

    // Node Management
    addNode(node: NodeRoutine): void {
        this.nodes.set(node.name, node);
        node.initialize();
    }

    removeNode(nodeId: string): void {
        this.nodes.delete(nodeId);
        // Clean up any connections involving this node
        this.connections = this.connections.filter(
            conn => conn.from !== nodeId && conn.to !== nodeId
        );
    }

    // Connection Management
    connectNodes(from: string, to: string, type: string, amount: number): void {
        if (!this.nodes.has(from) || !this.nodes.has(to)) {
            console.log(`Cannot connect nodes: ${from} -> ${to} (one or both nodes missing)`);
            return;
        }

        this.connections.push({ from, to, type, amount });
    }

    // Main processing loop
    process(): void {
        // Update world state based on node states
        this.updateWorldState();

        // Process each node
        for (const node of this.nodes.values()) {
            if (node.isActive()) {
                node.process();
            }
            node.update();
        }

        // Optimize connections
        this.optimizeConnections();
    }

    // World state management
    private updateWorldState(): void {
        // Update based on node requirements and outputs
        for (const node of this.nodes.values()) {
            const requirements = node.getRequirements();
            const outputs = node.getOutputs();

            // Update state based on requirements
            requirements.forEach(req => {
                const stateKey = `has${req.type}${node.name}`;
                this.worldState.set(stateKey, false);
            });

            // Update state based on outputs
            outputs.forEach(output => {
                const stateKey = `provides${output.type}${node.name}`;
                this.worldState.set(stateKey, true);
            });
        }
    }

    // Connection optimization
    private optimizeConnections(): void {
        // Find unfulfilled requirements
        const unfulfilledRequirements = new Map<string, NodeRequirement[]>();

        for (const node of this.nodes.values()) {
            const requirements = node.getRequirements();
            const unfulfilled = requirements.filter(req => {
                const incoming = this.connections
                    .filter(conn => conn.to === node.name && conn.type === req.type)
                    .reduce((sum, conn) => sum + conn.amount, 0);
                return incoming < req.amount;
            });

            if (unfulfilled.length > 0) {
                unfulfilledRequirements.set(node.name, unfulfilled);
            }
        }

        // Try to fulfill requirements by finding matching outputs
        for (const [nodeId, requirements] of unfulfilledRequirements) {
            for (const req of requirements) {
                const potentialProviders = Array.from(this.nodes.values())
                    .filter(node =>
                        node.getOutputs().some(output =>
                            output.type === req.type &&
                            !this.connections.some(conn =>
                                conn.from === node.name &&
                                conn.to === nodeId
                            )
                        )
                    );

                // Sort providers by efficiency and distance
                const sortedProviders = potentialProviders.sort((a, b) =>
                    b.getEfficiency() - a.getEfficiency()
                );

                // Connect to the best provider
                if (sortedProviders.length > 0) {
                    this.connectNodes(
                        sortedProviders[0].name,
                        nodeId,
                        req.type,
                        req.amount
                    );
                }
            }
        }
    }

    // Serialization
    serialize(): any {
        return {
            nodes: Array.from(this.nodes.entries()).map(([id, node]) => ({
                id,
                data: node.serialize()
            })),
            connections: this.connections,
            worldState: Array.from(this.worldState.entries())
        };
    }

    deserialize(data: any): void {
        // Clear existing data
        this.nodes.clear();
        this.connections = [];
        this.worldState.clear();

        // Restore nodes
        data.nodes.forEach((nodeData: any) => {
            const node = this.createNodeFromData(nodeData);
            if (node) {
                this.nodes.set(nodeData.id, node);
            }
        });

        // Restore connections
        this.connections = data.connections;

        // Restore world state
        data.worldState.forEach(([key, value]: [string, boolean]) => {
            this.worldState.set(key, value);
        });
    }

    private createNodeFromData(nodeData: any): NodeRoutine | null {
        // This method would need to be implemented based on your specific node types
        // It should create the appropriate NodeRoutine subclass based on the serialized data
        return null;
    }
}
