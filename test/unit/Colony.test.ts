import { assert } from "chai";
import { Colony } from "../../src/Colony";
import { RoomGeography } from "../../src/RoomGeography";
import { Game, Memory } from "./mock";

describe("Colony", () => {
    beforeEach(() => {
        // @ts-ignore
        global.Game = _.clone(Game);
        // @ts-ignore
        global.Memory = _.clone(Memory);
    });

    describe("constructor", () => {
        it("should create a new colony with a room", () => {
            const mockRoom = {
                name: "W1N1",
                controller: { pos: { x: 25, y: 25, roomName: "W1N1" } },
                find: () => [],
            } as any;

            const colony = new Colony(mockRoom);

            assert.equal(colony.id, "colony-W1N1-0");
            assert.equal(colony.rootRoom, mockRoom);
            assert.isDefined(colony.memory);
            assert.deepEqual(colony.nodes, {});
        });

        it("should load existing colony memory when colonyId provided", () => {
            const mockRoom = {
                name: "W1N1",
                controller: { pos: { x: 25, y: 25, roomName: "W1N1" } },
                find: () => [],
            } as any;

            Memory.colonies["existing-colony"] = {
                id: "existing-colony",
                rootRoomName: "W1N1",
                roomNames: ["W1N1"],
                nodeIds: [],
            };

            const colony = new Colony(mockRoom, "existing-colony");

            assert.equal(colony.id, "existing-colony");
            assert.equal(colony.memory.id, "existing-colony");
        });
    });

    describe("run", () => {
        it("should execute colony lifecycle methods", () => {
            const mockRoom = {
                name: "W1N1",
                controller: { pos: { x: 25, y: 25, roomName: "W1N1" } },
                find: () => [],
            } as any;

            const colony = new Colony(mockRoom);

            // Mock the private methods
            let checkNewRoomsCalled = false;
            let runNodesCalled = false;
            let updateConnectivityCalled = false;

            (colony as any).checkNewRooms = () => { checkNewRoomsCalled = true; };
            (colony as any).runNodes = () => { runNodesCalled = true; };
            (colony as any).updateColonyConnectivity = () => { updateConnectivityCalled = true; };

            colony.run();

            assert.isTrue(checkNewRoomsCalled);
            assert.isTrue(runNodesCalled);
            assert.isTrue(updateConnectivityCalled);
        });
    });

    describe("checkNewRooms", () => {
        it("should analyze new rooms and create nodes", () => {
            const mockRoom = {
                name: "W1N1",
                controller: { pos: new RoomPosition(25, 25, "W1N1") },
                find: () => [],
                getTerrain: () => ({ get: () => 0 } as any)
            } as any;

            Game.rooms["W1N1"] = mockRoom;

            const colony = new Colony(mockRoom);
            colony.memory.roomNames = ["W1N1"];

            // Mock hasAnalyzedRoom to return false initially
            (colony as any).hasAnalyzedRoom = () => false;

            // Mock RoomGeography.updateNetwork
            let updateNetworkCalled = false;
            RoomGeography.updateNetwork = () => { updateNetworkCalled = true; };

            (colony as any).checkNewRooms();

            assert.isTrue(updateNetworkCalled);
        });
    });
});
