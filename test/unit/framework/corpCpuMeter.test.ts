/**
 * Per-corp CPU metering at the dispatch seam (spec 20): the corp is the
 * ACCOUNTING boundary - every corp run is measured, attributed to its kind
 * and corpId, and published for the audit layer to pull. The dispatch is
 * PURE (economy/CorpKind is Game-free, ratchet-enforced), so the clock is
 * INJECTED: the live host passes Game.cpu.getUsed, this suite a fake.
 */

import { expect } from "chai";
import { Corp, SerializedCorp } from "../../../src/corps/Corp";
import { Position } from "../../../src/types/Position";
import { Commission } from "../../../src/economy/Commission";
import {
  CorpKind,
  CorpStore,
  registerCorpKind,
  resetCorpKinds,
  runCommissionedCorps
} from "../../../src/economy/CorpKind";

class TickerCorp extends Corp {
  public constructor(customId: string, private readonly burn: number) {
    super("moving", "ticker", customId);
  }
  /** How much fake CPU this corp's run consumes (advanced by the kind). */
  public cost(): number {
    return this.burn;
  }
  public work(): void {
    /* metered */
  }
  public getPosition(): Position {
    return { x: 0, y: 0, roomName: "W0N0" };
  }
}

/** Fake monotonic clock the kind advances during run() - deterministic. */
let clock = 0;

const tickerKind: CorpKind<TickerCorp> = {
  kind: "ticker",
  runOrder: 10,
  roles: {},
  propose: () => [],
  materialize: (c: Commission, existing: TickerCorp | undefined) => existing ?? new TickerCorp(c.corpId, 1),
  run: (corp: TickerCorp) => {
    clock += corp.cost();
  },
  serializeCorp: (corp: TickerCorp) => corp.serialize(),
  deserializeCorp: (data: SerializedCorp) => new TickerCorp(data.id, 1),
  body: () => []
};

describe("per-corp CPU metering (spec 20): the dispatch attributes every run", () => {
  beforeEach(() => {
    resetCorpKinds();
    clock = 0;
    registerCorpKind(tickerKind as CorpKind);
  });
  after(() => resetCorpKinds());

  function storeWith(...costs: number[]): CorpStore {
    const store: CorpStore = new Map();
    costs.forEach((burn, i) => {
      const corpId = `ticker-${i}`;
      store.set(corpId, {
        kind: "ticker",
        corp: new TickerCorp(corpId, burn),
        commission: { corpId, kind: "ticker" } as Commission
      });
    });
    return store;
  }

  it("records one (kind, corpId, cpu) row per corp with the exact deltas", () => {
    const store = storeWith(2, 5, 3);
    const rows: { kind: string; corpId: string; cpu: number }[] = [];
    runCommissionedCorps(store, 1, {
      now: () => clock,
      record: (kind, corpId, cpu) => rows.push({ kind, corpId, cpu })
    });
    expect(rows).to.deep.equal([
      { kind: "ticker", corpId: "ticker-0", cpu: 2 },
      { kind: "ticker", corpId: "ticker-1", cpu: 5 },
      { kind: "ticker", corpId: "ticker-2", cpu: 3 }
    ]);
  });

  it("the unmetered path is untouched (meter optional - pure/test callers unaffected)", () => {
    const store = storeWith(2, 5);
    runCommissionedCorps(store, 1);
    expect(clock).to.equal(7); // corps ran; nothing recorded, nothing thrown
  });
});
