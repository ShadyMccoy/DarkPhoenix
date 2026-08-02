import { expect } from "chai";
import "../../../src/types/Memory";
import { SpawningCorp } from "../../../src/corps/SpawningCorp";
import { resetSpawnLedger, spawnSpendView } from "../../../src/telemetry/spawnLedger";
import { getCorpKind, registerCorpKind } from "../../../src/economy/CorpKind";
import { carryKind } from "../../../src/corps/kinds/carryKind";
import { setupGlobals } from "../mock";

/**
 * THE RECEIPT BOOKS THE DEBIT (methodology #8).
 *
 * executeSpawn used to return only the parts count, so the director's blackbox
 * "spawn" receipt recorded `cost: result.energyBudget` - the grant, not the
 * debit. On 2:1 routes the grant ran ~29-33% above the built body (measured
 * 63-65 e/part against a physical 50 on the t72734018 ring), and every
 * per-event reader - X5 churn, X6 sizing, E5 runts, the F1 cost->parts
 * fallback - inherited the bias. The executor knows the exact bodyCost it
 * debited; it must hand it back so the receipt can book it.
 */
describe("SpawningCorp.executeSpawn returns the purchase it debited", () => {
  before(() => {
    setupGlobals();
    // executeSpawn dispatches on the registered kind - register the one this
    // test buys through (idempotent; the host's own registerKinds is lazy and
    // only fires on a host run, which this unit test never does).
    if (!getCorpKind("carry")) registerCorpKind(carryKind);
  });
  beforeEach(() => resetSpawnLedger());

  const stageSpawn = (energyAvailable: number): { spawned: string[][] } => {
    const record: { spawned: string[][] } = { spawned: [] };
    const fakeSpawn = {
      id: "sp1",
      spawning: false,
      room: { energyAvailable, energyCapacityAvailable: energyAvailable, memory: {} },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnCreep: (body: string[], _name: string, _opts: any) => {
        record.spawned.push(body);
        return OK;
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (global as any).Game = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(global as any).Game,
      time: 100,
      getObjectById: (id: string) => (id === "sp1" ? fakeSpawn : null)
    };
    return record;
  };

  it("reports parts AND the body's true cost, not the grant", () => {
    const record = stageSpawn(1000);
    const corp = new SpawningCorp("W1N1-spawning", "sp1");
    const logs: string[] = [];
    const saved = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    // Over-grant on purpose: 600e granted, bodyParam 4 CARRY at 2:1 builds
    // 4C+2M = 300e. The purchase must report the 300 actually debited.
    const purchase = corp.executeSpawn("carry", "hauler", "buyer-1", 600, 100, 4, "2:1");
    console.log = saved;
    expect(purchase, `a successful spawn returns the purchase record [logs: ${logs.join(" | ")}]`).to.not.equal(null);
    expect(purchase && purchase.parts).to.equal(6);
    expect(purchase && purchase.cost).to.equal(300);
    // The cumulative ledger accrues the SAME debit - one truth, two readers.
    expect(spawnSpendView().energyByRole.hauler).to.equal(300);
  });

  it("returns null (not a zero-shaped lie) when the spawn cannot buy", () => {
    stageSpawn(100); // cannot afford any hauler body
    const corp = new SpawningCorp("W1N1-spawning", "sp1");
    const saved = console.log;
    console.log = () => {};
    const purchase = corp.executeSpawn("carry", "hauler", "buyer-1", 600, 100, 4, "2:1");
    console.log = saved;
    expect(purchase).to.equal(null);
    expect(spawnSpendView().energy).to.equal(0);
  });
});
