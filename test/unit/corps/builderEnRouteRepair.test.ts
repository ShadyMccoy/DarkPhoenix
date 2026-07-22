/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { repairRoadEnRoute } from "../../../src/corps/ConstructionCorp";

/**
 * A builder walking with energy repairs the road under it (owner 2026-07-22:
 * "2 birds with one stone. it moves faster, and roads get repaired") - repair
 * stacks with move in the same tick (verified action-group semantics in the
 * extension-sim engine), so travel ticks become road maintenance for 1
 * energy/WORK/tick. Roads only, most-damaged first; never fires empty (the
 * walk back to refuel stays free) and never on WORK-less bodies (tankers).
 */
describe("repairRoadEnRoute (builder travel ticks double as road maintenance)", () => {
  beforeEach(() => {
    (global as any).RESOURCE_ENERGY = "energy";
    (global as any).WORK = "work";
    (global as any).FIND_STRUCTURES = 107;
    (global as any).STRUCTURE_ROAD = "road";
  });

  const worn = { structureType: "road", hits: 4900, hitsMax: 5000 };
  const battered = { structureType: "road", hits: 500, hitsMax: 5000 };
  const pristine = { structureType: "road", hits: 5000, hitsMax: 5000 };
  const container = { structureType: "container", hits: 100, hitsMax: 250000 };

  function walker(opts: { energy?: number; work?: number; nearby?: any[] }): {
    creep: any;
    repaired: () => any;
    searched: () => boolean;
  } {
    let repaired: any = null;
    let searched = false;
    const creep = {
      store: { energy: opts.energy ?? 100 },
      getActiveBodyparts: (p: string) => (p === "work" ? opts.work ?? 2 : 0),
      pos: {
        findInRange: (_type: number, _range: number, o?: any) => {
          searched = true;
          const all = opts.nearby ?? [];
          return o?.filter ? all.filter(o.filter) : all;
        }
      },
      repair: (t: any) => {
        repaired = t;
        return 0;
      }
    };
    return { creep, repaired: () => repaired, searched: () => searched };
  }

  it("repairs the MOST damaged road in range; non-roads and pristine roads are invisible", () => {
    const w = walker({ nearby: [worn, pristine, battered, container] });
    repairRoadEnRoute(w.creep);
    expect(w.repaired(), "lowest-hits road wins").to.equal(battered);
  });

  it("does nothing empty - the refuel walk costs nothing", () => {
    const w = walker({ energy: 0, nearby: [battered] });
    repairRoadEnRoute(w.creep);
    expect(w.repaired()).to.equal(null);
    expect(w.searched(), "no energy: not even a search (CPU)").to.equal(false);
  });

  it("does nothing without WORK parts (tanker bodies)", () => {
    const w = walker({ work: 0, nearby: [battered] });
    repairRoadEnRoute(w.creep);
    expect(w.repaired()).to.equal(null);
    expect(w.searched(), "no WORK: not even a search (CPU)").to.equal(false);
  });

  it("no damaged road nearby: silent no-op", () => {
    const w = walker({ nearby: [pristine, container] });
    repairRoadEnRoute(w.creep);
    expect(w.repaired()).to.equal(null);
  });
});
