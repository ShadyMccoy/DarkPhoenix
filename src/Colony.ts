import { RoomGeography } from "./RoomGeography";
import { NodeRoutine } from "./NodeRoutine";
import { NodeAgentRoutine } from "./routines/NodeAgentRoutine";
import { Bootstrap } from "./routines/Bootstrap";
import { EnergyMining } from "./routines/EnergyMining";
import { EnergyCarrying } from "./routines/EnergyCarrying";

interface ColonyMemory {
    id: string;
    rootRoomName: string;  // The room where this colony started
    roomNames: string[];   // All rooms that are part of this colony
    nodeIds: string[];     // All nodes that belong to this colony
}

declare global {
    interface Memory {
        colonies: { [colonyId: string]: ColonyMemory };
    }
}

export class Colony {
    private nodes: Map<string, NodeRoutine> = new Map();
    private readonly memory: ColonyMemory;

    constructor(rootRoom: Room) {
        if (!Memory.colonies) Memory.colonies = {};

        this.memory = this.initializeColonyMemory(rootRoom);
        this.loadExistingNodes();
    }

    private initializeColonyMemory(rootRoom: Room): ColonyMemory {
        const colonyId = `colony-${rootRoom.name}-${Game.time}`;

        if (!Memory.colonies[colonyId]) {
            Memory.colonies[colonyId] = {
                id: colonyId,
                rootRoomName: rootRoom.name,
                roomNames: [rootRoom.name],
                nodeIds: []
            };
        }

        return Memory.colonies[colonyId];
    }

    get id(): string {
        return this.memory.id;
    }

    run(): void {
        this.checkNewRooms();
        this.runNodes();
        this.updateColonyConnectivity();
    }

    private checkNewRooms(): void {
        // Check for connected rooms we have vision of but haven't analyzed
        for (const roomName of this.memory.roomNames) {
            const room = Game.rooms[roomName];
            if (room && !this.hasAnalyzedRoom(room)) {
                RoomGeography.updateNetwork(room);
                this.createNodesForRoom(room);
                this.checkAdjacentRooms(room);
            }
        }
    }

    private hasAnalyzedRoom(room: Room): boolean {
        return this.memory.nodeIds.some(nodeId => nodeId.includes(room.name));
    }

    private checkAdjacentRooms(room: Room): void {
        // Get connected rooms through node network
        const connectedRooms = new Set<string>();

        for (const nodeId of this.memory.nodeIds) {
            const connections = RoomGeography.getConnectedNodes(nodeId);
            for (const connectedNodeId of connections) {
                const roomName = this.getRoomNameFromNodeId(connectedNodeId);
                if (roomName && !this.memory.roomNames.includes(roomName)) {
                    connectedRooms.add(roomName);
                }
            }
        }

        // Add new connected rooms to colony
        for (const roomName of connectedRooms) {
            if (!this.memory.roomNames.includes(roomName)) {
                this.memory.roomNames.push(roomName);
            }
        }
    }

    private getRoomNameFromNodeId(nodeId: string): string | null {
        const match = nodeId.match(/node-(.*?)-\d+-\d+/);
        return match ? match[1] : null;
    }

    private createNodesForRoom(room: Room): void {
        const nodeIds = Object.keys(Memory.nodeNetwork?.nodes || {})
            .filter(id => id.includes(room.name));

        for (const nodeId of nodeIds) {
            if (!this.memory.nodeIds.includes(nodeId)) {
                const nodeData = Memory.nodeNetwork!.nodes[nodeId];
                const node = new NodeRoutine(
                    new RoomPosition(
                        nodeData.pos.x,
                        nodeData.pos.y,
                        nodeData.pos.roomName
                    )
                );

                this.assignRoutines(node, nodeData);
                this.nodes.set(nodeId, node);
                this.memory.nodeIds.push(nodeId);
            }
        }
    }

    private updateColonyConnectivity(): void {
        // Check if colony has become disconnected
        const connectedNodes = new Set<string>();
        const toExplore = [this.memory.nodeIds[0]];

        while (toExplore.length > 0) {
            const nodeId = toExplore.pop()!;
            if (connectedNodes.has(nodeId)) continue;

            connectedNodes.add(nodeId);
            const connections = RoomGeography.getConnectedNodes(nodeId);

            for (const connectedId of connections) {
                if (this.memory.nodeIds.includes(connectedId)) {
                    toExplore.push(connectedId);
                }
            }
        }

        // If we found a disconnected part, we need to split the colony
        if (connectedNodes.size !== this.memory.nodeIds.length) {
            this.handleColonySplit(connectedNodes);
        }
    }

    private handleColonySplit(connectedNodes: Set<string>): void {
        // Create new colony for disconnected nodes
        const disconnectedNodes = this.memory.nodeIds.filter(id => !connectedNodes.has(id));
        const disconnectedRoomName = this.getRoomNameFromNodeId(disconnectedNodes[0])!;

        if (Game.rooms[disconnectedRoomName]) {
            new Colony(Game.rooms[disconnectedRoomName]);
        }

        // Update this colony's memory
        this.memory.nodeIds = Array.from(connectedNodes);
        this.memory.roomNames = this.memory.nodeIds
            .map(id => this.getRoomNameFromNodeId(id))
            .filter((name): name is string => name !== null);
    }

    private assignRoutines(node: NodeRoutine, nodeData: any): void {
        // Always add bootstrap routine to new nodes
        const bootstrap = new Bootstrap(node);
        node.addRoutine(bootstrap);

        // Add routines based on resources in territory
        for (const resource of nodeData.resources) {
            switch (resource.type) {
                case 'source':
                    const mining = new EnergyMining(node);
                    const carrying = new EnergyCarrying(node);
                    node.addRoutine(mining);
                    node.addRoutine(carrying);
                    break;
                case 'controller':
                    // Add controller-specific routines
                    break;
                // Add other resource types as needed
            }
        }
    }

    private runNodes(): void {
        for (const node of this.nodes.values()) {
            try {
                node.run();
            } catch (error) {
                console.log(`Error running node in colony ${this.id}:`, error);
            }
        }
    }

    private loadExistingNodes(): void {
        if (!Memory.nodeNetwork?.nodes) return;

        for (const [nodeId, nodeData] of Object.entries(Memory.nodeNetwork.nodes)) {
            // Only load nodes in rooms we have vision of
            if (Game.rooms[nodeData.pos.roomName]) {
                const node = new NodeRoutine(
                    new RoomPosition(
                        nodeData.pos.x,
                        nodeData.pos.y,
                        nodeData.pos.roomName
                    )
                );
                this.assignRoutines(node, nodeData);
                this.nodes.set(nodeId, node);
            }
        }
    }

    private needsConstruction(roomName: string): boolean {
        const room = Game.rooms[roomName];
        return room?.find(FIND_CONSTRUCTION_SITES).length > 0;
    }
}
