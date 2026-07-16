import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import {
  CarryCorp,
  pickSinkByAllocation,
  pickRuntToRecycle,
  pickDeliverySink,
  shouldBankControllerLoad,
  CONTROLLER_STARVE_FLOOR
} from "../../../src/corps/CarryCorp";
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
    getActiveBodyparts: (part: string) => (part === "carry" ? 5 : 0), // a full 5-CARRY hauler
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

    it("never spawns a 1-CARRY runt for a real multi-CARRY route", () => {
      // Under energy pressure the scheduler spawns at minCost; if that were a
      // single CARRY+MOVE the hauler would move only 50 energy/round-trip and
      // squat a fleet slot for its whole life. minCost must floor the body.
      const nodeId = "W1N1-hauling-floor";
      const corp = carryCorp(nodeId);
      corp.setHaulerAssignments([route("controller-cccc", 20, 6)]);
      setFleet(nodeId, 0);
      const d = corp.getSpawnDemand(ctx)[0];
      expect(d.minCost).to.be.at.least(300, "the smallest hauler is still 3 CARRY, not a runt");
      // A 3-CARRY hauler sustains far more than a 1-CARRY one over the same route.
      expect(sustains(3, 20)).to.be.greaterThan(sustains(1, 20) * 2);
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

    it("routes storage-bound flow to the bank (storage), not the spawn circuit", () => {
      const toStorage = [{ toId: "storage-ssss", flowRate: 6 }];
      expect(pickSinkByAllocation(toStorage, {})).to.equal("storage");
    });

    it("keeps storage-bound flow as its own circuit alongside the spawn", () => {
      // Equal spawn/storage flow -> the fleet splits ~evenly between the two,
      // rather than storage being folded into the spawn circuit.
      const assignments = [
        { toId: "spawn-aaaa", flowRate: 4 },
        { toId: "storage-ssss", flowRate: 4 }
      ];
      const delivered: Record<string, number> = { spawn: 0, controller: 0, construction: 0, storage: 0 };
      for (let i = 0; i < 80; i += 1) {
        delivered[pickSinkByAllocation(assignments, delivered)] += 1;
      }
      expect(delivered.storage).to.be.greaterThan(0, "storage gets its share");
      expect(delivered.spawn).to.be.greaterThan(0, "spawn keeps its share");
      expect(delivered.storage / delivered.spawn).to.be.closeTo(1, 0.4);
    });

    it("never routes haulers to construction (tankers feed builders)", () => {
      const assignments = [
        { toId: "construction-ssss", flowRate: 5 },
        { toId: "controller-cccc", flowRate: 1 },
      ];
      const delivered: Record<string, number> = { spawn: 0, controller: 0, construction: 0 };
      for (let i = 0; i < 60; i += 1) {
        delivered[pickSinkByAllocation(assignments, delivered)] += 1;
      }
      // Construction flow is excluded; every load goes to the controller.
      expect(delivered.construction).to.equal(0);
      expect(delivered.controller).to.equal(60);
    });
  });

  describe("delivery priority - the spawn network is fed before the controller", () => {
    // The spawn's own allocation is tiny (staffing overhead), but it is the most
    // important sink: nothing spawns without it. So when it has real free space,
    // it wins regardless of the controller's much larger flow.
    const ctrlHeavy = [
      { toId: "controller-cccc", flowRate: 12 },
      { toId: "spawn-aaaa", flowRate: 3 },
    ];

    it("diverts to the spawn whenever it has real free capacity", () => {
      expect(pickDeliverySink(300, ctrlHeavy, {})).to.equal("spawn");
      expect(pickDeliverySink(50, ctrlHeavy, {})).to.equal("spawn");
    });

    it("falls back to the proportional split once the spawn is (near) full", () => {
      // No meaningful free capacity: the controller's 12:3 share dominates again.
      const delivered: Record<string, number> = { spawn: 0, controller: 0, construction: 0 };
      for (let i = 0; i < 30; i += 1) {
        delivered[pickDeliverySink(0, ctrlHeavy, delivered)] += 1;
      }
      expect(delivered.controller).to.be.greaterThan(delivered.spawn);
    });

    it("keeps the spawn ahead of the controller across a refill cycle", () => {
      // While the spawn has space every load goes to it; only the overflow reaches
      // the controller. Over a burst of loads with the spawn needing energy, the
      // spawn is never starved.
      let spawnLoads = 0;
      for (let i = 0; i < 10; i += 1) {
        if (pickDeliverySink(200, ctrlHeavy, {}) === "spawn") spawnLoads += 1;
      }
      expect(spawnLoads).to.equal(10);
    });
  });

  describe("runt recycling - upgrading the fleet when there is spare capacity", () => {
    // carryNeeded 10, a hauler maxes at 5 CARRY (550 cap). The "maxed + idle"
    // gate is the caller's; this is the choice of WHICH runt to retire.
    it("retires the smallest sub-max hauler when the fleet is below the plan", () => {
      // Fleet [3,3] = 6 CARRY < 10 needed. Recycle one (index of a 3-CARRY).
      expect(pickRuntToRecycle([3, 3], 10, 5)).to.equal(0);
    });

    it("retires the SMALLEST runt first", () => {
      // Fleet [5,2,4] = 11 < 12 needed: the 2-CARRY hauler (index 1) is worst.
      expect(pickRuntToRecycle([5, 2, 4], 12, 5)).to.equal(1);
    });

    it("does not recycle once the fleet meets the planned CARRY", () => {
      // [5,5] = 10 >= 10: the fleet is whole, leave it alone even if we could.
      expect(pickRuntToRecycle([5, 5], 10, 5)).to.equal(null);
    });

    it("does not recycle a fleet that is already all full-size but still short", () => {
      // Every hauler is max (5); the fix is to add another hauler, not recycle.
      expect(pickRuntToRecycle([5, 5], 12, 5)).to.equal(null);
    });

    it("does nothing when there is no carry demand", () => {
      expect(pickRuntToRecycle([3], 0, 5)).to.equal(null);
    });
  });

  // The recurring RCL-drop-off jam: controller-bound haulers must BANK in storage
  // across a transient feeder gap instead of all stampeding the one drop tile.
  describe("controller-bound loads bank in storage across feeder gaps", () => {
    it("banks while the feeder is actively relaying, whatever the input stock", () => {
      expect(
        shouldBankControllerLoad({ hasBankCapacity: true, feederActive: true, controllerInputStock: 0 })
      ).to.equal(true);
    });

    it("STILL banks when the feeder is momentarily gone but the input holds a buffer", () => {
      // The core regression: the old code (gated solely on controllerFeederActive)
      // sent this load to the drop tile the instant the feeder died. With a healthy
      // buffer the upgraders are fine, so the hauler banks and never joins the pile.
      expect(
        shouldBankControllerLoad({
          hasBankCapacity: true,
          feederActive: false,
          controllerInputStock: CONTROLLER_STARVE_FLOOR + 1
        })
      ).to.equal(true);
    });

    it("feeds the controller DIRECTLY only when the input is starving AND no feeder", () => {
      expect(
        shouldBankControllerLoad({ hasBankCapacity: true, feederActive: false, controllerInputStock: 0 })
      ).to.equal(false);
    });

    it("feeds the controller directly when there is no bank capacity, feeder or not", () => {
      expect(
        shouldBankControllerLoad({ hasBankCapacity: false, feederActive: true, controllerInputStock: 5000 })
      ).to.equal(false);
    });
  });
});
