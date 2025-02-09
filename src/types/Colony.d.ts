export interface ColonyMemory {
    id: string;
    rootRoomName: string;
    roomNames: string[];
    nodes: { [nodeId: string]: any };
}
