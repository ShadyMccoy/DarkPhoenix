import { Node } from 'Node';
import { NodeNetworkMemory } from './types/global';

interface RegionNode {
    id: string;
    position: RoomPosition;
    territory: RoomPosition[];
    resources: {
        position: RoomPosition;
        type: 'source' | 'mineral' | 'controller' | 'structure';
        id?: Id<any>;
    }[];
}

interface Peak {
    tiles: RoomPosition[];
    center: RoomPosition;
    height: number;
}

interface Edge {
    from: Peak;
    to: Peak;
    path: RoomPosition[];
    cost: number;
}

interface Skeleton {
    peaks: Peak[];
    edges: Edge[];
}

interface QueueItem {
    position: RoomPosition;
    originatingNode: Node; // The peak node from which this position is being explored
}

// Add to Memory interface
declare global {
    interface Memory {
        nodeNetwork: NodeNetworkMemory;
    }
}

export class RoomGeography {
    private nodes: { [id: string]: Node };

    constructor(nodes: { [id: string]: Node }) {
        this.nodes = nodes;
    }

    public getEdges(): Edge[] {
        const edges: Edge[] = [];
        for (const nodeId in this.nodes) {
            const node = this.nodes[nodeId];
            if (node.connections) {
                for (const connectedNodeId of node.connections) {
                    const connectedNode = this.nodes[connectedNodeId];
                    if (connectedNode && nodeId < connectedNodeId) {
                        edges.push({
                            from: { center: node.position, tiles: node.territory, height: node.height },
                            to: { center: connectedNode.position, tiles: connectedNode.territory, height: connectedNode.height },
                            path: [], // Dummy value; update as needed
                            cost: 0   // Dummy value; update as needed
                        });
                    }
                }
            }
        }
        return edges;
    }

    public static pruneEdges(edges: Edge[], nodes: { [id: string]: Node }): Edge[] {
        return edges.filter(edge => {
            const from = edge.from.center;
            const to = edge.to.center;
            return !Object.values(nodes).some((node: Node) => {
                if (node.position.x === from.x && node.position.y === from.y) return false;
                if (node.position.x === to.x && node.position.y === to.y) return false;
                return RoomGeography.isPointOnLineSegment(from, to, node.position);
            });
        });
    }

    private static isPointOnLineSegment(start: RoomPosition, end: RoomPosition, point: RoomPosition): boolean {
        const crossProduct = (point.y - start.y) * (end.x - start.x) - (point.x - start.x) * (end.y - start.y);
        if (Math.abs(crossProduct) > 0.0001) return false; // Not collinear
        const dotProduct = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
        if (dotProduct < 0) return false; // Point is behind the start point
        const squaredLengthBA = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
        if (dotProduct > squaredLengthBA) return false; // Point is beyond the end point
        return true; // Point is on the line segment
    }

    /**
     * Analyzes a newly visible room to determine its nodes.
     * This should only be called once when we first get vision of a room.
     */
    static analyzeRoom(room: Room): RegionNode[] {
        const distanceMatrix = this.createDistanceTransform(room);
        const peaks = this.findPeaks(distanceMatrix, room);
        const edges = this.createEdges(peaks, room);
        return this.peaksToRegionNodes(room, peaks);
    }

    private static createDistanceTransform(room: Room): CostMatrix {
        const distanceMatrix = new PathFinder.CostMatrix();
        const queue: { x: number; y: number; distance: number }[] = [];
        const terrain = Game.map.getRoomTerrain(room.name);
        let highestDistance = 0;

        // Initialize with walls
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                    distanceMatrix.set(x, y, 0);
                    queue.push({ x, y, distance: 0 });
                } else {
                    distanceMatrix.set(x, y, Infinity);
                }
            }
        }

        // BFS to propagate distances
        while (queue.length > 0) {
            const { x, y, distance } = queue.shift()!;

            const neighbors = [
                { dx: -1, dy: -1 }, { dx: -1, dy: 0 }, { dx: -1, dy: 1 },
                { dx: 0, dy: 1 },
                { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
                { dx: 0, dy: -1 }
            ];

            for (const { dx, dy } of neighbors) {
                const nx = x + dx;
                const ny = y + dy;

                if (nx >= 0 && nx < 50 && ny >= 0 && ny < 50) {
                    const currentDistance = distanceMatrix.get(nx, ny);
                    const newDistance = distance + 1;

                    if (terrain.get(nx, ny) !== TERRAIN_MASK_WALL && newDistance < currentDistance) {
                        distanceMatrix.set(nx, ny, newDistance);
                        queue.push({ x: nx, y: ny, distance: newDistance });
                        highestDistance = Math.max(highestDistance, newDistance);
                    }
                }
            }
        }

        // Invert the distances
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                const originalDistance = distanceMatrix.get(x, y);
                if (originalDistance !== Infinity) {
                    const invertedDistance = 1 + highestDistance - originalDistance;
                    distanceMatrix.set(x, y, invertedDistance);
                }
            }
        }

        // Set walls to max value
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                    distanceMatrix.set(x, y, 255);
                }
            }
        }

        return distanceMatrix;
    }

    private static findPeaks(distanceMatrix: CostMatrix, room: Room): Peak[] {
        const terrain = Game.map.getRoomTerrain(room.name);
        const searchCollection: { x: number; y: number; height: number }[] = [];
        const visited = new Set<string>();
        const peaks: Peak[] = [];

        // Collect all non-wall tiles
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                    const height = distanceMatrix.get(x, y);
                    searchCollection.push({ x, y, height });
                }
            }
        }

        // Sort by height
        searchCollection.sort((a, b) => b.height - a.height);

        // Find peaks
        while (searchCollection.length > 0) {
            const tile = searchCollection.shift()!;
            if (visited.has(`${tile.x},${tile.y}`)) continue;

            // Find connected tiles of same height
            const cluster: { x: number; y: number }[] = [];
            const queue = [{ x: tile.x, y: tile.y }];

            while (queue.length > 0) {
                const { x, y } = queue.pop()!;
                const key = `${x},${y}`;

                if (visited.has(key) || distanceMatrix.get(x, y) !== tile.height) continue;

                visited.add(key);
                cluster.push({ x, y });

                // Check neighbors
                const neighbors = [
                    { dx: -1, dy: 0 }, { dx: 1, dy: 0 },
                    { dx: 0, dy: -1 }, { dx: 0, dy: 1 }
                ];

                for (const { dx, dy } of neighbors) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx >= 0 && nx < 50 && ny >= 0 && ny < 50) {
                        queue.push({ x: nx, y: ny });
                    }
                }
            }

            // Calculate centroid
            const centerX = Math.round(cluster.reduce((sum, t) => sum + t.x, 0) / cluster.length);
            const centerY = Math.round(cluster.reduce((sum, t) => sum + t.y, 0) / cluster.length);

            peaks.push({
                tiles: cluster.map(t => new RoomPosition(t.x, t.y, room.name)),
                center: new RoomPosition(centerX, centerY, room.name),
                height: tile.height
            });
        }

        // Filter peaks that are too close to larger ones
        return this.filterPeaks(peaks);
    }

    private static filterPeaks(peaks: Peak[]): Peak[] {
        peaks.sort((a, b) => b.height - a.height);

        const finalPeaks: Peak[] = [];
        const excludedPositions = new Set<string>();

        for (const peak of peaks) {
            if (excludedPositions.has(`${peak.center.x},${peak.center.y}`)) continue;

            finalPeaks.push(peak);

            // Exclude nearby positions
            const exclusionRadius = peak.height;
            for (let dx = -exclusionRadius; dx <= exclusionRadius; dx++) {
                for (let dy = -exclusionRadius; dy <= exclusionRadius; dy++) {
                    const ex = peak.center.x + dx;
                    const ey = peak.center.y + dy;
                    if (ex >= 0 && ex < 50 && ey >= 0 && ey < 50) {
                        excludedPositions.add(`${ex},${ey}`);
                    }
                }
            }
        }

        return finalPeaks;
    }

    private createEdges(peaks: Peak[], room: Room): Edge[] {
        const edges: Edge[] = [];

        // Get nodes from adjacent rooms
        const adjacentNodes = this.getAdjacentRoomNodes(room);

        // Internal edges
        for (let i = 0; i < peaks.length; i++) {
            for (let j = i + 1; j < peaks.length; j++) {
                const path = PathFinder.search(
                    peaks[i].center,
                    { pos: peaks[j].center, range: 2 },
                    { maxRooms: 1 }  // Keep internal edges within the room
                );

                if (!path.incomplete) {
                    edges.push({
                        from: peaks[i],
                        to: peaks[j],
                        path: path.path,
                        cost: path.cost,
                    });
                }
            }
        }

        // External edges to adjacent room nodes
        for (const peak of peaks) {
            for (const adjacentNode of adjacentNodes) {
                const path = PathFinder.search(
                    peak.center,
                    { pos: adjacentNode.center, range: 2 },
                    { maxRooms: 2, maxCost: 50 }  // Allow one room crossing and specify max distance
                );

                if (!path.incomplete) {
                    edges.push({
                        from: peak,
                        to: adjacentNode,
                        path: path.path,
                        cost: path.cost,
                    });
                }
            }
        }

        return this.pruneEdges(edges, this.nodes);
    }

    private static getAdjacentRoomNodes(room: Room): Peak[] {
        const adjacentNodes: Peak[] = [];
        const roomCoords = this.parseRoomName(room.name);

        // Check all adjacent rooms
        const adjacentRooms = [
            { dx: -1, dy: 0 },
            { dx: 1, dy: 0 },
            { dx: 0, dy: -1 },
            { dx: 0, dy: 1 }
        ].map(delta => this.getRoomName(roomCoords.x + delta.dx, roomCoords.y + delta.dy));

        // Get cached nodes from adjacent rooms
        for (const roomName of adjacentRooms) {
            const roomNodes = Memory.roomNodes?.[roomName];
            if (roomNodes) {
                // Convert stored nodes back to Peak format
                adjacentNodes.push(...roomNodes.map(node => ({
                    center: new RoomPosition(node.position.x, node.position.y, node.position.roomName),
                    tiles: [], // We don't need the territory info for pathfinding
                    height: 0  // Height isn't relevant for external nodes
                })));
            }
        }

        return adjacentNodes;
    }

    private static parseRoomName(roomName: string): { x: number, y: number } {
        const [, wx, wy] = roomName.match(/^[WE](\d+)[NS](\d+)$/) || [];
        const x = parseInt(wx);
        const y = parseInt(wy);
        return { x, y };
    }

    private static getRoomName(x: number, y: number): string {
        return `${x < 0 ? 'W' : 'E'}${Math.abs(x)}${y < 0 ? 'N' : 'S'}${Math.abs(y)}`;
    }

    private static peaksToRegionNodes(room: Room, peaks: Peak[]): RegionNode[] {
        return peaks.map(peak => ({
            id: `${room.name}-${peak.center.x}-${peak.center.y}`,
            position: peak.center,
            territory: peak.tiles,
            resources: this.findResourcesInTerritory(room, peak.tiles)
        }));
    }

    private static findResourcesInTerritory(room: Room, territory: RoomPosition[]): RegionNode['resources'] {
        // ... same as before ...
        // Implementation remains unchanged
        return [];
    }

    /**
     * Saves a new node to the network
     */
    private static saveNode(node: RegionNode): void {
        if (!Memory.nodeNetwork) {
            Memory.nodeNetwork = { nodes: {}, edges: {} };
        }

        Memory.nodeNetwork.nodes[node.id] = {
            pos: new RoomPosition(
                node.position.x,
                node.position.y,
                node.position.roomName
            ),
            territory: node.territory.map(pos => new RoomPosition(
                pos.x,
                pos.y,
                pos.roomName
            )),
            resources: node.resources.map(resource => ({
                id: resource.id!,
                type: resource.type as 'source' | 'mineral' | 'controller',
                pos: new RoomPosition(
                    resource.position.x,
                    resource.position.y,
                    resource.position.roomName
                )
            }))
        };
    }

    /**
     * Saves new edges to the network
     */
    private static saveEdges(edges: Edge[]): void {
        if (!Memory.nodeNetwork) {
            Memory.nodeNetwork = { nodes: {}, edges: {} };
        }

        for (const edge of edges) {
            const edgeId = this.getEdgeId(edge);
            Memory.nodeNetwork.edges[edgeId] = {
                from: this.getNodeId(edge.from.center),
                to: this.getNodeId(edge.to.center),
                path: edge.path.map(pos => new RoomPosition(
                    pos.x,
                    pos.y,
                    pos.roomName
                )),
                cost: edge.cost,
            };
        }
    }

    /**
     * Gets all nodes connected to a given node
     */
    static getConnectedNodes(nodeId: string): string[] {
        if (!Memory.nodeNetwork) return [];

        return Object.values(Memory.nodeNetwork.edges)
            .filter(edge => edge.from === nodeId || edge.to === nodeId)
            .map(edge => edge.from === nodeId ? edge.to : edge.from);
    }

    /**
     * Gets the path between two nodes if they're connected
     */
    static getPathBetweenNodes(fromNodeId: string, toNodeId: string): RoomPosition[] | null {
        if (!Memory.nodeNetwork) return null;

        const edgeId = this.getEdgeIdFromNodes(fromNodeId, toNodeId);
        const edge = Memory.nodeNetwork.edges[edgeId];

        if (!edge) return null;

        return edge.path.map(pos => new RoomPosition(pos.x, pos.y, pos.roomName));
    }

    /**
     * Updates the network when a new room is analyzed
     */
    static updateNetwork(room: Room): void {
        const nodes = this.analyzeRoom(room);

        // Save new nodes
        nodes.forEach(node => this.saveNode(node));

        // Create and save new edges
        const edges = this.createEdges(
            nodes.map(node => ({
                center: node.position,
                tiles: node.territory,
                height: 0
            })),
            room
        );
        this.saveEdges(edges);

        // Prune obsolete edges
        this.pruneObsoleteEdges();
    }

    private static getNodeId(pos: RoomPosition): string {
        return `node-${pos.roomName}-${pos.x}-${pos.y}`;
    }

    private static getEdgeId(edge: Edge): string {
        const fromId = this.getNodeId(edge.from.center);
        const toId = this.getNodeId(edge.to.center);
        return `edge-${fromId}-${toId}`;
    }

    private static getEdgeIdFromNodes(fromNodeId: string, toNodeId: string): string {
        return `edge-${fromNodeId}-${toNodeId}`;
    }

    /**
     * Removes edges that are no longer valid
     */
    private static pruneObsoleteEdges(): void {
        if (!Memory.nodeNetwork) return;

        const validEdges: {[edgeId: string]: boolean} = {};

        // Check each edge
        for (const [edgeId, edge] of Object.entries(Memory.nodeNetwork.edges)) {
            // Verify both nodes still exist
            if (!Memory.nodeNetwork.nodes[edge.from] || !Memory.nodeNetwork.nodes[edge.to]) {
                delete Memory.nodeNetwork.edges[edgeId];
                continue;
            }

            // Verify path is still valid (could add more validation here)
            if (!edge.path || edge.path.length === 0) {
                delete Memory.nodeNetwork.edges[edgeId];
                continue;
            }

            validEdges[edgeId] = true;
        }

        // Clean up edges
        Memory.nodeNetwork.edges = Object.entries(Memory.nodeNetwork.edges)
            .filter(([id]) => validEdges[id])
            .reduce((acc, [id, edge]) => ({...acc, [id]: edge}), {});
    }

    static initialize(roomName: string): void {
        if (!Memory.roomNodes) {
            Memory.roomNodes = {};
        }
        if (!Memory.nodeNetwork) {
            Memory.nodeNetwork = {
                nodes: {},
                edges: {}
            };
        }
    }

    // Method to perform BFS from peaks to divide room tiles among nodes
    public bfsDivideRoom(peaks: Node[]): void {
        // Sort peaks by height in descending order
        const sortedPeaks = peaks.sort((a, b) => b.height - a.height);

        // Group peaks by height
        const peaksByHeight: { [height: number]: Node[] } = {};
        for (const peak of sortedPeaks) {
            if (!peaksByHeight[peak.height]) {
                peaksByHeight[peak.height] = [];
            }
            peaksByHeight[peak.height].push(peak);
        }

        // Perform BFS for each height level
        for (const height in peaksByHeight) {
            const currentPeaks = peaksByHeight[height];
            this.bfsFromPeaks(currentPeaks);
        }
    }

    // Method to perform BFS from a list of peaks
    private bfsFromPeaks(peaks: Node[]): void {
        const visited: Set<string> = new Set(); // To track visited tiles
        const queue: QueueItem[] = [];

        // Initialize the queue with all peaks
        for (const peak of peaks) {
            queue.push({ position: peak.position, originatingNode: peak });
        }

        while (queue.length > 0) {
            const { position: currentPosition, originatingNode } = queue.shift()!;
            const key = `${currentPosition.x},${currentPosition.y}`;

            if (visited.has(key)) continue; // Skip already visited positions
            visited.add(key);

            // Check if the current position is valid (not a wall)
            const terrain = Game.map.getRoomTerrain(currentPosition.roomName);
            if (terrain.get(currentPosition.x, currentPosition.y) !== TERRAIN_MASK_WALL) {
                // Assign the tile to the originating node
                originatingNode.territory.push(currentPosition);
            }

            // Explore neighboring tiles
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (Math.abs(dx) === Math.abs(dy)) continue; // Skip diagonals
                    const neighborX = currentPosition.x + dx;
                    const neighborY = currentPosition.y + dy;

                    if (this.isValidPosition(neighborX, neighborY, terrain)) {
                        queue.push({ position: new RoomPosition(neighborX, neighborY, currentPosition.roomName), originatingNode });
                    }
                }
            }
        }
    }

    // Method to check if a position is valid (within bounds and not a wall)
    private isValidPosition(x: number, y: number, terrain: Terrain): boolean {
        return x >= 0 && x < 50 && y >= 0 && y < 50 && terrain.get(x, y) !== TERRAIN_MASK_WALL;
    }
}
