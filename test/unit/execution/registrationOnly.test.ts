/**
 * THE REGISTRATION-ONLY PROOF (spec 17 acceptance test 1; closes spec 00 test
 * C step 4). A toy corp kind - defined here using only the framework's public
 * API - is registered and then driven through the REAL integration surfaces
 * that historically required hand-edits per kind:
 *
 *   - SpawnDirector.collectDemands: its corp's demand flows through the
 *     generic loop, stamped with its kind and its own demandGroup decoration;
 *   - SpawningCorp/OrphanRescue role registry: readoptKindsFor resolves its
 *     declared workType with zero OrphanRescue edits;
 *   - the census: completeCensus/allCommissionedCorps count it untouched.
 *
 * If this test ever needs an edit ELSEWHERE in src/ to pass, the framework
 * has grown a hardwired seam again - that is the bug (spec 00's words).
 */

import { expect } from "chai";
import { setupGlobals } from "../mock";
import { Corp, SerializedCorp } from "../../../src/corps/Corp";
import { Position } from "../../../src/types/Position";
import { Commission, corpIdFor } from "../../../src/economy/Commission";
import { CorpKind, registerCorpKind, resetCorpKinds } from "../../../src/economy/CorpKind";
import { SpawnDemand, SpawnDemandContext } from "../../../src/spawn/SpawnScheduler";
import { collectDemands } from "../../../src/execution/SpawnDirector";
import { readoptKindsFor } from "../../../src/execution/OrphanRescue";
import {
  allCommissionedCorps,
  resetCommissionHost,
  seedCommissionStoreForTest
} from "../../../src/execution/CommissionHost";
import { createCorpRegistry } from "../../../src/execution/CorpRunner";

const SPAWN_ID = "spawn1";
const ROOM = "W7N7";

class LanternCorp extends Corp {
  public constructor(customId: string) {
    super("moving", "lantern", customId);
  }
  public getSpawnId(): string {
    return SPAWN_ID;
  }
  public getSpawnDemand(_ctx: SpawnDemandContext): SpawnDemand[] {
    return [
      {
        buyerCorpId: this.id,
        role: "lanternkeeper",
        value: 60,
        blocking: false,
        producesIncome: false,
        desiredCost: 150,
        minCost: 100,
        since: 0
      }
    ];
  }
  public work(): void {
    /* glows */
  }
  public getPosition(): Position {
    return { x: 10, y: 10, roomName: ROOM };
  }
}

describe("registration-only integration: a new kind needs ONE file and ONE registration (spec 17)", () => {
  const lanternKind: CorpKind<LanternCorp> = {
    kind: "lantern",
    runOrder: 40,
    roles: { lanternkeeper: { workType: "tend-lantern" } },
    propose(): Commission[] {
      return [];
    },
    materialize(c: Commission, existing: LanternCorp | undefined): LanternCorp {
      return existing ?? new LanternCorp(c.corpId);
    },
    run(corp: LanternCorp, tick: number): void {
      corp.work();
      corp.lastActivityTick = tick;
    },
    serializeCorp(corp: LanternCorp): SerializedCorp {
      return corp.serialize();
    },
    deserializeCorp(data: SerializedCorp): LanternCorp {
      const corp = new LanternCorp(data.id);
      corp.deserialize(data);
      return corp;
    },
    body(): BodyPartConstant[] {
      return [MOVE, CARRY];
    },
    demandGroup(corp: LanternCorp) {
      return { groupId: corp.id, started: true };
    }
  };

  beforeEach(() => {
    setupGlobals();
    resetCommissionHost();
    // The host's lazy bootstrap registers the production KINDS; the toy kind
    // joins them - exactly what a new kind file's registration would do.
    seedCommissionStoreForTest(corpIdFor("lantern", ROOM), "lantern", new LanternCorp("lantern-W7N7"));
    registerCorpKind(lanternKind as CorpKind);
  });
  afterEach(() => {
    resetCommissionHost();
    resetCorpKinds();
  });

  it("DEMAND: flows through the real collectDemands with the kind stamp and its own decoration", () => {
    const demands = collectDemands(createCorpRegistry(), SPAWN_ID, { energyCapacity: 300, tick: 50 });
    const mine = demands.filter(d => d.kind === "lantern");
    expect(mine).to.have.length(1);
    expect(mine[0].role).to.equal("lanternkeeper");
    expect(mine[0].groupId).to.equal("lantern-W7N7");
    expect(mine[0].groupStarted).to.equal(true);
  });

  it("ORPHANS: its declared workType resolves to it with zero OrphanRescue edits", () => {
    expect(readoptKindsFor("tend-lantern").map(k => k.kind)).to.deep.equal(["lantern"]);
  });

  it("CENSUS: counted by the generic census, no telemetry edits", () => {
    const entries = allCommissionedCorps().filter(e => e.kind === "lantern");
    expect(entries).to.have.length(1);
    expect(entries[0].corp.id).to.equal("lantern-W7N7");
  });
});
