import { RoomGeography } from "./RoomGeography";
import { Node } from "./Node";
import { ColonyMemory } from "./types/Colony";

export class Colony {
    private roomGeography: RoomGeography;
    public nodes: { [id: string]: Node };
    public memory: ColonyMemory;

    constructor() {
        this.nodes = {};
        this.memory = {
            id: '',
            rootRoomName: '',
            roomNames: [],
            nodeIds: []
        };
        this.roomGeography = new RoomGeography(this.nodes);
    }

    private createAndCheckAdjacentNodes(room: Room, distanceThreshold: number): void {
        const nodeIds = Object.keys(Memory.nodeNetwork?.nodes || {});
        const roomPosition = room.controller?.pos;

        const nearbyNodeIds = nodeIds.filter(nodeId => {
            const nodeData = Memory.nodeNetwork!.nodes[nodeId];
            const nodePosition = new RoomPosition(nodeData.pos.x, nodeData.pos.y, nodeData.pos.roomName);
            const distance = roomPosition?.getRangeTo(nodePosition) || Infinity;
            return distance <= distanceThreshold;
        });

        for (const nodeId of nearbyNodeIds) {
            if (!this.memory.nodeIds.includes(nodeId)) {
                const nodeData = Memory.nodeNetwork!.nodes[nodeId];
                const nodePosition = new RoomPosition(nodeData.pos.x, nodeData.pos.y, nodeData.pos.roomName);
                const node = new Node(nodeId, nodePosition, nodeData.height);
                this.nodes[nodeId] = node;
                this.memory.nodeIds.push(nodeId);
            }
        }

        RoomGeography.pruneEdges(this.roomGeography.getEdges(), this.nodes);
    }


    private initializeColonyMemory(rootRoom: Room): ColonyMemory {
        const colonyId = `colony-${rootRoom.name}-${Game.time}`;

        if (!Memory.colonies) Memory.colonies = {};

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
                this.createAndCheckAdjacentNodes(room, 50);
            }
        }
    }

    private isPointOnLineSegment(start: RoomPosition, end: RoomPosition, point: RoomPosition): boolean {
        const crossProduct = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
        if (Math.abs(crossProduct) > 0.0001) return false; // Not collinear

        const dotProduct = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
        if (dotProduct < 0) return false; // Point is behind the start point

        const squaredLengthBA = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
        if (dotProduct > squaredLengthBA) return false; // Point is beyond the end point

        return true; // Point is on the line segment
    }

    private hasAnalyzedRoom(room: Room): boolean {
        return this.memory.nodeIds.some(nodeId => nodeId.includes(room.name));
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
    }

    private runNodes(): void {
        for (const nodeId in this.nodes) {
            try {
                this.nodes[nodeId].run();
            } catch (error) {
                console.log(`Error running node in colony`, error);
            }
        }
    }

    private loadExistingNodes(): void {
        if (!Memory.nodeNetwork?.nodes) return;

        for (const [nodeId, nodeData] of Object.entries(Memory.nodeNetwork.nodes)) {
            // Only load nodes in rooms we have vision of
            if (Game.rooms[nodeData.pos.roomName]) {
                const node = new Node(nodeId, new RoomPosition(nodeData.pos.x, nodeData.pos.y, nodeData.pos.roomName), nodeData.height);
                this.nodes[nodeId] = node;
            }
        }
    }
}
