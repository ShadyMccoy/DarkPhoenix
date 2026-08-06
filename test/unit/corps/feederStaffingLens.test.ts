import { expect } from "chai";
import { ControllerFeederCorp } from "../../../src/corps/ControllerFeederCorp";

/** The corp id the base class derives from type + nodeId (see feederRouter.test). */
const CORP_ID = "moving-W1N1-controllerFeeder";

/**
 * THE HEARTBEAT MUST NOT DOUBLE-ORDER (measured t72811290).
 *
 * `getFeeders()` reads `creepsOfWorkType("feed", { includeSpawning: false })`
 * and `getSpawnDemand` counted staffing from that SAME lens. A feeder body is
 * 32 parts = ~96 ticks in the spawn, and for every one of those ticks the
 * body already being built counts as ZERO - so the demand re-arms and a second
 * one is bought.
 *
 * MEASURED: two 1600-energy feeders bought 48 ticks apart into the same corp
 * (`moving-W43N23-controllerFeeder` @ t72810657 and t72810705) against
 * `wantedFeeders: 1`, leaving `feeders: 2`. F1 put the feeder class at
 * **0.086 p/t against 0.007 planned - 12x** - and infra spend at 4.26 e/t
 * against a 1.51 budget.
 *
 * This is the CLAUDE.md staffsPost trap in its exact stated form: *"every
 * consumer of 'how many creeps does this post have' must use the SAME
 * staffsPost lens as the demand side"*, and the sibling of *"recycling counts
 * as staffing ... excluding them double-orders"*. `ClaimCorp` and
 * `ReservationCorp` already carry BOTH lenses - `includeSpawning: false` for
 * work, `true` for the count. The feeder carried only the first.
 *
 * The linchpin lift (t72809037) did not CREATE this - it made it reachable.
 * Before, the first feeder ranked below all income and waited out the 300-tick
 * starvation backstop, so a second order inside a 96-tick spawn could never
 * fund. Lifting it to the heartbeat tier funds both instantly. That is
 * falsifier (3) registered for that deploy - *"the lift turns a one-body
 * demand into a stream"* - firing exactly as written.
 */
describe("controller feeder staffing lens (no double-order while spawning)", () => {
  afterEach(() => {
    delete (global as never as { Game?: unknown }).Game;
    delete (global as never as { Memory?: unknown }).Memory;
  });

  /** A world with ONE feeder mid-spawn and none fielded. */
  function mkWorld(spawningFeeders: number, liveFeeders: number): void {
    const creeps: Record<string, unknown> = {};
    for (let i = 0; i < spawningFeeders; i++) {
      creeps[`fs${i}`] = {
        name: `fs${i}`,
        spawning: true,
        my: true,
        memory: { corpId: CORP_ID, workType: "feed" },
        store: { energy: 0, getFreeCapacity: () => 800, getUsedCapacity: () => 0 },
        pos: { x: 5, y: 5, roomName: "W1N1", getRangeTo: () => 1, findInRange: () => [] }
      };
    }
    for (let i = 0; i < liveFeeders; i++) {
      creeps[`fl${i}`] = {
        name: `fl${i}`,
        spawning: false,
        my: true,
        memory: { corpId: CORP_ID, workType: "feed" },
        store: { energy: 0, getFreeCapacity: () => 800, getUsedCapacity: () => 0 },
        pos: { x: 5, y: 5, roomName: "W1N1", getRangeTo: () => 1, findInRange: () => [] }
      };
    }
    (global as never as { Game: unknown }).Game = { time: 1000, creeps, rooms: {}, getObjectById: () => null };
    (global as never as { Memory: unknown }).Memory = { creeps: {}, rooms: {} };
  }

  it("a feeder ALREADY SPAWNING counts toward staffing - the demand must not re-arm", () => {
    mkWorld(1, 0);
    const corp = new ControllerFeederCorp("W1N1-controllerFeeder", "spawn1");
    // The lens the demand side reads. One body on the way IS one body staffed:
    // anything else re-orders every tick of a ~96-tick spawn.
    expect(corp.staffedFeeders(), "a spawning feeder must count as staffed").to.equal(1);
  });

  it("the WORK lens still excludes it - a spawning creep cannot relay", () => {
    mkWorld(1, 0);
    const corp = new ControllerFeederCorp("W1N1-controllerFeeder", "spawn1");
    expect(corp.getCreepCount(), "work-side count excludes the unborn").to.equal(0);
  });

  it("counts live and spawning together", () => {
    mkWorld(1, 1);
    const corp = new ControllerFeederCorp("W1N1-controllerFeeder", "spawn1");
    expect(corp.staffedFeeders()).to.equal(2);
    expect(corp.getCreepCount()).to.equal(1);
  });

  it("with nothing at all, staffing is zero (the demand SHOULD arm)", () => {
    mkWorld(0, 0);
    const corp = new ControllerFeederCorp("W1N1-controllerFeeder", "spawn1");
    expect(corp.staffedFeeders()).to.equal(0);
  });
});
