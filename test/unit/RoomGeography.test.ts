import { assert } from "chai";
import { RoomGeography } from "../../src/RoomGeography";
import { Node } from "../../src/Node";
import { Game, Memory } from "./mock";

describe("RoomGeography", () => {
    beforeEach(() => {
        // @ts-ignore
        global.Game = _.clone(Game);
        // @ts-ignore
        global.Memory = _.clone(Memory);
    });

    describe("constructor", () => {
        it("should initialize with nodes", () => {
            const nodes = {};
            const geography = new RoomGeography(nodes);

            assert.equal(geography["nodes"], nodes);
        });
    });

    describe("updateNetwork", () => {
        it("should create temporary geography instance and analyze room", () => {
            const mockRoom = {
                name: "W1N1",
                controller: { pos: { x: 25, y: 25, roomName: "W1N1" } },
                find: () => [],
                getTerrain: () => ({ get: () => 0 } as any)
            } as any;

            // Should not throw when analyzing room
            assert.doesNotThrow(() => RoomGeography.updateNetwork(mockRoom));
        });
    });

    describe("analyzeRoom", () => {
        it("should analyze room and return region nodes", () => {
            const mockRoom = {
                name: "W1N1",
                controller: { pos: { x: 25, y: 25, roomName: "W1N1" } },
                find: () => [],
                getTerrain: () => ({ get: () => 0 } as any)
            } as any;

            const geography = new RoomGeography({});

            // Mock the helper methods
            RoomGeography["createDistanceTransform"] = () => new PathFinder.CostMatrix();
            RoomGeography["findPeaks"] = () => [{
                center: new RoomPosition(25, 25, "W1N1"),
                tiles: [new RoomPosition(25, 25, "W1N1")],
                height: 1
            }];
            geography["createEdges"] = () => [];
            RoomGeography["peaksToRegionNodes"] = () => [{
                id: "test-node",
                position: new RoomPosition(25, 25, "W1N1"),
                territory: [new RoomPosition(25, 25, "W1N1")],
                resources: []
            }];

            const result = geography.analyzeRoom(mockRoom);

            assert.isArray(result);
            assert.equal(result.length, 1);
            assert.equal(result[0].id, "test-node");
        });
    });

    describe("peaksToRegionNodes", () => {
        it("should convert peaks to region nodes with resources", () => {
            const mockRoom = {
                name: "W1N1",
                controller: {
                    id: "controller1",
                    pos: new RoomPosition(25, 25, "W1N1")
                },
                find: (type: number) => {
                    if (type === FIND_SOURCES) {
                        return [{
                            id: "source1",
                            pos: new RoomPosition(24, 24, "W1N1")
                        }];
                    }
                    if (type === FIND_MINERALS) {
                        return [{
                            id: "mineral1",
                            pos: new RoomPosition(26, 26, "W1N1")
                        }];
                    }
                    return [];
                },
            } as any;

            const geography = new RoomGeography({});
            const peaks = [{
                center: new RoomPosition(25, 25, "W1N1"),
                tiles: [new RoomPosition(25, 25, "W1N1")],
                height: 1
            }];

            const result = geography["peaksToRegionNodes"](mockRoom, peaks);

            assert.equal(result.length, 1);
            assert.equal(result[0].id, "node-W1N1-25-25");
            assert.equal(result[0].resources.length, 3); // source, mineral, controller
            assert.deepEqual(result[0].territory, [new RoomPosition(25, 25, "W1N1")]);
        });
    });

    describe("getEdges", () => {
        it("should return edges for connected nodes", () => {
            const mockNode1 = new Node("node1", new RoomPosition(20, 20, "W1N1"), 1);
            const mockNode2 = new Node("node2", new RoomPosition(30, 30, "W1N1"), 2);

            // Set connections
            mockNode1.connections = ["node2"];
            mockNode2.connections = ["node1"];

            const nodes = { node1: mockNode1, node2: mockNode2 };
            const geography = new RoomGeography(nodes);

            const edges = geography.getEdges();

            assert.equal(edges.length, 1);
            assert.equal(edges[0].from.center.x, 20);
            assert.equal(edges[0].to.center.x, 30);
        });
    });
});
