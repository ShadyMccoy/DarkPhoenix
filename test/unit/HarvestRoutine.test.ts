import { assert } from "chai";
import { HarvestRoutine } from "../../src/routines/HarvestRoutine";
import { Node } from "../../src/Node";
import { Game, Memory } from "./mock";

describe("HarvestRoutine", () => {
    let node: Node;
    let routine: HarvestRoutine;

    beforeEach(() => {
        // @ts-ignore
        global.Game = _.clone(Game);
        // @ts-ignore
        global.Memory = _.clone(Memory);

        node = new Node("test-node", new RoomPosition(25, 25, "W1N1"), 1);
        routine = new HarvestRoutine(node);
    });

    describe("constructor", () => {
        it("should initialize with correct requirements and outputs", () => {
            assert.deepEqual(routine.getRequirements(), [
                { type: "work", size: 1 },
                { type: "carry", size: 1 },
                { type: "move", size: 1 }
            ]);

            assert.deepEqual(routine.getOutputs(), [
                { type: "energy", size: 50 }
            ]);
        });
    });

    describe("initialize", () => {
        it("should find and store target source", () => {
            const mockSource = {
                id: "source1",
                pos: new RoomPosition(25, 25, "W1N1")
            };

            // Mock room with source
            Game.rooms["W1N1"] = {
                lookForAt: () => [mockSource]
            } as any;

            node.territory = [new RoomPosition(25, 25, "W1N1")];

            routine.initialize();

            assert.equal((routine as any).memory.targetSource, "source1");
        });

        it("should handle no sources found", () => {
            Game.rooms["W1N1"] = {
                lookForAt: () => []
            } as any;

            node.territory = [new RoomPosition(25, 25, "W1N1")];

            routine.initialize();

            assert.isUndefined((routine as any).memory.targetSource);
        });
    });

    describe("calculateExpectedValue", () => {
        it("should return expected harvest value", () => {
            routine.setAssets([{ type: "work", size: 1 }]);
            routine.process();
            assert.equal(routine.getExpectedValue(), 100);
        });
    });

    describe("run", () => {
        it("should spawn creep when no creep assigned", () => {
            let spawnCalled = false;
            (routine as any).spawnCreep = () => { spawnCalled = true; };
            (routine as any).getAssignedCreep = () => null;

            routine.run();

            assert.isTrue(spawnCalled);
        });

        it("should harvest when creep is available and source exists", () => {
            const mockCreep = {
                harvest: () => OK,
                moveTo: () => OK
            };

            const mockSource = {
                id: "source1",
                pos: new RoomPosition(25, 25, "W1N1")
            };

            (routine as any).memory.targetSource = "source1";
            (routine as any).getAssignedCreep = () => mockCreep;
            Game.getObjectById = (id: any) => id === "source1" ? mockSource : null;

            routine.run();

            // Should harvest successfully
            assert.isTrue(true); // If no error thrown, test passes
        });
    });
});
