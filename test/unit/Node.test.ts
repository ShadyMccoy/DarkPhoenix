import { assert } from "chai";
import { Node } from "../../src/Node";

describe("Node", () => {
    let node: Node;

    beforeEach(() => {
        node = new Node("test-node", new RoomPosition(25, 25, "W1N1"), 5);
    });

    describe("constructor", () => {
        it("should initialize node with correct properties", () => {
            assert.equal(node.id, "test-node");
            assert.deepEqual(node.position, new RoomPosition(25, 25, "W1N1"));
            assert.equal(node.height, 5);
            assert.deepEqual(node.assets, []);
            assert.deepEqual(node.memory, {});
            assert.deepEqual(node.territory, []);
            assert.deepEqual(node.connections, []);
        });

        it("should accept custom assets", () => {
            const customAssets = [{ type: "energy", amount: 100 }];
            const nodeWithAssets = new Node("test-node", new RoomPosition(25, 25, "W1N1"), 5, customAssets as any);

            assert.deepEqual(nodeWithAssets.assets, customAssets);
        });
    });

    describe("localPlan", () => {
        it("should log planning message", () => {
            // This is a stub method, just ensure it doesn't throw
            assert.doesNotThrow(() => node.localPlan());
        });
    });

    describe("memory management", () => {
        it("should update memory", () => {
            node.updateMemory("testKey", "testValue");
            assert.equal(node.getMemory("testKey"), "testValue");
        });

        it("should return undefined for non-existent keys", () => {
            assert.isUndefined(node.getMemory("nonExistent"));
        });
    });

    describe("run", () => {
        it("should log running message", () => {
            // This is a stub method, just ensure it doesn't throw
            assert.doesNotThrow(() => node.run());
        });
    });

    describe("territory management", () => {
        it("should initialize with empty territory", () => {
            assert.deepEqual(node.territory, []);
        });

        it("should allow territory modification", () => {
            const positions = [
                new RoomPosition(24, 24, "W1N1"),
                new RoomPosition(25, 24, "W1N1"),
                new RoomPosition(26, 24, "W1N1")
            ];

            node.territory = positions;
            assert.deepEqual(node.territory, positions);
        });
    });

    describe("connections", () => {
        it("should initialize with empty connections", () => {
            assert.deepEqual(node.connections, []);
        });

        it("should allow connections modification", () => {
            node.connections = ["node-1", "node-2"];
            assert.deepEqual(node.connections, ["node-1", "node-2"]);
        });
    });
});
