import { expect } from "chai";
import { spawnPriority, SpawnDemand } from "../../../src/spawn/SpawnScheduler";
import { FEEDER, FEEDER_DRAINED, FEEDER_LINCHPIN, TENDER_BOOTSTRAP } from "../../../src/spawn/demandLadder";

function demand(over: Partial<SpawnDemand>): SpawnDemand {
  return {
    buyerCorpId: "c",
    role: "miner",
    value: 90,
    blocking: false,
    producesIncome: false,
    desiredCost: 300,
    minCost: 150,
    since: 0,
    ...over
  };
}

/** A scaling (non-blocking) income producer - the "marginal producer" the
 * linchpin doctrine says the first feeder must outrank. Miners top out just
 * under 150 (`100 + efficiency*0.5`, efficiency < 100). */
function marginalProducer(value = 146): SpawnDemand {
  return demand({ role: "miner", value, producesIncome: true, groupId: "mining-W1N1", groupStarted: true });
}

/** The critical path: a fresh source's FIRST miner. The linchpin must stay
 * BELOW this - the ladder says so explicitly and the cold-start depends on it. */
function blockingProducer(): SpawnDemand {
  return demand({ role: "miner", value: 100, producesIncome: true, groupId: "mining-W1N2", blocking: true });
}

/**
 * THE HEARTBEAT MUST OUTRANK THE MARGINAL PRODUCER.
 *
 * Owner 2026-08-06: *"We have to assume the tender is working. It's a heart
 * beat. It's non negotiable. The body dies slowly if there's issues there."*
 * The doctrine it encodes (CLAUDE.md) makes the tender/feeder drain an AXIOM,
 * and the fix for a failing one belongs IN the heartbeat, never in a
 * compensating rule elsewhere.
 *
 * `FEEDER_LINCHPIN = 150` was introduced to implement exactly that, and its
 * own docstring states the comparison: *"Above the miner band (HarvestCorp:
 * `100 + efficiency*0.5`, efficiency < 100, so miners top out just under 150)
 * so the linchpin outranks the marginal producer."*
 *
 * That comparison was never true. `spawnPriority` adds `INCOME_TIER` (1e6) to
 * every demand with `producesIncome` + a `groupId`, and the feeder declares
 * `producesIncome: false` - so the rung is compared against 1_000_146, not
 * 146, and the first feeder ranks below EVERY income demand, always. The
 * `infrastructure` flag does not rescue it either: it pierces holds but by
 * its own contract "never displaces an actual buy".
 *
 * MEASURED t72809037: `controllerFeeder` creeps 0, `feederActive false`,
 * `wantedFeeders 1`, gate "demand" standing 190 ticks unfunded with 153,760
 * banked, ranked 4th behind two haulers and a coreBuster campaign (BUSTER=104,
 * income-tiered) while the spawn finished 7 other bodies. Only the 300-tick
 * anti-starvation lift would eventually rescue it - i.e. the heartbeat stops
 * for up to 300 ticks after every death. That IS "the body dies slowly".
 */
describe("first-feeder linchpin spawn priority", () => {
  it("outranks the marginal (scaling) producer, as the ladder documents", () => {
    const feeder = demand({ role: "feeder", value: FEEDER_LINCHPIN, linchpin: true });
    expect(spawnPriority(feeder)).to.be.greaterThan(spawnPriority(marginalProducer()));
  });

  it("stays BELOW a blocking first miner - it must never front-run the critical path", () => {
    const feeder = demand({ role: "feeder", value: FEEDER_LINCHPIN, linchpin: true });
    expect(spawnPriority(feeder)).to.be.lessThan(spawnPriority(blockingProducer()));
  });

  it("outranks an income-tiered core-buster campaign (the measured t72809037 inversion)", () => {
    const feeder = demand({ role: "feeder", value: FEEDER_LINCHPIN, linchpin: true });
    // CoreBusterCorp takes income-tier treatment at BUSTER=104 because the
    // mission restores a zeroed income stream. A siege must not stop the heart.
    const buster = demand({ role: "buster", value: 104, producesIncome: true, groupId: "coreBuster-W1N1" });
    expect(spawnPriority(feeder)).to.be.greaterThan(spawnPriority(buster));
  });

  it("does NOT lift additional feeders - only the first one is the linchpin", () => {
    const topUp = demand({ role: "feeder", value: FEEDER });
    expect(spawnPriority(topUp)).to.be.lessThan(spawnPriority(marginalProducer()));
  });

  it("does NOT lift the first feeder while the bank is DRAINED (income rebuilds first)", () => {
    // owner 2026-07-24: "miners are more important than feeders if we have NO
    // energy, which is rare; the rest of the time feeder is more important".
    const drained = demand({ role: "feeder", value: FEEDER_DRAINED });
    expect(spawnPriority(drained)).to.be.lessThan(spawnPriority(marginalProducer()));
  });

  it("lifts the tender's refill bootstrap the same way - same rung, same doctrine", () => {
    // TENDER_BOOTSTRAP carries the identical (and identically inert) claim:
    // "it outbids the whole income range (miners 100-146, haulers 90-110) by
    // VALUE alone". One flag, both heartbeats.
    const tender = demand({ role: "tender", value: TENDER_BOOTSTRAP, linchpin: true });
    expect(spawnPriority(tender)).to.be.greaterThan(spawnPriority(marginalProducer()));
    expect(spawnPriority(tender)).to.be.lessThan(spawnPriority(blockingProducer()));
  });
});
