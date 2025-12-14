export const Game = {
    creeps: {} as any,
    rooms: {} as any,
    time: 0,
    spawns: {} as any,
    structures: {} as any,
    cpu: {
        getUsed: () => 0,
        limit: 100,
    },
    getObjectById: (id: string) => null as any,
};

export const Memory = {
    creeps: {} as any,
    rooms: {} as any,
    spawns: {} as any,
    colonies: {} as any,
    nodeNetwork: { nodes: {} as any, edges: {} as any },
};
