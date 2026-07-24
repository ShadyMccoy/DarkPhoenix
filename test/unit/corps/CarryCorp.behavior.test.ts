import { expect } from "chai";
import "../../../src/types/Memory"; // load the CreepMemory/Memory type augmentation
import {
  CarryCorp,
  pickSinkByAllocation,
  pickRuntToRecycle,
  pickDeliverySink,
  shouldBankControllerLoad,
  shouldRefillFromDepot,
  tenderOwnsExtensions,
  pickStorageDeposit,
  CONTROLLER_STARVE_FLOOR
} from "../../../src/corps/CarryCorp";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";
import { Game as MockGame, setupGlobals } from "../mock";

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

describe("END-OF-LIFE recycle (owner 2026-07-22: 'less ttl than a round trip - recycle itself')", () => {
  before(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).RESOURCE_ENERGY = "energy";
  });

  it("flags an EMPTY hauler below its shortest round trip; spares loaded and fresh ones", () => {
    const corp = carryCorp("W1N1-hauling-eol");
    corp.setHaulerAssignments([route("storage-x", 20, 5)]); // round trip 2*20+2 = 42
    const mk = (ttl: number, carried: number): any => ({
      memory: {},
      spawning: false,
      ticksToLive: ttl,
      store: { getUsedCapacity: () => carried }
    });
    const dying = mk(30, 0); // cannot finish another trip, empty -> recycle
    const loaded = mk(30, 100); // still carrying - deliver first, never strand cargo
    const fresh = mk(500, 0); // plenty of trips left
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (corp as any).flagEndOfLifeForRecycling([dying, loaded, fresh]);
    expect(dying.memory.recycling, "empty + under one round trip: recycle").to.equal(true);
    expect(loaded.memory.recycling, "loaded: finish the delivery").to.equal(undefined);
    expect(fresh.memory.recycling, "fresh: keep hauling").to.equal(undefined);
  });
});

describe("RETIRING recycle (a hauler whose plan route vanished should not idle out its life)", () => {
  before(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).RESOURCE_ENERGY = "energy";
  });

  // The stranded-hauler linger (live t72525241: hauling-W44N23-hauling-4-30, a
  // 6-part creep with NO matching plan route). materializeCommissions RETAINS a
  // corp whose commission vanished (flagged retiring) so its creeps aren't
  // orphaned - but a hauler with no route has no work to "finish", so "run to
  // natural death" meant idling ~1500 ticks. An empty retiring hauler recycles
  // now (refunds the body); a loaded one delivers first, never stranding cargo.
  const mk = (carried: number): any => ({
    memory: {},
    spawning: false,
    store: { getUsedCapacity: () => carried }
  });

  it("flags an EMPTY creep on a retiring corp; spares a loaded one", () => {
    const corp = carryCorp("W1N1-hauling-retire");
    corp.retiring = true;
    const empty = mk(0);
    const loaded = mk(100);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (corp as any).flagRetiringForRecycling([empty, loaded]);
    expect(empty.memory.recycling, "retiring + empty: recycle now").to.equal(true);
    expect(loaded.memory.recycling, "retiring + loaded: deliver first").to.equal(undefined);
  });

  it("does NOT recycle an empty creep on a corp that is NOT retiring (ordinary between-trips)", () => {
    const corp = carryCorp("W1N1-hauling-active");
    corp.retiring = false;
    const empty = mk(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (corp as any).flagRetiringForRecycling([empty]);
    expect(empty.memory.recycling, "active corp: an empty hauler is just between trips").to.equal(undefined);
  });
});

describe("tenderOwnsExtensions (owner 2026-07-22: 'each corp needs to do their job, not cover for each other')", () => {
  // The ONE lens every hauler fan-fill site reads. COVERED is structural
  // (depot + extensions stamped by ExtensionTenderCorp.work) and does NOT
  // flap with tender deaths - the fallback where haulers resumed fanning
  // whenever the tender died is retired: it wasted hauler trips, masked the
  // outage, and made the corps unscorable. A dead tender is the tender
  // corp's problem (bootstrap value 150 re-fields it); haulers keep the
  // SPAWN STRUCTURE topped either way, so nothing deadlocks.
  it("covered room, tender DEAD: extensions still belong to the tender corp (the retired-fallback pin)", () => {
    expect(tenderOwnsExtensions({ extensionTenderCovered: true, extensionTenderActive: false })).to.equal(true);
  });
  it("covered room, tender alive: unchanged", () => {
    expect(tenderOwnsExtensions({ extensionTenderCovered: true, extensionTenderActive: true })).to.equal(true);
  });
  it("legacy stamp only (active, covered not yet written): still the tender's", () => {
    expect(tenderOwnsExtensions({ extensionTenderActive: true })).to.equal(true);
  });
  it("uncovered (no depot, or pre-extension): haulers own the network, exactly as before", () => {
    expect(tenderOwnsExtensions({})).to.equal(false);
    expect(tenderOwnsExtensions(undefined)).to.equal(false);
    expect(tenderOwnsExtensions({ extensionTenderCovered: false, extensionTenderActive: false })).to.equal(false);
  });
});

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

  // The blind window: a route's fromId is a REAL game id (stable identity), but
  // Game.getObjectById only resolves objects in visible rooms. When the route's
  // room drops out of vision (e.g. an invader wiped its creeps), the old code
  // fell through to the legacy round-robin and STICKILY latched the hauler onto
  // a source in whatever room it happened to stand in - a hauler spawned during
  // the blind window served the wrong source for its whole life. It must hold
  // its route instead, navigating to the remembered pickup position exactly as
  // the intel-id path does.
  describe("blind-window pickup - a route hauler holds its route without vision", () => {
    /** A hauler with fresh memory, standing wherever (room only matters for the bug). */
    function blindHauler(corpId: string): any {
      return { name: "bh1", memory: { corpId, workType: "haul" }, spawning: false };
    }

    it("navigates to the commissioned pickup position instead of latching a local source", () => {
      const corp = carryCorp("W1N1-hauling-blind");
      corp.setHaulerAssignments([route("spawn1", 30, 5)]); // fromId "source-src1", unresolvable (no vision)
      corp.setPickupHint({ x: 14, y: 22, roomName: "W2N1" }); // the commission's consumes.at

      const creep = blindHauler("W1N1-hauling-blind");
      const localSources = [{ id: "home-src", pos: { x: 3, y: 3 } }]; // visible sources in the creep's room
      const resolved = (corp as any).getAssignedSource(creep, localSources);

      expect(resolved).to.equal(null, "no vision: no source object to return");
      expect(creep.memory.assignedSourcePos, "keeps walking the route").to.deep.equal({
        x: 14, y: 22, roomName: "W2N1"
      });
      expect(creep.memory.assignedSourceId, "must NOT latch onto a local source").to.equal(undefined);
    });

    it("remembers the pickup position from live vision, so later blind ticks need no hint", () => {
      const corp = carryCorp("W1N1-hauling-remember");
      corp.setHaulerAssignments([route("spawn1", 30, 5)]);

      // Vision tick: the source resolves; the corp learns where the route picks up.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).Game = {
        ...MockGame, creeps: {}, time: 100,
        getObjectById: (id: string) =>
          id === "src1" ? { id: "src1", pos: { x: 14, y: 22, roomName: "W2N1" } } : null
      };
      const seeing = blindHauler("W1N1-hauling-remember");
      expect((corp as any).getAssignedSource(seeing, []).id).to.equal("src1");

      // Blind tick: vision gone. A FRESH hauler (no memory yet) still routes there.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).Game = { ...MockGame, creeps: {}, time: 101 };
      const fresh = blindHauler("W1N1-hauling-remember");
      expect((corp as any).getAssignedSource(fresh, [])).to.equal(null);
      expect(fresh.memory.assignedSourcePos).to.deep.equal({ x: 14, y: 22, roomName: "W2N1" });
    });

    it("round-trips the remembered pickup position through serialization", () => {
      const corp = carryCorp("W1N1-hauling-persist");
      corp.setHaulerAssignments([route("spawn1", 30, 5)]);
      corp.setPickupHint({ x: 14, y: 22, roomName: "W2N1" });

      const revived = new CarryCorp("W1N1-hauling-persist", "spawn1");
      revived.deserialize(corp.serialize());

      const creep = blindHauler("W1N1-hauling-persist");
      // Assignments are commission-owned (rebound by materialize), not persisted state.
      revived.setHaulerAssignments([route("spawn1", 30, 5)]);
      expect((revived as any).getAssignedSource(creep, [])).to.equal(null);
      expect(creep.memory.assignedSourcePos).to.deep.equal({ x: 14, y: 22, roomName: "W2N1" });
    });

    it("keeps the legacy round-robin for corps WITHOUT route assignments", () => {
      const corp = carryCorp("W1N1-hauling-legacy");
      const creep = blindHauler("W1N1-hauling-legacy");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).Game = { ...MockGame, creeps: { bh1: creep }, time: 100 };

      const local = { id: "home-src", pos: { x: 3, y: 3 } };
      expect((corp as any).getAssignedSource(creep, [local])).to.equal(local);
      expect(creep.memory.assignedSourceId).to.equal("home-src");
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

  // Spec 26: a storage-bound (deposit) load prefers the plan's DEPOSIT PORT (a
  // controller link it turns around at early) while that link has room, else the
  // storage hub, else nowhere - so a full port + full storage spills the load to a
  // hungry spawn/controller (deliverToStorage returns false) rather than camping.
  describe("deposit-port delivery routing (pickStorageDeposit)", () => {
    const port = { x: 41, y: 30, roomName: "W1N1" };

    it("goes to the PORT when the plan chose one and it has room", () => {
      expect(pickStorageDeposit({ depositPos: port, portFree: 200, storageFree: 1000 })).to.equal("port");
    });

    it("WAITS at the port when it is full but the wait window is open (no bounce, owner 2026-07-24)", () => {
      // A full port on a planned route holds at the link (the source link fires to
      // core within its cooldown) instead of bouncing to the hub and back.
      expect(pickStorageDeposit({ depositPos: port, portFree: 0, storageFree: 1000, portWaitedTicks: 0 })).to.equal(
        "wait"
      );
      expect(pickStorageDeposit({ depositPos: port, portFree: 0, storageFree: 1000, portWaitedTicks: 29 })).to.equal(
        "wait"
      );
    });

    it("falls back to STORAGE once the bounded wait is exhausted (chronic port, v1 stall guard)", () => {
      expect(pickStorageDeposit({ depositPos: port, portFree: 0, storageFree: 1000, portWaitedTicks: 30 })).to.equal(
        "storage"
      );
    });

    it("uses STORAGE directly when the plan chose no port", () => {
      expect(pickStorageDeposit({ depositPos: undefined, portFree: 0, storageFree: 1000 })).to.equal("storage");
    });

    it("returns NONE when the port is full AND the storage is full - so the caller spills to spawn/controller", () => {
      expect(pickStorageDeposit({ depositPos: port, portFree: 0, storageFree: 0 })).to.equal("none");
      expect(pickStorageDeposit({ depositPos: undefined, portFree: 0, storageFree: 0 })).to.equal("none");
    });
  });

  // The degraded, tender-less depot refill (pickupEnergy) is a reload-from-the-
  // NEARBY-bank shortcut. Without a locality gate it dragged an empty spawn-homed
  // hauler back to the core depot even when the hauler was out at (or walking
  // toward) its own far/remote source - the observed "empty hauler heading back
  // home". shouldRefillFromDepot restricts the shortcut to when the depot really
  // is the shorter reload.
  describe("degraded depot refill fires only when the depot is the nearer reload", () => {
    it("refills when the depot is at least as close as the source pickup", () => {
      expect(shouldRefillFromDepot({ depotEnergy: 500, networkNeed: 100, rangeToDepot: 2, rangeToPickup: 16 })).to.equal(
        true
      );
      expect(shouldRefillFromDepot({ depotEnergy: 500, networkNeed: 100, rangeToDepot: 5, rangeToPickup: 5 })).to.equal(
        true
      );
    });

    it("treks to the source when the depot is farther (no empty drag home)", () => {
      // The bug: an empty hauler 2 tiles from its source was hauled 16 tiles home.
      expect(shouldRefillFromDepot({ depotEnergy: 500, networkNeed: 100, rangeToDepot: 16, rangeToPickup: 2 })).to.equal(
        false
      );
    });

    it("refills at home when the source is out of the creep's room this tick", () => {
      // A hauler AT HOME whose source is remote: top up from the near depot rather
      // than run a whole remote round-trip (rangeToPickup is Infinity off-room).
      expect(
        shouldRefillFromDepot({ depotEnergy: 500, networkNeed: 100, rangeToDepot: 3, rangeToPickup: Infinity })
      ).to.equal(true);
    });

    it("never diverts to a depot a room away (the U-turn across the border)", () => {
      // Creep out at its remote source: the depot is off-room (Infinity) so the
      // hauler picks up locally instead of heading home.
      expect(
        shouldRefillFromDepot({ depotEnergy: 500, networkNeed: 100, rangeToDepot: Infinity, rangeToPickup: 3 })
      ).to.equal(false);
      expect(
        shouldRefillFromDepot({ depotEnergy: 500, networkNeed: 100, rangeToDepot: Infinity, rangeToPickup: Infinity })
      ).to.equal(false);
    });

    it("does not refill when the depot is empty or the network is already full", () => {
      expect(shouldRefillFromDepot({ depotEnergy: 0, networkNeed: 100, rangeToDepot: 1, rangeToPickup: 50 })).to.equal(
        false
      );
      expect(shouldRefillFromDepot({ depotEnergy: 500, networkNeed: 0, rangeToDepot: 1, rangeToPickup: 50 })).to.equal(
        false
      );
    });
  });

  // End-to-end wiring: pickupEnergy computes the two ranges and routes the empty
  // hauler accordingly. Proves the locality gate is actually connected.
  describe("pickupEnergy routing (the drag, end to end)", () => {
    const mkPos = (x: number, y: number, roomName: string) => ({ x, y, roomName });

    /** Stand an empty spawn-homed hauler up in `creepRoom`, its source in
     * `sourceRoom`, and a stocked storage depot in the home room; run pickupEnergy
     * and report where it tried to go. */
    function runPickup(opts: {
      creepRoom: string;
      sourceRoom: string;
      withdrawResult?: number;
    }): { withdrawTarget: unknown; moveTo: { x: number; y: number; roomName: string } | null } {
      const HOME = "W1N1";
      const depot = { structureType: "storage", my: true, pos: mkPos(24, 24, HOME), store: { energy: 2000 } };
      const source = { id: "src1", pos: mkPos(10, 10, opts.sourceRoom) };
      const rec = { withdrawTarget: null as unknown, moveTo: null as { x: number; y: number; roomName: string } | null };

      const creep: any = {
        name: "h1",
        memory: { corpId: "W1N1-hauling-src1", workType: "haul", homeSink: "spawn" },
        room: { name: opts.creepRoom },
        store: { energy: 0 },
        pos: {
          x: 25,
          y: 25,
          roomName: opts.creepRoom,
          getRangeTo: (t: any) => {
            const p = t?.pos ?? t;
            return Math.max(Math.abs(25 - p.x), Math.abs(25 - p.y));
          },
          isEqualTo: (t: any) => {
            const p = t?.pos ?? t;
            return p.x === 25 && p.y === 25;
          },
          isNearTo: () => false,
          findInRange: () => []
        },
        withdraw: (t: any) => {
          rec.withdrawTarget = t;
          return opts.withdrawResult ?? OK;
        },
        moveTo: (t: any) => {
          rec.moveTo = t?.pos ?? t;
          return OK;
        },
        say: () => {}
      };

      const room: any = {
        name: HOME,
        memory: {},
        storage: depot,
        energyCapacityAvailable: 550,
        energyAvailable: 100, // networkNeed 450 > 0
        find: () => []
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (global as any).Game = {
        ...MockGame,
        time: 100,
        creeps: { h1: creep },
        getObjectById: (id: string) => (id === "src1" ? source : null)
      };

      const corp = carryCorp("W1N1-hauling-src1");
      corp.setHaulerAssignments([route("spawn1", 5, 2)]); // fromId "source-src1"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (corp as any).pickupEnergy(creep, room);
      return rec;
    }

    it("does NOT drag an empty hauler home when it is out near its source", () => {
      // Creep is in a room away from home, its source one room further out. The
      // stocked home depot must NOT pull it back: it keeps heading to its source.
      const rec = runPickup({ creepRoom: "W2N1", sourceRoom: "W3N1" });
      expect(rec.withdrawTarget, "must not touch the home depot").to.equal(null);
      expect(rec.moveTo, "keeps moving toward its source").to.not.equal(null);
      expect(rec.moveTo!.roomName).to.equal("W3N1");
    });

    it("still tops up from the depot when the hauler is AT HOME (source remote)", () => {
      // Same energy conditions, but the hauler is in the home room: the near depot
      // is the shorter reload, so the degraded shortcut still fires.
      const rec = runPickup({ creepRoom: "W1N1", sourceRoom: "W2N1" });
      expect(rec.withdrawTarget, "reloads from the home depot").to.not.equal(null);
      expect((rec.withdrawTarget as any).structureType).to.equal("storage");
    });
  });
});
