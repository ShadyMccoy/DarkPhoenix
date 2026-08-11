/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { controllerUpgradeCap } from "../../../src/economy/flowAdapter";
import { RCL8_UPGRADE_CAP } from "../../../src/economy/primitives";

/**
 * THE ENGINE'S LEVEL-8 THROTTLE (found live t72918307, the colony's first
 * RCL8 audit window): a level-8 controller absorbs at most
 * CONTROLLER_MAX_UPGRADE_PER_TICK = 15 energy/tick, a hard engine rule no
 * fleet size lifts. The plan did not model it - it allocated 100 e/t against
 * a 15 e/t pipe, delivery pinned at exactly 15.00, the un-absorbable 85
 * defaulted to the bank (+33.10 e/t, the E4 mountain's mechanical cause at
 * RCL8), and a 66-part upgrader fleet stood against a pipe ~3 bodies serve.
 *
 * The fix lives in the ONE lens both the sink capacity and the fleet sizing
 * read (`controllerUpgradeCap` - the #21 physical cap), so every consumer
 * reprices from one edit: allocation <= 15, valve <= 15, wartime relegated
 * floor <= 15, feeder target follows, fleet shrinks by attrition.
 */
describe("controllerUpgradeCap - the RCL8 engine throttle (spec 15 E4/P7, t72918307)", () => {
  const g = globalThis as unknown as { Game?: any };
  let saved: unknown;
  beforeEach(() => {
    saved = g.Game;
  });
  afterEach(() => {
    g.Game = saved;
  });

  /** A partial room: the parking lens throws (no lookForAt), exercising the
   *  catch path - which must still know the engine rule. */
  const partialRoom = (level: number): any => ({
    controller: { level, pos: { x: 25, y: 25, roomName: "W1N1" } },
    energyCapacityAvailable: 12900
  });

  it("mirrors the engine: 15 e/t at RCL 8, even on the defensive catch path", () => {
    expect(RCL8_UPGRADE_CAP, "CONTROLLER_MAX_UPGRADE_PER_TICK, pinned").to.equal(15);
    g.Game = { rooms: { W1N1: partialRoom(8) } };
    expect(controllerUpgradeCap("W1N1")).to.equal(15);
  });

  it("below RCL 8 the throttle does not exist - the parking bound (or Infinity) stands", () => {
    g.Game = { rooms: { W1N1: partialRoom(7) } };
    expect(controllerUpgradeCap("W1N1")).to.equal(Infinity);
  });

  it("no controller / no Game: the uncapped harness default is unchanged", () => {
    g.Game = { rooms: { W1N1: {} } };
    expect(controllerUpgradeCap("W1N1")).to.equal(Infinity);
    g.Game = undefined;
    expect(controllerUpgradeCap("W1N1")).to.equal(Infinity);
  });
});
