/* eslint-disable @typescript-eslint/no-explicit-any */
import { assert } from "chai";
import { helper, hookConsole } from "./helper";
import { loadLayout, padNeighborTerrain, setRoomLevel, enableMods, FREE_ECONOMY_MOD } from "./loadLayout";
import { TELEMETRY_SEGMENTS } from "../../src/telemetry/segmentIds";

/** Segment 4 - the ONE place a corp's transient sizing stamp is exported. */
const TELEMETRY_CORPS_SEGMENT = TELEMETRY_SEGMENTS.CORPS;

/**
 * Runt -> upsize probe.
 *
 * Stands up the proven flow-handoff colony (walled two-chamber room - an all-plain
 * room is degenerate for node detection - two sources, RCL 2 with 5 extensions)
 * under the free-economy mod. The first producers necessarily spawn small (a cold
 * spawn affords only a ~2-WORK miner), so the colony starts with runts. It then
 * runs forward and checks that those runts get UPSIZED as the spawn network fills:
 * a flow miner that begins at the cold-start floor grows to a larger body
 * (via the regrow-undersized-miner path and/or the recycle-and-respawn loop).
 *
 * "Upsizing" here is the runts growing, NOT controller progress.
 */
describe("runt economy upsizes its runts", () => {
  // Scoped to THIS suite: root-level hooks would run around every test in
  // every loaded file (mocha hoists them to the root suite) and cross-corrupt
  // the shared server helper between files.
  before(() => hookConsole());
  afterEach(async () => helper.afterEach());

  it("starts with small miners and grows them to a larger body", async function () {
    this.timeout(1200000);

    // Two chambers split by a vertical wall at x=25 (gap at y=23..27).
    const terrain = Array.from({ length: 50 }, (_v, y) =>
      ".".repeat(25) + (y >= 23 && y <= 27 ? "." : "#") + ".".repeat(24)
    );

    await helper.beforeEach(async (world) => {
      await loadLayout(world, {
        room: "W0N0",
        terrain,
        objects: [
          { type: "controller", x: 38, y: 25 },
          { type: "source", x: 10, y: 10 },
          { type: "source", x: 40, y: 40 }
        ]
      });
      await padNeighborTerrain(world, ["W0N0"]);
      await helper.addBot({ room: "W0N0", x: 12, y: 25 });
      await setRoomLevel(world, "W0N0", 2, [
        { x: 13, y: 24 }, { x: 11, y: 24 }, { x: 13, y: 26 }, { x: 11, y: 26 }, { x: 14, y: 25 }
      ]);
      enableMods(helper.serverPath, [FREE_ECONOMY_MOD]);
    });

    /** WORK on each FLOW miner (corpId "mining-...") right now - excludes bootstrap jacks. */
    const flowMinerWork = async (mem: any): Promise<number[]> => {
      const objs = await helper.server.world.roomObjects("W0N0");
      const out: number[] = [];
      for (const o of objs) {
        if (o.type !== "creep") continue;
        const m = mem.creeps?.[o.name];
        if (m?.workType !== "harvest" || !(m.corpId || "").startsWith("mining-")) continue;
        out.push((o.body || []).filter((p: any) => (p.type ?? p) === "work").length);
      }
      return out;
    };

    let smallestMiner = Infinity; // the runt the colony started with
    let largestMiner = 0; // the biggest body it ever upsized to
    let recyclingSeen = false;
    const samples: string[] = [];
    const lastMinerSizing: { [corpId: string]: any } = {};
    let lastAgenda = "(agenda never read)";
    let lastPartsLedger = "(parts ledger never read)";
    let endedAt = 1200;

    // PROBE CADENCE (owner 2026-07-20 "runt econ always takes so long"): the
    // wall-clock was never the sim - it was per-tick instrumentation (a full
    // player-memory pull + JSON.parse + roomObjects, ~2 db round-trips per
    // tick). The probed states persist for hundreds of ticks (a runt lives
    // >>10 ticks; an upsized body stays), so a 10-tick sample cadence loses
    // nothing the assertion reads. GREEN runs also stop as soon as the
    // upsize is proven (min/max are monotone - more ticks cannot un-prove
    // it); a RED run still gets the full 1200-tick ceiling, so failures
    // stay as thorough as ever. Measured: ~12min -> minutes.
    const SAMPLE_EVERY = 10;
    for (let t = 1; t <= 1200; t += 1) {
      await helper.server.tick();
      if (t % SAMPLE_EVERY !== 0 && t !== 1200) continue;
      const mem = JSON.parse((await helper.player.memory) || "{}");

      if (!recyclingSeen) {
        for (const name in mem.creeps || {}) {
          if ((mem.creeps[name] as any).recycling) { recyclingSeen = true; break; }
        }
      }

      // WHY-DIAGNOSTICS (2026-07-29): a red run used to report only WORK
      // counts, so "upsize never proven" cost an 11-minute rerun and manual
      // reasoning to attribute (measured twice in one session: once a
      // host-load flake, once a real pile-gate suppression of the upsize
      // demand). The miner corp's sizing stamp IS the decision - but it is
      // TRANSIENT and never serialized into Memory (Corp.lastSizing), so it
      // must be read from telemetry SEGMENT 4, the one place it is exported
      // verbatim. A first attempt read player memory and printed "the corp
      // never sized", which was a FALSE diagnosis - worse than none.
      try {
        const [raw] = await helper.player.getSegments([TELEMETRY_CORPS_SEGMENT]);
        if (raw) {
          for (const c of JSON.parse(raw).corps ?? []) {
            if (c.kind === "harvest" && c.sizing) lastMinerSizing[c.id] = c.sizing;
          }
        }
      } catch {
        /* segment not active / unparseable - leave the stamps empty */
      }
      // STUCK-MODE FORENSICS (2026-07-30): the cell's known failure signature
      // is bimodal and self-similar - source 1 piled at ~1901 with hauling
      // dead, source 2 unstaffed for the whole run, demand standing (gate
      // "clear", staffing 0). The miner stamps alone cannot say WHY the
      // scheduler never fielded the second miner: that needs the NOW plan
      // (agenda queue + energy) and the GOAL plan's parts ledger. Keep the
      // LAST seen of each so a red verdict prints the whole decision chain,
      // not just its final link.
      try {
        const [rawCore] = await helper.player.getSegments([TELEMETRY_SEGMENTS.CORE]);
        if (rawCore) {
          const core = JSON.parse(rawCore);
          const spawnIds = Object.keys(core.agenda ?? {});
          lastAgenda = spawnIds
            .map(id => {
              const a = core.agenda[id];
              const q = (a.queue ?? [])
                .slice(0, 4)
                .map((e: any) => `${e.role}@${e.minCost}${e.blocking ? "!" : ""}(${e.gate})`)
                .join(" ");
              return `spawn ${id.slice(-4)} need ${a.fundingNeed} depth ${a.queueDepth}: ${q}`;
            })
            .join("\n  ");
          const room = (core.rooms ?? [])[0];
          if (room) lastAgenda += `\n  energyAvailable ${room.energyAvailable}/${room.energyCapacity}`;
        }
        const [rawFlow] = await helper.player.getSegments([TELEMETRY_SEGMENTS.FLOW]);
        if (rawFlow) {
          const flow = JSON.parse(rawFlow);
          if (flow.partsLedger) lastPartsLedger = JSON.stringify(flow.partsLedger);
          const verdicts = (flow.candidates ?? [])
            .map((v: any) => `${String(v.sourceId).slice(-4)}:${v.verdict}`)
            .join(" ");
          if (verdicts) lastPartsLedger += `  verdicts[${verdicts}]`;
        }
      } catch {
        /* segments not active - forensics stay empty */
      }
      const works = await flowMinerWork(mem);
      for (const w of works) {
        if (w > 0 && w < smallestMiner) smallestMiner = w;
        if (w > largestMiner) largestMiner = w;
      }

      if (t % 150 === 0 || t === 1200) {
        samples.push(
          `tick ${t}: flowMiners [${works.join(",")}] smallest ${smallestMiner === Infinity ? "-" : smallestMiner} largest ${largestMiner} recycledYet ${recyclingSeen}`
        );
      }
      if (smallestMiner !== Infinity && largestMiner > smallestMiner) {
        endedAt = t;
        samples.push(`tick ${t}: upsize PROVEN (smallest ${smallestMiner} -> largest ${largestMiner}) - early exit`);
        break;
      }
    }

    console.log("\n=== runt upsize probe ===");
    for (const line of samples) console.log(line);
    console.log(
      `smallest flow miner ${smallestMiner === Infinity ? "-" : smallestMiner} WORK, largest ${largestMiner} WORK, ` +
        `recyclingSeen ${recyclingSeen}, ended at tick ${endedAt}`
    );

    // The decision inputs behind a red verdict (see WHY-DIAGNOSTICS above).
    const diag = Object.keys(lastMinerSizing).length
      ? Object.entries(lastMinerSizing)
          .map(([id, sz]) => `${id.slice(-22)} ${JSON.stringify(sz)}`)
          .join("\n  ")
      : `(no stamps in telemetry segment ${TELEMETRY_CORPS_SEGMENT} - either the bot never wrote it ` +
        `(check the segment is active / the bot is executing at all) or no harvest corp existed. ` +
        `This is NOT evidence about the sizing decision itself.)`;
    console.log(`=== miner sizing stamps (last seen) ===\n  ${diag}`);
    console.log(`=== NOW plan (last agenda) ===\n  ${lastAgenda}`);
    console.log(`=== GOAL plan (last parts ledger + funding verdicts) ===\n  ${lastPartsLedger}`);

    assert.notEqual(
      smallestMiner,
      Infinity,
      `the colony should staff at least one flow miner. Stamps:\n  ${diag}`
    );
    assert.isAbove(
      largestMiner,
      smallestMiner,
      `flow miners should be upsized from their cold-start runt (smallest ${smallestMiner}, ` +
        `largest ${largestMiner}, recycled=${recyclingSeen}, endedAt ${endedAt}).\n` +
        `Miner sizing stamps name the cause - a "buffer-full" gate means the source's mouth was\n` +
        `saturated and the upsize lost priority; "clear" with no upsize means the spawn never\n` +
        `afforded the bigger body (read energyCapacity/agenda), not a demand problem:\n  ${diag}`
    );
  });
});
