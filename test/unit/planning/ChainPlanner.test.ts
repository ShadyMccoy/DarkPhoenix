import { expect } from "chai";
import { ChainPlanner } from "../../../src/planning/ChainPlanner";
import { OfferCollector } from "../../../src/planning/OfferCollector";
import { createMintValues } from "../../../src/colony/MintValues";
import {
  AnyCorpState,
  createMiningState,
  createSpawningState,
  createUpgradingState,
} from "../../../src/corps/CorpState";
import { Position } from "../../../src/types/Position";

function at(x: number, y: number): Position {
  return { x, y, roomName: "W0N0" };
}

const mint = createMintValues({ rclUpgrade: 1.0 });

function planner(states: AnyCorpState[]): ChainPlanner {
  const p = new ChainPlanner(new OfferCollector(), mint);
  p.registerCorpStates(states, 0);
  return p;
}

/** Spawn + one mined source + one controller goal. */
function basicStates(): AnyCorpState[] {
  return [
    createSpawningState("spawn-1", "node-A", at(25, 25)),
    createMiningState("mine-1", "node-A", "source-1", "spawn-1", at(25, 30), 3000, at(25, 25)),
    createUpgradingState("upgrade-1", "node-A", "spawn-1", at(25, 21), 2, at(25, 25)),
  ];
}

describe("ChainPlanner (corp-driven)", () => {
  it("finds a viable mine -> haul -> upgrade chain from corp states", () => {
    const chains = planner(basicStates()).findViableChains(0);

    expect(chains.length).to.be.greaterThan(0);
    const chain = chains[0];
    expect(chain.segments.map((s) => s.corpType)).to.deep.equal([
      "mining",
      "hauling",
      "upgrading",
    ]);
    expect(chain.profit).to.be.greaterThan(0);
    // The chain mints more than it costs to staff.
    expect(chain.mintValue).to.be.greaterThan(chain.totalCost);
  });

  it("returns no chains when there is no spawn to staff them", () => {
    const noSpawn = basicStates().filter((s) => s.type !== "spawning");
    expect(planner(noSpawn).findViableChains(0)).to.have.length(0);
  });

  it("returns no chains when there is no goal to create value", () => {
    const noGoal = basicStates().filter((s) => s.type !== "upgrading");
    expect(planner(noGoal).findViableChains(0)).to.have.length(0);
  });

  it("finds one chain per goal when several controllers compete for energy", () => {
    const states: AnyCorpState[] = [
      createSpawningState("spawn-1", "node-A", at(25, 25)),
      createMiningState("mine-1", "node-A", "source-1", "spawn-1", at(20, 30), 3000, at(25, 25)),
      createMiningState("mine-2", "node-A", "source-2", "spawn-1", at(30, 30), 3000, at(25, 25)),
      createUpgradingState("upgrade-1", "node-A", "spawn-1", at(20, 21), 2, at(25, 25)),
      createUpgradingState("upgrade-2", "node-B", "spawn-1", at(30, 21), 2, at(25, 25)),
    ];
    const chains = planner(states).findViableChains(0);

    const goalIds = chains.map((c) => c.segments[c.segments.length - 1].corpId);
    expect(goalIds).to.include("upgrade-1");
    expect(goalIds).to.include("upgrade-2");
  });

  it("selects non-overlapping best chains within a budget", () => {
    const chains = planner(basicStates()).findBestChains(0, Number.POSITIVE_INFINITY);
    expect(chains.length).to.be.greaterThan(0);
    // Within an infinite budget every viable chain is selectable.
    expect(chains.length).to.equal(planner(basicStates()).findViableChains(0).length);
  });
});
