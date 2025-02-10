export interface NodeNetworkMemory {
    nodes: {
        [nodeId: string]: {
            pos: RoomPosition;
            height: number;
            territory: RoomPosition[];
            resources: {
                id: Id<Source | Mineral | StructureController>;
                type: 'source' | 'mineral' | 'controller';
                pos: RoomPosition;
            }[];
        };
    };
    edges: {
        [edgeId: string]: {
            from: string;
            to: string;
            path: RoomPosition[];
            cost: number;
            type: 'internal' | 'external';
        };
    };
}

interface ColonyMemory {
    id: string;
    rootRoomName: string;
    roomNames: string[];
    nodeIds: string[];
}

interface RoomNode {
    position: {
        x: number;
        y: number;
        roomName: string;
    };
    territory: Array<{
        x: number;
        y: number;
        roomName: string;
    }>;
    resources: Array<{
        id: Id<Source | Mineral | StructureController>;
        type: 'source' | 'mineral' | 'controller';
        pos: {
            x: number;
            y: number;
            roomName: string;
        };
    }>;
}

declare global {
    interface Memory {
        colonies: { [colonyId: string]: ColonyMemory };
        nodeNetwork: NodeNetworkMemory;
        creeps: { [creepName: string]: CreepMemory };
        roomNodes: { [roomName: string]: RoomNode[] };
    }

    interface CreepMemory {
        role?: string;
        nodeId?: string;
        task?: string;
        targetId?: Id<any>;
        busy?: boolean;
        working?: boolean;
        source?: Id<Source>;
        target?: Id<Structure>;
    }
}

export {};
