/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals } from "../mock";
import {
  ConstructionCorp,
  OPERATION_END_CONFIRM_TICKS,
  RELEASED_BUILDER_CORP_ID,
  RELEASED_TANKER_CORP_ID
} from "../../../src/corps/ConstructionCorp";
import { extensionTenderKind } from "../../../src/corps/kinds/extensionTenderKind";
import { isTenderCreep } from "../../../src/corps/censusLens";
import { PLACEMENT_COOLDOWN } from "../../../src/corps/constructionPlacement";

/**
 * COHORT RELEASE AT OPERATION END (spec 34 D6): when the build pool drains -
 * work COMPLETE, never defund - every squad releases the same tick. Builders
 * ride the existing hand-off (release -> claimsOrphan adoption); the vector's
 * tankers RELEASE -> ordinary orphan grace -> recycle refund. No creep
 * outlives its operation by accident (the measured stray class: full ~800e
 * tankers idling their home loop to TTL death after the ladder finished).
 *
 * Two boundaries the mechanism must respect:
 * - "Pool drained" is confirmed against the PLACEMENT CADENCE: between ladder
 *   rungs the pool is legitimately empty for up to PLACEMENT_COOLDOWN ticks
 *   (site completes -> next placement attempt), and firing there would churn
 *   the whole tanker detail every rung (the 25t churn-loop trap class).
 * - DEFUND is not operation end (trap list, revocation class): allocation -> 0
 *   with sites still standing keeps the cohort fielded - scarcity acts at the
 *   spawn (no NEW bodies), never by stranding the standing fleet.
 */
describe("cohort release at operation end (spec 34 D6)", () => {
  const HOME = "W1N1";
  const CONFIRM = OPERATION_END_CONFIRM_TICKS;

  beforeEach(() => {
    setupGlobals();
    (global as any).FIND_MY_CONSTRUCTION_SITES = 114;
    (global as any).Game = {
      creeps: {},
      rooms: {},
      time: 1000,
      map: { getRoomLinearDistance: () => 0 },
      getObjectById: () => null
    };
    (global as any).Memory.commissionedCorps = {};
  });

  /** A home room whose only pool input is the staged site list. */
  function stageRoom(sites: { progress: number; progressTotal: number }[]): any {
    const room = {
      name: HOME,
      memory: {},
      find: (type: number) => (type === (global as any).FIND_MY_CONSTRUCTION_SITES ? sites : [])
    };
    (global as any).Game.rooms[HOME] = room;
    return room;
  }

  function corpWith(creeps: Record<string, any>): { corp: ConstructionCorp; spawn: any } {
    const corp = new ConstructionCorp(`${HOME}-construction`, "spawn1");
    for (const name in creeps) {
      creeps[name].name = name;
      creeps[name].memory.corpId = corp.id;
      (global as any).Game.creeps[name] = creeps[name];
    }
    const spawn = { pos: { x: 25, y: 25, roomName: HOME } };
    return { corp, spawn };
  }

  // The ONE cohort seam work() calls on the home path: gate + both squads.
  const releasePass = (corp: ConstructionCorp, spawn: any, tick: number): void => {
    (global as any).Game.time = tick;
    (corp as any).releaseCohortAtOperationEnd(spawn, tick);
  };

  it("pool drained past the confirm window -> every squad releases the same tick", () => {
    stageRoom([]);
    const { corp, spawn } = corpWith({
      b1: { memory: { workType: "build" }, spawning: false, ticksToLive: 900 },
      t1: { memory: { workType: "tank" }, spawning: false, ticksToLive: 900 },
      t2: { memory: { workType: "tank", recycling: true }, spawning: false, ticksToLive: 400 }
    });
    (corp as any).lastWantedBuilders = 0; // the demand walk at drain: detail-only want

    releasePass(corp, spawn, 1000); // drain observed: clock starts, nothing fires yet
    const g = (global as any).Game;
    expect(g.creeps.t1.memory.corpId, "no release before the drain is confirmed").to.equal(corp.id);

    releasePass(corp, spawn, 1000 + CONFIRM);
    expect(g.creeps.b1.memory.corpId, "builders release to the adoption marker").to.equal(RELEASED_BUILDER_CORP_ID);
    expect(g.creeps.t1.memory.corpId, "tankers release to the recycle marker").to.equal(RELEASED_TANKER_CORP_ID);
    expect(g.creeps.t2.memory.corpId, "every member goes - mid-recycle runts too").to.equal(RELEASED_TANKER_CORP_ID);
    expect(g.creeps.t2.memory.recycling, "the orphan path owns the released creep - no stale duty flags").to.equal(
      undefined
    );
  });

  it("a between-rungs transient drain (the placement cadence) does NOT release", () => {
    // The pool sits legitimately empty for up to PLACEMENT_COOLDOWN ticks
    // while the next ladder rung waits for its placement attempt.
    expect(CONFIRM, "confirm window must outlast the placement cadence").to.be.greaterThan(PLACEMENT_COOLDOWN);

    stageRoom([]);
    const { corp, spawn } = corpWith({
      t1: { memory: { workType: "tank" }, spawning: false, ticksToLive: 900 }
    });
    releasePass(corp, spawn, 1000);
    releasePass(corp, spawn, 1000 + CONFIRM - 1);
    const g = (global as any).Game;
    expect(g.creeps.t1.memory.corpId, "inside the window: still the corp's tanker").to.equal(corp.id);

    // The next rung lands (placement attempt succeeds): the clock must reset...
    stageRoom([{ progress: 0, progressTotal: 3000 }]);
    releasePass(corp, spawn, 1000 + CONFIRM);
    expect(g.creeps.t1.memory.corpId).to.equal(corp.id);

    // ...so a later drain starts a FRESH window instead of firing instantly.
    stageRoom([]);
    releasePass(corp, spawn, 1000 + CONFIRM + 1);
    releasePass(corp, spawn, 1000 + CONFIRM + CONFIRM);
    expect(g.creeps.t1.memory.corpId, "fresh window after a refill: no instant fire").to.equal(corp.id);
  });

  it("DEFUND (allocation -> 0 with work standing) does NOT release - trap-list revocation class", () => {
    stageRoom([{ progress: 100, progressTotal: 5000 }]); // the site still stands
    const { corp, spawn } = corpWith({
      t1: { memory: { workType: "tank" }, spawning: false, ticksToLive: 900 },
      t2: { memory: { workType: "tank" }, spawning: false, ticksToLive: 400 }
    });
    corp.setConstructionAllocations([]); // the planner defunded the sink

    releasePass(corp, spawn, 1000);
    releasePass(corp, spawn, 1000 + CONFIRM * 5); // far past any confirm window
    const g = (global as any).Game;
    expect(g.creeps.t1.memory.corpId, "standing work keeps the standing fleet").to.equal(corp.id);
    expect(g.creeps.t2.memory.corpId).to.equal(corp.id);
  });

  it("a mid-operation WANT DIP does NOT strand the standing builder (the re-solve reprice)", () => {
    // Measured in the builder-buffer-feed cell before this gate existed: the
    // re-solve repriced the shrinking pool (want 2 -> 1 as a site completed),
    // releaseExcessBuilders fired on the dip, and the "excess" 2W builder
    // froze as an unwanted orphan holding 80 energy while 6k+ of funded work
    // stood and its vector kept delivering. A want dip is the DEFUND shape:
    // no new bodies (the demand gate), standing fleet works to natural death.
    stageRoom([{ progress: 3000, progressTotal: 9000 }]); // work stands
    const { corp, spawn } = corpWith({
      b1: { memory: { workType: "build" }, spawning: false, ticksToLive: 900 },
      b2: { memory: { workType: "build" }, spawning: false, ticksToLive: 400 },
      t1: { memory: { workType: "tank" }, spawning: false, ticksToLive: 900 }
    });
    (corp as any).lastWantedBuilders = 1; // the dip: plan now prices one builder

    releasePass(corp, spawn, 1000);
    releasePass(corp, spawn, 1000 + CONFIRM * 5);
    const g = (global as any).Game;
    expect(g.creeps.b1.memory.corpId, "the fleet keeps eating the pool").to.equal(corp.id);
    expect(g.creeps.b2.memory.corpId, "no stranded orphan holding fuel").to.equal(corp.id);
    expect(g.creeps.t1.memory.corpId).to.equal(corp.id);
  });

  it("released tankers are NOT tender-rescued: the tender kind claims its own orphans only", () => {
    // Retires the cross-kind coverage smell: workType "tank" is shared, so the
    // rescue map routes tank orphans to the tender kind - which must now
    // decline foreign tankers (isTenderCreep lens) so the released vector
    // rides grace -> recycle refund instead of becoming a phantom tender.
    // The fixture's store KEY deliberately differs from the corp's OWN id
    // (commission id vs legacy runtime id - the live shape): the claim must
    // return corp.id, the id creeps resolve against. Returning the key left
    // the orphan claimed-by-nobody - a frozen tender beside a stocked depot
    // (measured live in haul-t4-refill-sla-under-churn, fail @34).
    const corps: any = {
      [`tender-${HOME}`]: { id: `moving-${HOME}-tender`, getPosition: () => ({ x: 10, y: 10, roomName: HOME }) }
    };
    const released: any = {
      pos: { roomName: HOME },
      memory: { workType: "tank", corpId: RELEASED_TANKER_CORP_ID }
    };
    expect(extensionTenderKind.claimsOrphan!(released, corps), "released construction tanker: no claim").to.equal(null);

    const constructionOrphan: any = {
      pos: { roomName: HOME },
      memory: { workType: "tank", corpId: `building-${HOME}-construction` }
    };
    expect(
      extensionTenderKind.claimsOrphan!(constructionOrphan, corps),
      "a dead construction corp's tanker: no claim either"
    ).to.equal(null);

    const staleTenderOrphan: any = {
      pos: { roomName: HOME },
      memory: { workType: "tank", corpId: "stale-tender" } // the cells' adopted-stale staging pattern
    };
    expect(
      extensionTenderKind.claimsOrphan!(staleTenderOrphan, corps),
      "its OWN orphan adopts to the CORP id, never the store key"
    ).to.equal(`moving-${HOME}-tender`);

    const farTenderOrphan: any = {
      pos: { roomName: "W9N9" },
      memory: { workType: "tank", corpId: "moving-W9N9-tender" }
    };
    expect(extensionTenderKind.claimsOrphan!(farTenderOrphan, corps), "different room: no claim").to.equal(null);
  });

  it("sentinel hygiene: the release marker never reads as a tender creep", () => {
    // isTenderCreep keys on corpId.includes("tender"); a marker that matched
    // would put every released tanker right back into the tender census.
    expect(isTenderCreep({ workType: "tank", corpId: RELEASED_TANKER_CORP_ID } as any)).to.equal(false);
  });
});
