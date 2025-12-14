import { assert } from "chai";
import { Colony } from "../../src/Colony";
import { Agent } from "../../src/Agent";
import { Node } from "../../src/Node";
import { HarvestRoutine } from "../../src/routines/HarvestRoutine";
import { Game, Memory } from "./mock";

describe("Action Planning Integration", () => {
    beforeEach(() => {
        // @ts-ignore
        global.Game = _.clone(Game);
        // @ts-ignore
        global.Memory = _.clone(Memory);
    });

    describe("Colony-Node-Agent-Routine Flow", () => {
        it("should execute complete action planning cycle", () => {
            // Create mock room with resources
            const mockRoom = {
                name: "W1N1",
                controller: {
                    id: "controller1",
                    pos: new RoomPosition(40, 40, "W1N1")
                },
                find: (type: number) => {
                    if (type === FIND_SOURCES) {
                        return [{
                            id: "source1",
                            pos: new RoomPosition(10, 10, "W1N1")
                        }];
                    }
                    return [];
                },
                lookForAt: (type: string, x: number, y: number) => {
                    if (type === LOOK_SOURCES && x === 10 && y === 10) {
                        return [{
                            id: "source1",
                            pos: new RoomPosition(10, 10, "W1N1")
                        }];
                    }
                    return [];
                }
            } as any;

            Game.rooms["W1N1"] = mockRoom;

            // Create colony
            const colony = new Colony(mockRoom);

            // Create node with territory containing source
            const node = new Node("harvest-node", new RoomPosition(10, 10, "W1N1"), 1);
            node.territory = [
                new RoomPosition(10, 10, "W1N1"),
                new RoomPosition(11, 10, "W1N1"),
                new RoomPosition(10, 11, "W1N1")
            ];

            // Add node to colony
            colony["nodes"]["harvest-node"] = node;

            // Create agent for the node
            const agent = new Agent(node);

            // Add harvest routine to agent
            const harvestRoutine = new HarvestRoutine(node);
            agent.addRoutine(harvestRoutine);

            // Set assets for the routine (simulating creep assignment)
            harvestRoutine.setAssets([
                { type: "work", size: 1 },
                { type: "carry", size: 1 },
                { type: "move", size: 1 }
            ]);

            // Execute agent
            agent.run();

            // Verify routine was executed
            assert.isTrue(harvestRoutine.isInitialized());
            assert.equal(harvestRoutine.getRequirements().length, 3);
            assert.equal(harvestRoutine.getOutputs().length, 1);
        });

        it("should handle multiple routines on single node", () => {
            const node = new Node("multi-node", new RoomPosition(25, 25, "W1N1"), 1);
            const agent = new Agent(node);

            // Create multiple routine instances
            const routine1 = new HarvestRoutine(node);
            const routine2 = new HarvestRoutine(node);

            agent.addRoutine(routine1);
            agent.addRoutine(routine2);

            // Set assets for both
            routine1.setAssets([{ type: "work", size: 1 }]);
            routine2.setAssets([{ type: "work", size: 1 }]);

            // Execute
            agent.run();

            // Both should be initialized
            assert.isTrue(routine1.isInitialized());
            assert.isTrue(routine2.isInitialized());
        });

        it("should calculate expected values for planning", () => {
            const node = new Node("value-node", new RoomPosition(25, 25, "W1N1"), 1);
            const routine = new HarvestRoutine(node);

            routine.setAssets([{ type: "work", size: 1 }]);

            // Process to calculate expected value
            routine.process();

            // Expected value should be calculated
            assert.equal(routine.getExpectedValue(), 100);
        });
    });

    describe("Memory Persistence", () => {
        it("should persist colony state between ticks", () => {
            const mockRoom = {
                name: "W1N1",
                controller: { pos: new RoomPosition(25, 25, "W1N1") },
                find: () => [],
            } as any;

            // Create colony
            const colony1 = new Colony(mockRoom);
            const colonyId = colony1.id;

            // Simulate tick change - colony should be recreated from memory
            const colony2 = new Colony(mockRoom, colonyId);

            assert.equal(colony2.id, colonyId);
            assert.deepEqual(colony2.memory, Memory.colonies[colonyId]);
        });
    });
});
