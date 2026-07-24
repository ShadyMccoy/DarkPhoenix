import { expect } from "chai";
import { AgendaWhy, SpawnDemand, agendaWhy, buildAgendaQueue } from "../../../src/spawn/SpawnScheduler";

/**
 * The NOW plan's transition contract (spec 11 phase 3): every agenda entry is
 * labeled with the transition it implements and the precondition it waits on,
 * derived from the same flags/ranking the scheduler acts on.
 */
function demand(overrides: Partial<SpawnDemand>): SpawnDemand {
  return {
    buyerCorpId: "corp-x",
    role: "miner",
    value: 100,
    blocking: false,
    producesIncome: true,
    desiredCost: 500,
    minCost: 250,
    since: 0,
    ...overrides
  };
}

describe("agendaWhy (transition labels)", () => {
  const cases: Array<[string, Partial<SpawnDemand>, AgendaWhy]> = [
    ["replacement flag wins", { replacement: true }, "replacement"],
    ["corp-provided why wins over flags", { why: "upsize", replacement: true }, "upsize"],
    ["holdToFund is a campaign", { holdToFund: true, role: "claimer", producesIncome: false }, "campaign"],
    ["fresh income unit", { producesIncome: true, groupStarted: false }, "new-unit"],
    ["started income unit scales", { producesIncome: true, groupStarted: true }, "scale"],
    ["income without a group is scaling too", { producesIncome: true }, "scale"],
    ["tanker is infrastructure", { role: "tanker", producesIncome: false }, "infra"],
    ["feeder is infrastructure", { role: "feeder", producesIncome: false }, "infra"],
    ["scout is infrastructure", { role: "scout", producesIncome: false }, "infra"],
    ["upgrader is a consumer", { role: "upgrader", producesIncome: false }, "consume"],
    ["builder is a consumer", { role: "builder", producesIncome: false }, "consume"]
  ];
  for (const [name, overrides, expected] of cases) {
    it(name, () => expect(agendaWhy(demand(overrides))).to.equal(expected));
  }
});

describe("buildAgendaQueue (the published NOW plan)", () => {
  it("ranks with the scheduler's own priority (income first) and chains after: preconditions", () => {
    const upgrader = demand({
      buyerCorpId: "upgrading-1",
      role: "upgrader",
      producesIncome: false,
      value: 70,
      minCost: 200
    });
    const miner = demand({ buyerCorpId: "mining-1", role: "miner", groupId: "src1", minCost: 250 });
    const { queue } = buildAgendaQueue([upgrader, miner], 100, 300);

    expect(queue.map(q => q.corp)).to.deep.equal(["mining-1", "upgrading-1"]);
    expect(queue[0].precondition, "affordable head has no precondition").to.equal(undefined);
    expect(queue[1].precondition).to.equal("after:mining-1");
  });

  it("stamps bank>= on an unaffordable head", () => {
    const miner = demand({ buyerCorpId: "mining-1", minCost: 700 });
    const { queue } = buildAgendaQueue([miner], 100, 300);
    expect(queue[0].precondition).to.equal("bank>=700");
  });

  it("fundingNeed sums must-fund minima only", () => {
    const replacement = demand({ buyerCorpId: "mining-1", replacement: true, minCost: 250 });
    const scaling = demand({ buyerCorpId: "carry-1", role: "hauler", groupStarted: true, minCost: 150 });
    const campaign = demand({
      buyerCorpId: "claim-1",
      role: "claimer",
      producesIncome: false,
      holdToFund: true,
      minCost: 650,
      value: 80
    });
    const { fundingNeed } = buildAgendaQueue([replacement, scaling, campaign], 100, 0);
    expect(fundingNeed).to.equal(250 + 650);
  });

  it("labels every entry", () => {
    const demands = [
      demand({ buyerCorpId: "a", replacement: true }),
      demand({ buyerCorpId: "b", role: "hauler", groupStarted: true }),
      demand({ buyerCorpId: "c", role: "upgrader", producesIncome: false, value: 50 })
    ];
    const { queue } = buildAgendaQueue(demands, 100, 1000);
    expect(queue.every(q => typeof q.why === "string" && q.why.length > 0)).to.equal(true);
  });

  it("caps the queue at 8", () => {
    const demands = Array.from({ length: 12 }, (_, i) => demand({ buyerCorpId: `corp-${i}` }));
    const { queue } = buildAgendaQueue(demands, 100, 1000);
    expect(queue).to.have.length(8);
  });
});

/**
 * Starvation observability (spec 15 S3 line, live incident t72402541-72403593:
 * tender stuck in gate "demand" for 1000+ ticks with a healthy starvation
 * backstop in the ranking). The agenda must carry each entry's `since` so a
 * capture distinguishes a resetting clock (demand flicker) from a ranking/buy
 * failure - the two remaining hypotheses, undecidable without it.
 */
describe("agenda carries demand age (since) for starvation diagnosis", () => {
  it("each queue entry carries its demand's since verbatim", () => {
    const { queue } = buildAgendaQueue(
      [demand({ buyerCorpId: "a", since: 12345 }), demand({ buyerCorpId: "b", since: 0 })],
      13000,
      300
    );
    expect(queue[0].since).to.equal(12345);
    expect(queue[1].since).to.equal(0);
  });

  it("a starved demand outranks fresh income (the backstop, pinned via the queue)", () => {
    const { queue } = buildAgendaQueue(
      [
        demand({ buyerCorpId: "fresh-miner", value: 10000, blocking: true, since: 12990 }),
        demand({ buyerCorpId: "starved-tanker", role: "tanker", producesIncome: false, value: 96, since: 12000 })
      ],
      13000, // starved-tanker age 1000 >= 300 threshold
      300
    );
    expect(queue[0].corp).to.equal("starved-tanker");
  });

  it("a starved demand a full threshold-bucket older wins outright; value orders within a bucket (live incident t72403765: tender age 1371 = bucket 4 outranks starved scale-haulers <=1134 = bucket 3)", () => {
    const { queue } = buildAgendaQueue(
      [
        demand({ buyerCorpId: "starved-hauler", role: "hauler", producesIncome: true, value: 110, since: 11866 }), // age 1134
        demand({ buyerCorpId: "starved-tanker", role: "tanker", producesIncome: false, value: 96, since: 11629 }), // age 1371
        demand({ buyerCorpId: "starved-upgrader", role: "upgrader", producesIncome: false, value: 90, since: 11977 }) // age 1023
      ],
      13000,
      300
    );
    expect(queue.map(q => q.corp)).to.deep.equal(["starved-tanker", "starved-hauler", "starved-upgrader"]);
  });
});

/**
 * Instrument (spec 14, owner 2026-07-24): detectWallPreemption records when a
 * campaign consumer's wall is bypassed by a lower income buy - the measured
 * E4/P7 freeze - tagging whether the fleet was SECURED (only replacements
 * outstanding, no growth) so the conditioned windfall gate is designed against
 * real data before touching spawn priority.
 */
describe("detectWallPreemption (campaign-wall-vs-income instrument)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { detectWallPreemption } = require("../../../src/spawn/SpawnScheduler");
  const entry = (why: string, gate: string, role = why): any => ({
    role,
    corp: "c-" + role,
    minCost: 100,
    desiredCost: 100,
    mustFund: false,
    why,
    since: 0,
    gate
  });

  it("flags a preemption and marks fleetSecured when only a REPLACEMENT buys through the wall", () => {
    const p = detectWallPreemption([entry("campaign", "wall", "upgrader"), entry("replacement", "buy", "hauler")]);
    expect(p).to.not.equal(null);
    expect(p.campaignRole).to.equal("upgrader");
    expect(p.preemptorWhy).to.equal("replacement");
    expect(p.fleetSecured, "no growth demand outstanding -> the gate would safely fire").to.equal(true);
  });

  it("flags the preemption but fleetSecured=false when an income GROWTH (scale) buys through", () => {
    const p = detectWallPreemption([entry("campaign", "wall", "upgrader"), entry("scale", "buy", "hauler")]);
    expect(p).to.not.equal(null);
    expect(p.fleetSecured, "a scale demand means the fleet is still growing -> income should win").to.equal(false);
  });

  it("returns null when there is no campaign wall", () => {
    expect(detectWallPreemption([entry("scale", "buy", "hauler"), entry("consume", "queued", "upgrader")])).to.equal(
      null
    );
  });

  it("returns null when the campaign wall is not preempted (nothing bought through it)", () => {
    expect(detectWallPreemption([entry("campaign", "wall", "upgrader"), entry("scale", "queued", "hauler")])).to.equal(
      null
    );
  });
});
