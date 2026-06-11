import { expect } from "chai";
import "../../../src/types/Memory";
import { HarvestCorp } from "../../../src/corps/HarvestCorp";
import { CarryCorp } from "../../../src/corps/CarryCorp";
import { ChainScene, effectiveNet, SPAWN_PART_ENERGY_VALUE } from "../../../src/corps/economics";
import { chebyshevDistance } from "../../../src/types/Position";
import { HaulerAssignment } from "../../../src/flow/FlowTypes";

const SPAWN = { x: 0, y: 0, roomName: "W1N1" };
function scene(): ChainScene {
  return {
    spawnPos: SPAWN,
    energyCapacity: 800,
    controllerPos: SPAWN,
    dist: chebyshevDistance,
    resource: (id: string) => {
      const m = /^src@(\d+)$/.exec(id);
      if (m) return { pos: { x: Number(m[1]), y: 0, roomName: "W1N1" }, capacity: 3000 };
      return undefined;
    }
  };
}

function haulRoute(fromId: string, distance: number, flowRate = 10): HaulerAssignment {
  return { edgeId: `${fromId}|c`, fromId, toId: "c", distance, carryParts: 0, flowRate, spawnCostPerTick: 0, spawnId: "v" };
}

describe("spawn-part economics", () => {
  it("a miner reports a spawn-part cost = body parts / useful life", () => {
    const corp = new HarvestCorp("v", "v", "src@5");
    const e = corp.project(scene());
    expect(e.spawnPartsPerTick).to.be.greaterThan(0);
    // A 5W3M miner (8 parts) at d=5 lives ~1500-15 ticks: 8/~1485 ~ 0.0054.
    expect(e.spawnPartsPerTick).to.be.closeTo(0.0054, 0.002);
  });

  it("a farther hauling route draws MORE spawn parts (the part-hungry term)", () => {
    const near = new CarryCorp("v", "v");
    near.setHaulerAssignments([haulRoute("src@5", 5)]);
    const far = new CarryCorp("v", "v");
    far.setHaulerAssignments([haulRoute("src@200", 200)]);
    const nearParts = near.project(scene()).spawnPartsPerTick;
    const farParts = far.project(scene()).spawnPartsPerTick;
    expect(farParts).to.be.greaterThan(nearParts);
  });

  it("the spawn-part penalty demotes a far source below a near one in pure energy", () => {
    // Same gross flow (10/tick) mined + hauled; only the distance differs. The far
    // route's part-hungry hauler fleet makes its effective (penalty-adjusted) net
    // lower, so it ranks below the near source - the spawn-time wall falling out of
    // a single energy comparison, not a hard distance limit.
    const build = (d: number) => {
      const miner = new HarvestCorp("v", "v", `src@${d}`).project(scene());
      const hauler = new CarryCorp("v", "v");
      hauler.setHaulerAssignments([haulRoute(`src@${d}`, d)]);
      const haul = hauler.project(scene());
      return effectiveNet({
        costPerTick: miner.costPerTick + haul.costPerTick,
        throughput: miner.throughput,
        spawnPartsPerTick: miner.spawnPartsPerTick + haul.spawnPartsPerTick
      });
    };
    expect(build(200)).to.be.lessThan(build(5));
  });

  it("prices spawn build-time at SPAWN_PART_ENERGY_VALUE per part/tick", () => {
    const econ = { costPerTick: 0, throughput: 0, spawnPartsPerTick: 0.1 };
    expect(effectiveNet(econ)).to.be.closeTo(-0.1 * SPAWN_PART_ENERGY_VALUE, 1e-9);
  });
});
