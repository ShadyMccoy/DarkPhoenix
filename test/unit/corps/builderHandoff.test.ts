/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import "../../../src/types/Memory";
import { setupGlobals } from "../mock";
import { ConstructionCorp, RELEASED_BUILDER_CORP_ID } from "../../../src/corps/ConstructionCorp";
import { constructionKind } from "../../../src/corps/kinds/constructionKind";

/**
 * BUILDER HAND-OFF (owner 2026-07-22: "each corp needs to do their job, not
 * cover for each other ... they could orphan and adopt creeps if necessary"):
 * measured across three captures, the remote container/road corps each bought
 * a fresh 4-part builder for their stint (W42N23 -> W43N24 -> W42N22) while
 * the finished room's builder idled to TTL death - no excess retirement path
 * existed at all ("their builders age out"). Release + adopt replaces that:
 * a corp whose own demand lens wants fewer builders than it fields RELEASES
 * the extras (corpId -> a non-live marker; rescue ignores creeps with NO
 * corpId, so deletion would strand them), and constructionKind.claimsOrphan
 * routes build orphans to the nearest corp whose demand wants one. No taker
 * -> the ordinary 25t grace -> recycle refunds the body.
 */
describe("builder hand-off (release + adopt, never idle-to-death)", () => {
  beforeEach(() => {
    setupGlobals();
    (global as any).Game = { creeps: {}, time: 1000, map: { getRoomLinearDistance: () => 0 } };
  });

  function corpWith(creeps: Record<string, any>): ConstructionCorp {
    const corp = new ConstructionCorp("W1N1-construction", "spawn1");
    for (const name in creeps) {
      creeps[name].name = name;
      creeps[name].memory.corpId = corp.id;
      creeps[name].memory.workType = creeps[name].memory.workType ?? "build";
      (global as any).Game.creeps[name] = creeps[name];
    }
    return corp;
  }

  it("releases every builder beyond the demanded target (the finished remote stint)", () => {
    const corp = corpWith({
      b1: { memory: {}, spawning: false, ticksToLive: 900 },
      b2: { memory: {}, spawning: false, ticksToLive: 400 }
    });
    (corp as any).lastWantedBuilders = 0;
    (corp as any).releaseExcessBuilders();
    const g = (global as any).Game;
    expect(g.creeps.b1.memory.corpId, "released to the marker, never deleted (rescue skips missing corpIds)").to.equal(
      RELEASED_BUILDER_CORP_ID
    );
    expect(g.creeps.b2.memory.corpId).to.equal(RELEASED_BUILDER_CORP_ID);
  });

  it("keeps the repair detail and the freshest bodies when some are still wanted", () => {
    const corp = corpWith({
      detail: { memory: { repairDetail: true }, spawning: false, ticksToLive: 300 },
      fresh: { memory: {}, spawning: false, ticksToLive: 1400 },
      old: { memory: {}, spawning: false, ticksToLive: 200 }
    });
    (corp as any).lastWantedBuilders = 2;
    (corp as any).releaseExcessBuilders();
    const g = (global as any).Game;
    expect(g.creeps.detail.memory.corpId, "the standing detail is never released while wanted").to.equal(corp.id);
    expect(g.creeps.fresh.memory.corpId, "freshest body kept (most life = most value)").to.equal(corp.id);
    expect(g.creeps.old.memory.corpId).to.equal(RELEASED_BUILDER_CORP_ID);
    expect(g.creeps.old.memory.repairDetail, "a released creep carries no duty flags").to.equal(undefined);
  });

  it("NEVER releases on an unknown want (fresh corp / pre-hand-off memory at the deploy boundary)", () => {
    // Treating "never stashed" as 0 would have released every builder
    // colony-wide on the first post-deploy tick (caught by the pool-march
    // pin before it shipped). Unknown means no-op until the demand walk
    // stamps a real decision.
    const corp = corpWith({
      b1: { memory: {}, spawning: false, ticksToLive: 900 },
      b2: { memory: {}, spawning: false, ticksToLive: 400 }
    });
    (corp as any).releaseExcessBuilders(); // lastWantedBuilders never stashed
    const g = (global as any).Game;
    expect(g.creeps.b1.memory.corpId).to.equal(corp.id);
    expect(g.creeps.b2.memory.corpId).to.equal(corp.id);
    expect(corp.wantsAnotherBuilder(), "unknown want adopts nobody either").to.equal(false);
  });

  it("releases nothing while staffing matches the target (the common case is free)", () => {
    const corp = corpWith({ b1: { memory: {}, spawning: false, ticksToLive: 900 } });
    (corp as any).lastWantedBuilders = 1;
    (corp as any).releaseExcessBuilders();
    expect((global as any).Game.creeps.b1.memory.corpId).to.equal(corp.id);
  });

  it("wantsAnotherBuilder: demand lens says yes only while fielded builders trail the stashed target", () => {
    const corp = corpWith({ b1: { memory: {}, spawning: false, ticksToLive: 900 } });
    (corp as any).lastWantedBuilders = 2;
    expect(corp.wantsAnotherBuilder()).to.equal(true);
    (corp as any).lastWantedBuilders = 1;
    expect(corp.wantsAnotherBuilder()).to.equal(false);
  });

  it("claimsOrphan routes a build orphan to the NEAREST corp that wants one", () => {
    (global as any).Game.map = {
      getRoomLinearDistance: (a: string, b: string) => Math.abs(a.charCodeAt(1) - b.charCodeAt(1))
    };
    const orphan: any = { pos: { roomName: "W3N1" }, memory: { workType: "build" } };
    const corps: any = {
      far: { id: "far", wantsAnotherBuilder: () => true, workRoomName: () => "W9N1" },
      near: { id: "near", wantsAnotherBuilder: () => true, workRoomName: () => "W4N1" },
      sated: { id: "sated", wantsAnotherBuilder: () => false, workRoomName: () => "W3N1" }
    };
    expect(constructionKind.claimsOrphan!(orphan, corps)).to.equal("near");
  });

  it("claimsOrphan: no corp wants a builder -> null (grace then recycle refunds the body)", () => {
    const orphan: any = { pos: { roomName: "W3N1" }, memory: { workType: "build" } };
    expect(
      constructionKind.claimsOrphan!(orphan, { a: { id: "a", wantsAnotherBuilder: () => false, workRoomName: () => "W3N1" } } as any)
    ).to.equal(null);
  });

  it("claimsOrphan never claims a tanker (the tender kind rescues those)", () => {
    const orphan: any = { pos: { roomName: "W3N1" }, memory: { workType: "tank" } };
    expect(
      constructionKind.claimsOrphan!(orphan, { a: { id: "a", wantsAnotherBuilder: () => true, workRoomName: () => "W3N1" } } as any)
    ).to.equal(null);
  });
});
