import { assert } from "chai";
import { Agent } from "../../src/Agent";
import { Node } from "../../src/Node";
import { NodeAgentRoutine } from "../../src/routines/NodeAgentRoutine";

describe("Agent", () => {
    let mockNode: Node;
    let agent: Agent;

    beforeEach(() => {
        mockNode = new Node("test-node", new RoomPosition(25, 25, "W1N1"), 1);
        agent = new Agent(mockNode);
    });

    describe("constructor", () => {
        it("should create agent with node reference", () => {
            assert.equal(agent["node"], mockNode);
            assert.deepEqual(agent["routines"], []);
        });
    });

    describe("run", () => {
        it("should execute all routines", () => {
            let routine1Executed = false;
            let routine2Executed = false;

            const mockRoutine1 = {
                run: () => { routine1Executed = true; },
                initialize: () => {},
                process: function() { this.run(); },
                serialize: () => ({}),
                deserialize: () => {},
                getRequirements: () => [],
                getOutputs: () => [],
                getExpectedValue: () => 0,
                setAssets: () => {},
                getAssets: () => [],
                isInitialized: () => true,
                calculateExpectedValue: () => 0,
                saveToMemory: () => {},
                node: mockNode,
                memory: { initialized: false },
                requirements: [],
                outputs: [],
                expectedValue: 0
            } as any as NodeAgentRoutine;

            const mockRoutine2 = {
                run: () => { routine2Executed = true; },
                initialize: () => {},
                process: function() { this.run(); },
                serialize: () => ({}),
                deserialize: () => {},
                getRequirements: () => [],
                getOutputs: () => [],
                getExpectedValue: () => 0,
                setAssets: () => {},
                getAssets: () => [],
                isInitialized: () => true,
                calculateExpectedValue: () => 0,
                saveToMemory: () => {},
                node: mockNode,
                memory: { initialized: false },
                requirements: [],
                outputs: [],
                expectedValue: 0
            } as any as NodeAgentRoutine;

            agent.addRoutine(mockRoutine1);
            agent.addRoutine(mockRoutine2);

            agent.run();

            assert.isTrue(routine1Executed);
            assert.isTrue(routine2Executed);
        });

        it("should handle routine errors gracefully", () => {
            const mockRoutine = {
                run: () => { throw new Error("Test error"); },
                initialize: () => {},
                process: () => {},
                serialize: () => ({}),
                deserialize: () => {},
                getRequirements: () => [],
                getOutputs: () => [],
                getExpectedValue: () => 0,
                setAssets: () => {},
                getAssets: () => [],
                isInitialized: () => true,
                calculateExpectedValue: () => 0,
                saveToMemory: () => {},
                node: mockNode,
                memory: { initialized: false },
                requirements: [],
                outputs: [],
                expectedValue: 0
            } as any as NodeAgentRoutine;

            agent.addRoutine(mockRoutine);

            // Should not throw
            assert.doesNotThrow(() => agent.run());
        });
    });

    describe("addRoutine", () => {
        it("should add routine to routines array", () => {
            const mockRoutine = {
                initialize: () => {}
            } as NodeAgentRoutine;
            agent.addRoutine(mockRoutine);

            assert.equal(agent["routines"].length, 1);
            assert.equal(agent["routines"][0], mockRoutine);
        });

        it("should initialize the routine", () => {
            let initialized = false;
            const mockRoutine = {
                initialize: () => { initialized = true; }
            } as NodeAgentRoutine;

            agent.addRoutine(mockRoutine);

            assert.isTrue(initialized);
        });
    });

    describe("removeRoutine", () => {
        it("should remove routine from routines array", () => {
            const mockRoutine1 = {
                initialize: () => {}
            } as NodeAgentRoutine;
            const mockRoutine2 = {
                initialize: () => {}
            } as NodeAgentRoutine;

            agent.addRoutine(mockRoutine1);
            agent.addRoutine(mockRoutine2);

            agent.removeRoutine(mockRoutine1);

            assert.equal(agent["routines"].length, 1);
            assert.equal(agent["routines"][0], mockRoutine2);
        });
    });
});
