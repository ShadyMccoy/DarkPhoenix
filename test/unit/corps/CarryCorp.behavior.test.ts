import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import { CarryCorp, pickSinkByAllocation } from "../../../src/corps/CarryCorp";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";
import { Game as MockGame } from "../mock";

/**
 * Trivial, deterministic scenarios that pin down a CarryCorp's *observable*
 * behaviour - the "does a hauling corp of a certain size do what it's supposed
 * to do" question - without standing up the screeps engine. We drive the corp
 * directly: feed it the flow assignments the planner would produce, control its
 * apparent fleet through a stubbed `Game.creeps`, and read back its spawn
 * demands.
 *
 * The throughput physics these lean on: a hauler with `carry` CARRY parts moving
 * energy over a route of `distance` tiles makes a round trip in `2*distance + 2`
 * ticks, carrying `50 * carry` energy per trip - so it sustains a flow of
 * `50 * carry / (2*distance + 2)` per tick. The planner inverts this to size
 * `carryParts` per route; the corp's job is to field enough haulers to cover the
 * sum of those carry parts.
 */

const CAP_RCL3 = 550; // spawn + 5 extensions: maxCarryPerHauler = floor(550/100) = 5
const ctx = { energyCapacity: CAP_RCL3, tick: 100 };

/** A fake hauler that getAssignedCreeps() will count for this corp. */
function fakeHauler(corpId: string): unknown {
  return {
    memory: { corpId, workType: "haul" },
    spawning: false,
    store: { getCapacity: () => 250 },
  };
}

/** Point a stubbed Game at a fleet of `n` haulers belonging to `corpId`. Built
 * on the shared mock Game so its other methods (getObjectById, map, ...) survive
 * for any test that runs after this file. */
function setFleet(corpId: string, n: number): void {
  const creeps: Record<string, unknown> = {};
  for (let i = 0; i < n; i += 1) creeps[`h${i}`] = fakeHauler(corpId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).Game = { ...MockGame, creeps, time: 100 };
}

/** Round trip (ticks) for a 1:1 hauler over `distance`. */
const roundTrip = (distance: number): number => 2 * distance + 2;
/** Sustainable flow (energy/tick) of `carry` CARRY parts over `distance`. */
const sustains = (carry: number, distance: number): number => (50 * carry) / roundTrip(distance);

/** The corp's nodeId IS the id the fake creeps' corpId must match. */
function carryCorp(nodeId = "W1N1-hauling-src1"): CarryCorp {
  return new CarryCorp(nodeId, "spawn1");
}

function route(toId: string, distance: number, flowRate: number): HaulerAssignment {
  // carryParts as the planner sizes it: enough to sustain flowRate over the round trip.
  const carryParts = Math.max(1, Math.ceil((flowRate * roundTrip(distance)) / 50));
  return {
    edgeId: `src1|${toId}`,
    fromId: "source-src1",
    toId,
    distance,
    carryParts,
    flowRate,
    spawnCostPerTick: 0,
    spawnId: "spawn-spawn1",
    haulerRatio: "1:1",
  } as HaulerAssignment;
}

/** Drive the corp from an empty fleet, accepting each hauler it asks for, until
 * it stops demanding. Returns the bodies (CARRY parts) it ended up fielding. */
function growFleet(nodeId: string, corp: CarryCorp, maxHaulers = 10): number[] {
  const carryParts: number[] = [];
  for (let n = 0; n < maxHaulers; n += 1) {
    setFleet(nodeId, n);
    const demands = corp.getSpawnDemand(ctx);
    if (demands.length === 0) break;
    carryParts.push(demands[0].bodyParam as number);
  }
  return carryParts;
}

describe("CarryCorp behaviour (trivial scenarios)", () => {
  afterEach(() => {
    // Leave a valid, full mock Game (empty fleet) in place rather than deleting
    // it: other unit-test files rely on a defined global.Game complete with its
    // methods (getObjectById, ...), and removing or trimming it crashes them.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = { ...MockGame, creeps: {}, time: 100 };
  });

  describe("fleet sizing - a hauling corp of a certain size", () => {
    it("fields a single hauler for a short, low-flow route", () => {
      // Spawn refill: 1.75/tick over 10 tiles. carryParts = ceil(1.75*22/50)=1.
      const nodeId = "W1N1-hauling-near";
      const corp = carryCorp(nodeId);
      corp.setHaulerAssignments([route("spawn1", 10, 1.75)]);

      const fleet = growFleet(nodeId, corp);
      expect(fleet).to.have.length(1);
      // One 1:1 hauler easily sustains 1.75/tick over 10 tiles.
      expect(sustains(fleet[0], 10)).to.be.greaterThan(1.75);
    });

    it("grows the fleet so its total CARRY covers a far, high-flow route", () => {
      // Controller route: 6/tick over 20 tiles. carryParts = ceil(6*42/50)=6.
      // One hauler caps at 5 CARRY (550 cap), so a single hauler cannot do it.
      const nodeId = "W1N1-hauling-far";
      const corp = carryCorp(nodeId);
      const ctrl = route("controller-cccc", 20, 6);
      corp.setHaulerAssignments([ctrl]);

      const fleet = growFleet(nodeId, corp);

      expect(fleet.length).to.be.greaterThan(1, "one 5-CARRY hauler can't carry a 6-CARRY route");
      const totalCarry = fleet.reduce((s, c) => s + c, 0);
      expect(totalCarry).to.be.at.least(ctrl.carryParts, "fleet CARRY must cover the route");
      // The fielded fleet must actually sustain the planned flow.
      const fleetSustains = fleet.reduce((s, c) => s + sustains(c, 20), 0);
      expect(fleetSustains).to.be.at.least(6, "fielded haulers must sustain 6/tick to the controller");
    });

    it("sums the CARRY of every route it serves (spawn + controller)", () => {
      // A per-source corp feeds BOTH the spawn (near) and the controller (far).
      const nodeId = "W1N1-hauling-both";
      const corp = carryCorp(nodeId);
      const spawnRoute = route("spawn1", 10, 1.75);
      const ctrlRoute = route("controller-cccc", 20, 6);
      corp.setHaulerAssignments([spawnRoute, ctrlRoute]);

      const fleet = growFleet(nodeId, corp);
      const needed = spawnRoute.carryParts + ctrlRoute.carryParts;
      const totalCarry = fleet.reduce((s, c) => s + c, 0);
      expect(totalCarry).to.be.at.least(needed, "fleet must cover spawn + controller carry combined");
    });

    it("stops demanding once the fleet is large enough", () => {
      const nodeId = "W1N1-hauling-stop";
      const corp = carryCorp(nodeId);
      corp.setHaulerAssignments([route("controller-cccc", 20, 6)]);

      // carryNeeded = 6, maxCarryPerHauler = 5 -> targetHaulers = 2.
      setFleet(nodeId, 2);
      expect(corp.getSpawnDemand(ctx)).to.deep.equal([], "two haulers cover a 6-CARRY route");
    });

    it("treats the first hauler as blocking and later haulers as scaling", () => {
      const nodeId = "W1N1-hauling-block";
      const corp = carryCorp(nodeId);
      corp.setHaulerAssignments([route("controller-cccc", 20, 6)]);

      setFleet(nodeId, 0);
      expect(corp.getSpawnDemand(ctx)[0].blocking).to.equal(true, "stranded source: first hauler blocks");
      setFleet(nodeId, 1);
      expect(corp.getSpawnDemand(ctx)[0].blocking).to.equal(false, "extra capacity is non-blocking");
    });

    it("returns no demand without any assignment", () => {
      const nodeId = "W1N1-hauling-none";
      const corp = carryCorp(nodeId);
      setFleet(nodeId, 0);
      expect(corp.getSpawnDemand(ctx)).to.deep.equal([]);
    });
  });

  describe("load routing - which sink each load is committed to", () => {
    it("sends loads to the only sink with allocated flow", () => {
      const onlyController = [{ toId: "controller-cccc", flowRate: 6 }];
      expect(pickSinkByAllocation(onlyController, {})).to.equal("controller");
    });

    it("splits loads in proportion to the flow solver's allocations", () => {
      // controller 6 : spawn 2 -> 3:1. Over many loads the split tracks the ratio.
      const assignments = [
        { toId: "controller-cccc", flowRate: 6 },
        { toId: "spawn-aaaa", flowRate: 2 },
      ];
      const delivered: Record<string, number> = { spawn: 0, controller: 0, construction: 0 };
      for (let i = 0; i < 80; i += 1) {
        delivered[pickSinkByAllocation(assignments, delivered)] += 1;
      }
      const ratio = delivered.controller / delivered.spawn;
      expect(ratio).to.be.closeTo(3, 0.4, "controller should get ~3x the spawn's loads");
    });

    it("prioritises construction and controller by their allocated flow", () => {
      const assignments = [
        { toId: "construction-ssss", flowRate: 5 },
        { toId: "controller-cccc", flowRate: 1 },
      ];
      const delivered: Record<string, number> = { spawn: 0, controller: 0, construction: 0 };
      for (let i = 0; i < 60; i += 1) {
        delivered[pickSinkByAllocation(assignments, delivered)] += 1;
      }
      expect(delivered.construction).to.be.greaterThan(delivered.controller);
    });
  });
});
