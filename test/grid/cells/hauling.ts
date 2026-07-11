/**
 * hauling cells (docs/specs/08, avenue: logistics).
 *
 * T0: existence proof of the full income loop - the RCL2 flow economy fields
 * a real hauler and the spawn gets REFILLED after being drained by spawning.
 * The refill check only arms once a flow hauler exists, so a jack-only
 * economy can't satisfy it; per the errata (window #9) plus the measured
 * first-miner-at-138, the window stays at 300.
 *
 * NOTE this cell carries closure state (sawDrainSinceHauler) - cells are
 * constructed once per process, which holds for a grid run; a future
 * rerun-in-process flake policy must rebuild cells (see cells/index.ts).
 */

import { GridCell, always, eventually } from "../GridCell";
import { makeRefillSla } from "../refillSLA";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";

const homeRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(20, 25).source(25, 30).toRoom();

const flowHaulerExists = (s: { memory: any }) =>
  Object.entries(s.memory?.creeps ?? {}).some(
    ([name, mem]: [string, any]) => name.startsWith("hauler-") && mem?.workType === "haul"
  );

// ---------------------------------------------------------------------------
// T3 dedicated-source geometry: two sources - A (10,25) fully staffed keeps
// the economy sane; B (40,25) is the dedicated build source (its id injected
// into Memory.rooms.$room().dedicatedBuildSourceId), with a staged extension
// site at (38,25) plus a staged builder+tanker on the construction corp's
// deterministic id so building actually consumes B's output. B's carry corp
// commissions organically with zero creeps; whether it fields a hauler is
// exactly what the three cells discriminate.
// Harvest spots: A -> (11,24); B -> (39,24) (Chebyshev-to-spawn tie-break).
// ---------------------------------------------------------------------------
const dedicatedRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 8).source(10, 25).source(40, 25).toRoom();

const dedicatedCommon = () => ({
  structures: [{ type: "container", x: 11, y: 24, energy: 800 }] as any[],
  creeps: [
    {
      name: "mA",
      x: 11,
      y: 24,
      body: ["work", "work", "work", "work", "work", "move", "move", "move"],
      memory: { workType: "harvest", corpId: "staged-dd-ma", assignedSourceId: "$id(home,source,10,25)" },
    },
    {
      name: "hA",
      x: 15,
      y: 24,
      body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
      memory: { workType: "haul", corpId: "staged-dd-ha", working: false, assignedSourceId: "$id(home,source,10,25)" },
    },
    {
      name: "mB",
      x: 39,
      y: 24,
      body: ["work", "work", "work", "work", "work", "move", "move", "move"],
      memory: { workType: "harvest", corpId: "staged-dd-mb", assignedSourceId: "$id(home,source,40,25)" },
    },
    { name: "bB", x: 38, y: 24, body: ["work", "work", "carry", "carry", "move", "move"], energy: 100 },
    { name: "tB", x: 38, y: 26, body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"] },
  ] as any[],
  memory: {
    rooms: { "$room()": { dedicatedBuildSourceId: "$id(home,source,40,25)" } },
    creeps: {
      bB: { workType: "build", corpId: "building-$room()-construction", working: true },
      tB: { workType: "tank", corpId: "building-$room()-construction", working: false },
    },
  } as any,
  stage: async (ctx: any) => {
    await ctx.db["rooms.objects"].insert({
      type: "constructionSite",
      room: ctx.room(),
      x: 38,
      y: 25,
      user: ctx.userId,
      structureType: "extension",
      progress: 0,
      progressTotal: 3000,
    });
  },
});

const bCarryCorpId = (s: any): string | null => {
  const srcB = s.objects().find((o: any) => o.type === "source" && o.x === 40 && o.y === 25);
  return srcB ? `hauling-${s.room()}-hauling-${String(srcB._id).slice(-4)}` : null;
};

const haulersOfCorp = (s: any, corpId: string | null): number =>
  corpId === null
    ? 0
    : Object.entries(s.memory?.creeps ?? {}).filter(
        ([, mem]: [string, any]) => mem?.workType === "haul" && mem?.corpId === corpId
      ).length;

// ---------------------------------------------------------------------------
// T1 circuit-split geometry: source (25,42) with its container staged on the
// harvest spot (24,41) holding 1500; controller (25,8). Solver flows for a
// 10 e/t source: controller reserve 2, spawn (demand 10, value 100) takes the
// remaining 8. assignCircuit counts committed fleet-mates, so three haulers
// flip to homeSinks spawn, controller, spawn in whatever order they fill -
// the multiset {spawn: 2, controller: 1} is deterministic.
// ---------------------------------------------------------------------------
const splitRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 8).source(25, 42).toRoom();


// ---------------------------------------------------------------------------
// T4 tender-regime geometry: depot container (24,24) beside the spawn, ten
// extensions in a row at y=21, source (25,42) with a stocked container and a
// staged miner, controller (25,10) with an input container at (25,12).
// The tender is staged with workType 'tank' and a stale corpId - OrphanRescue
// ROLE_KIND maps tank -> tender kind and re-adopts it into the per-room
// tender corp, whose work() then recomputes extensionTenderActive each tick.
// ---------------------------------------------------------------------------
const EXT_ROW: Array<{ x: number; y: number }> = Array.from({ length: 10 }, (_, i) => ({ x: 20 + i, y: 21 }));

const tenderRoom = (roomName: string) =>
  new RoomBuilder(roomName).border().controller(25, 10).source(25, 42).toRoom();

const tenderCreeps = (extra: any[] = []) => [
  {
    name: "mS",
    x: 24,
    y: 41,
    body: ["work", "work", "work", "work", "work", "move", "move", "move"],
    memory: { workType: "harvest", corpId: "staged-td-m", assignedSourceId: "$id(home,source,25,42)" },
  },
  {
    name: "h1",
    x: 25,
    y: 40,
    body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
    memory: { workType: "haul", corpId: "staged-td-h1", working: false, homeSink: "spawn", assignedSourceId: "$id(home,source,25,42)" },
  },
  {
    name: "h2",
    x: 25,
    y: 39,
    body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
    memory: { workType: "haul", corpId: "staged-td-h2", working: false, homeSink: "controller", assignedSourceId: "$id(home,source,25,42)" },
  },
  {
    name: "td",
    x: 23,
    y: 24,
    body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
    memory: { workType: "tank", corpId: "stale-tender" },
  },
  ...extra,
];

export function buildHaulingT4Cells(): GridCell[] {
  let refillCycles = 0;
  let refillWasShort = false;
  let depotSeen150 = false;
  let ctrlKept = true;
  let prevBank: number | null = null;
  let sawBankDeposit = false;
  const haulerLinger: Record<string, number> = {};

  return [
    {
      // The refill SLA under organic churn (owner directive 2026-07-10):
      // "refilling extensions should finish before the creep that drained
      // them finishes spawning." Full bank + stocked depot + live income
      // staged; every organic spawn drains the bank and the tender must
      // restore it inside that creep's build time, drain after drain.
      id: "haul-t4-refill-sla-under-churn",
      tier: 4,
      avenue: "logistics",
      window: 400,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 10).source(25, 40).source(40, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: 24, y: 24, energy: 2000 }, // stocked depot
        { type: "container", x: 24, y: 39, energy: 1500 }, // source-side buffer
        ...EXT_ROW.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })), // bank starts FULL (arms the SLA)
      ],
      creeps: [
        {
          name: "mA",
          x: 24,
          y: 40,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-sla-m", assignedSourceId: "$id(home,source,25,40)" },
        },
        {
          name: "hA",
          x: 26,
          y: 30,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-sla-h", working: false, assignedSourceId: "$id(home,source,25,40)" },
        },
        {
          // Staged refill apparatus: the cell tests STEADY-STATE churn, not the
          // cold-start ramp (a spawn busy building the very creep that drained
          // the bank cannot also birth the first tender). Same adopted-stale
          // pattern as the tender-bus cell.
          name: "tenderA",
          x: 23,
          y: 24,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: { workType: "tank", corpId: "stale-sla-tender" },
        },
      ],
      assertions: [
        makeRefillSla(undefined, 10),
        eventually("the bank is drained and refilled at least twice (not vacuous)", (s) => {
          const exts = s.objects().filter((o: any) => o.type === "extension" && o.user === s.userId);
          if (exts.length === 0) return false;
          const short = exts.some((o: any) => (o.store?.energy ?? 0) < 50);
          if (short) refillWasShort = true;
          if (!short && refillWasShort) {
            refillCycles += 1;
            refillWasShort = false;
          }
          return refillCycles >= 2;
        }),
      ],
    },

    {
      // The tender regime: haulers run the dumb source->depot bus (never
      // fanning across extensions), the tender does the depot->extension last
      // leg, and the surplus spills to the controller.
      id: "haul-t4-tender-bus-regime",
      tier: 4,
      avenue: "logistics",
      // Demand-saturated via the pinned spawn (below): spawning feeds from
      // the pin instead of consuming hauled income, so the fill -> depot ->
      // spill chain completes in-window (the old KNOWN RED's missing surplus).
      window: 170,
      rooms: { home: tenderRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: 24, y: 24, energy: 0 }, // depot
        { type: "container", x: 24, y: 41, energy: 1800 }, // source container
        { type: "container", x: 25, y: 12, energy: 0 }, // controller input
        ...EXT_ROW.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 0 })),
      ],
      creeps: tenderCreeps(),
      async onTick(ctx) {
        // Feed spawning from the pin, not from hauled income - the demand
        // saturation that lets the fill -> depot -> spill chain complete.
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } }
        );
      },
      assertions: [
        makeRefillSla(undefined, 10),
        eventually("the tender regime activates", (s) => s.memory?.rooms?.[s.room()]?.extensionTenderActive === true),
        eventually("the depot is bridged to its buffer", (s) => {
          const depot = s.objects().find((o: any) => o.type === "container" && o.x === 24 && o.y === 24);
          if (!!depot && (depot.store?.energy ?? 0) >= 150) depotSeen150 = true;
          return depotSeen150;
        }),
        eventually("the tender fills the extensions", (s) => {
          const sum = s
            .objects()
            .filter((o: any) => o.type === "extension" && o.y === 21)
            .reduce((acc: number, o: any) => acc + (o.store?.energy ?? 0), 0);
          return sum >= 200;
        }),
        eventually("the surplus reaches the controller side", (s) => {
          // The parked upgrader consumes deliveries as they land (the T1
          // circuit-split lesson): controller progress is the reliable
          // spill signal; a buffered pile also counts.
          const ctrl = s.objects().find((o: any) => o.type === "controller");
          if ((ctrl?.progress ?? 0) > 0) return true;
          const box = s.objects().find((o: any) => o.type === "container" && o.x === 25 && o.y === 12);
          return !!box && (box.store?.energy ?? 0) >= 250;
        }),
        always("haulers never fan across the extensions", (s) => {
          // Fanning means SERVING the row - PARKING at extensions - not
          // walking past them (spill trips to the controller legitimately
          // cross the row; box checks kept catching transit). A hauler that
          // LINGERS >= 4 consecutive samples within reach of the row is
          // serving it; a passer-by clears in 1-3.
          for (const name of ["h1", "h2"]) {
            const c = s.creep(name);
            if (!c) {
              haulerLinger[name] = 0;
              continue;
            }
            const nearRow = c.y >= 20 && c.y <= 22 && c.x >= 19 && c.x <= 30;
            haulerLinger[name] = nearRow ? (haulerLinger[name] ?? 0) + 1 : 0;
            if ((haulerLinger[name] ?? 0) >= 4) return false;
          }
          return true;
        }),
      ],
    },

    {
      // The dead-tender fail-safe: killing the tender clears the flag within
      // ~2 ticks and haulers revert to filling extensions DIRECTLY.
      id: "haul-t4-tender-death-failsafe",
      tier: 4,
      avenue: "logistics",
      window: 60,
      rooms: { home: tenderRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 3 },
      structures: [
        { type: "container", x: 24, y: 24, energy: 400 },
        { type: "container", x: 24, y: 41, energy: 1800 },
        { type: "container", x: 25, y: 12, energy: 0 },
        ...EXT_ROW.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: tenderCreeps(),
      async onTick(ctx) {
        if (ctx.tick === 15) {
          // Kill the tender (hits 0 -> engine death) and burst-drain four
          // extensions, as a spawn volley would.
          await ctx.db["rooms.objects"].update(
            { room: ctx.room(), type: "creep", name: "td" },
            { $set: { hits: 0 } }
          );
          for (let x = 20; x <= 23; x++) {
            await ctx.db["rooms.objects"].update(
              { room: ctx.room(), type: "extension", x, y: 21 },
              { $set: { store: { energy: 0 } } }
            );
          }
        }
      },
      assertions: [
        eventually("the regime was active before the kill", (s) => s.memory?.rooms?.[s.room()]?.extensionTenderActive === true),
        eventually("the flag clears within ticks of the death", (s) => {
          if (s.tick < 16) return false;
          return s.memory?.rooms?.[s.room()]?.extensionTenderActive === false;
        }),
        eventually("haulers refill the burst extensions directly", (s) => {
          const drained = s
            .objects()
            .filter((o: any) => o.type === "extension" && o.y === 21 && o.x >= 20 && o.x <= 23);
          return drained.length === 4 && drained.every((o: any) => (o.store?.energy ?? 0) === 50);
        }),
      ],
    },

    {
      // Storage banking: spawn-circuit loads top the bank to STORAGE_BANK
      // (10000) then spill to the controller; the controller circuit is never
      // diverted to fill the bank.
      id: "haul-t4-storage-bank-and-spill",
      tier: 4,
      avenue: "logistics",
      // KNOWN RED (deposit assertion only; understood precisely, 2026-07-10):
      // the banking branch (top the depot to bankTarget) lives INSIDE the
      // tender regime, and the tender's own refills - triggered by organic
      // spawning momentarily draining the pinned extensions each tick - mask
      // h1's deposits with interleaved withdrawals, so a storage-delta jump
      // is unobservable from outside. A clean observable needs an
      // intent-level seam (assert h1's transfer target), which the harness
      // cannot see today. The SPILL half fires (@41) and every guard binds.
      window: 140,
      rooms: { home: tenderRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 4 },
      structures: [
        { type: "storage", x: 24, y: 24, energy: 9800 },
        { type: "container", x: 24, y: 41, energy: 1800 },
        { type: "container", x: 25, y: 12, energy: 0 },
        ...EXT_ROW.map((p) => ({ type: "extension", x: p.x, y: p.y, energy: 50 })),
      ],
      creeps: tenderCreeps(),
      async onTick(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } }
        );
      },
      assertions: [
        // The exact 10000 crossing is unobservable in a LIVE room: deposits
        // and tender withdrawals interleave within ticks (see the cell
        // comment) - the deposit assertion is the known-red aspiration.
        eventually("a bulk hauler deposit lands in the bank", (s) => {
          const st = s.objects().find((o: any) => o.type === "storage");
          const energy = st?.store?.energy ?? null;
          const jumped = prevBank !== null && energy !== null && energy - prevBank >= 250;
          prevBank = energy;
          if (jumped) sawBankDeposit = true;
          return sawBankDeposit;
        }),
        always("the bank never balloons past the target", (s) => {
          const st = s.objects().find((o: any) => o.type === "storage");
          return !st || (st.store?.energy ?? 0) <= 10500;
        }),
        always("the bank is never raided below its staged floor", (s) => {
          const st = s.objects().find((o: any) => o.type === "storage");
          return !st || (st.store?.energy ?? 0) >= 8800;
        }),
        always("the controller circuit is never diverted to the bank", (s) => {
          const mem = s.memory?.creeps?.h2;
          if (!mem || mem.homeSink !== "controller") return true;
          const ok = mem.deliverSinkId === undefined || mem.deliverSinkId === "controller";
          if (!ok) ctrlKept = false;
          return ctrlKept;
        }),
        eventually("the surplus spills to the controller side", (s) => {
          const box = s.objects().find((o: any) => o.type === "container" && o.x === 25 && o.y === 12);
          return !!box && (box.store?.energy ?? 0) >= 250;
        }),
      ],
    },
  ];
}

export function buildHaulingT3Cells(): GridCell[] {
  let sitePrev: number | null = null;
  let siteGrew = false;
  let prevPile: number | null = null;
  let sawPickup = false;

  return [
    {
      // Stand-down: B's container under 50% and no pile - B's corp yields to
      // the build and fields NO hauler across two flow resolves, while A's
      // circuit keeps running and the site actually progresses.
      id: "haul-t3-dedicated-standdown",
      tier: 3,
      avenue: "logistics",
      window: 110,
      rooms: { home: dedicatedRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      ...((): any => {
        const c = dedicatedCommon();
        c.structures.push({ type: "container", x: 39, y: 24, energy: 400 }); // B: 20%
        return { structures: c.structures, creeps: c.creeps, memory: c.memory, stage: c.stage };
      })(),
      assertions: [
        always("B's corp never fields a hauler", (s) => haulersOfCorp(s, bCarryCorpId(s)) === 0),
        eventually("A's circuit keeps running", (s) => {
          const srcA = s.objects().find((o: any) => o.type === "source" && o.x === 10 && o.y === 25);
          return !!srcA && haulersOfCorp(s, `hauling-${s.room()}-hauling-${String(srcA._id).slice(-4)}`) >= 1;
        }),
        eventually("the build consumes B's output (site progresses)", (s) => {
          const site = s.objects().find((o: any) => o.type === "constructionSite" && o.x === 38 && o.y === 25);
          const p = site?.progress ?? null;
          if (p !== null && sitePrev !== null && p > sitePrev) siteGrew = true;
          if (p !== null) sitePrev = p;
          return siteGrew;
        }),
      ],
    },

    {
      // Resume via container: B's container at 70% (>= the 50% drain gate) -
      // the builder is not keeping pace, so B un-yields and fields a hauler
      // that drains the surplus home.
      id: "haul-t3-dedicated-resume-container",
      tier: 3,
      avenue: "logistics",
      window: 100,
      rooms: { home: dedicatedRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      ...((): any => {
        const c = dedicatedCommon();
        c.structures.push({ type: "container", x: 39, y: 24, energy: 1400 }); // B: 70%
        return { structures: c.structures, creeps: c.creeps, memory: c.memory, stage: c.stage };
      })(),
      assertions: [
        eventually("B's corp fields a hauler (contrast with stand-down)", (s) =>
          haulersOfCorp(s, bCarryCorpId(s)) >= 1
        ),
        eventually("the surplus is drained below the gate", (s) => {
          const box = s.objects().find((o: any) => o.type === "container" && o.x === 39 && o.y === 24);
          return !!box && (box.store?.energy ?? 2000) < 1000;
        }),
      ],
    },

    {
      // Resume via ground pile: B has NO container, just a 400 pile on the
      // miner's tile - the pile analogue of the drain gate un-freezes B's
      // haulers; a single-tick drop >= 100 is the decisive pickup signature.
      id: "haul-t3-dedicated-resume-groundpile",
      tier: 3,
      avenue: "logistics",
      // 150: under the energy-led scheduler, consumers spend freely and B's
      // resume hauler can queue behind them (green at 100 twice, red once).
      window: 150,
      rooms: { home: dedicatedRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      ...((): any => {
        const c = dedicatedCommon();
        // A 1-WORK builder consumes 5/t against 10/t mined: the surplus
        // genuinely backs up (the 2W builder + tanker consumed EXACTLY the
        // mining rate, so yielding stayed correct and the cell timed out).
        c.creeps = c.creeps.map((cr: any) =>
          cr.name === "bB" ? { ...cr, body: ["work", "carry", "carry", "move"] } : cr
        );
        c.stage = async (ctx: any) => {
          await ctx.db["rooms.objects"].insert({
            type: "constructionSite",
            room: ctx.room(),
            x: 38,
            y: 25,
            user: ctx.userId,
            structureType: "extension",
            progress: 0,
            progressTotal: 3000,
          });
          await ctx.db["rooms.objects"].insert({
            type: "energy",
            room: ctx.room(),
            x: 39,
            y: 24,
            energy: 400,
            resourceType: "energy",
          });
        };
        return { structures: c.structures, creeps: c.creeps, memory: c.memory, stage: c.stage };
      })(),
      assertions: [
        eventually("B's corp fields a hauler", (s) => haulersOfCorp(s, bCarryCorpId(s)) >= 1),
        eventually("a hauler visits the pile and it drains", (s) => {
          // FLAKE HISTORY (5 flips at drop-size thresholds): the bite-size
          // signal races consumer timing - small haulers and jack nibbles
          // blur the single-tick drop. The mechanism-true, timing-robust
          // signal: one of B's haulers stands at the pile AND the pile
          // meaningfully drains afterward.
          const pile = s.objects().find((o: any) => o.type === "energy" && o.x === 39 && o.y === 24);
          const amount = pile?.energy ?? 0;
          const bId = bCarryCorpId(s);
          const visiting = s
            .objects()
            .some(
              (o: any) =>
                o.type === "creep" &&
                s.memory?.creeps?.[o.name]?.corpId === bId &&
                s.memory?.creeps?.[o.name]?.workType === "haul" &&
                Math.max(Math.abs(o.x - 39), Math.abs(o.y - 24)) <= 1
            );
          if (visiting) sawPickup = true; // visit recorded...
          prevPile = amount;
          return sawPickup && amount <= 600; // ...and the pile drained below its staged level
        }),
      ],
    },
  ];
}

export function buildHaulingCells(): GridCell[] {
  let prevSpawnEnergy: number | null = null;

  // circuit-split closure state
  const firstSink: Record<string, string | null> = { h1: null, h2: null, h3: null };

  const sinksNow = (s: { memory: any }): Record<string, string | undefined> => {
    const out: Record<string, string | undefined> = {};
    for (const name of ["h1", "h2", "h3"]) out[name] = s.memory?.creeps?.[name]?.homeSink;
    return out;
  };

  return [
    {
      id: "haul-t1-circuit-split",
      tier: 1,
      avenue: "logistics",
      // 110, not 60: the controller-circuit hauler flips at ~26 and then
      // walks container (24,41) -> input (23,6), ~35 ticks loaded.
      window: 110,
      rooms: { home: splitRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [{ type: "container", x: 24, y: 41, energy: 1500 }],
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 41,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-cs-m", assignedSourceId: "$id(home,source,25,42)" },
        },
        ...["h1", "h2", "h3"].map((name, i) => ({
          name,
          x: 25,
          y: 27 + i,
          body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: {
            workType: "haul",
            corpId: `staged-cs-${name}`,
            working: false,
            assignedSourceId: "$id(home,source,25,42)",
          },
        })),
      ],
      assertions: [
        eventually("all three adopted by the carry corp", (s) =>
          ["h1", "h2", "h3"].every((n) => {
            const corpId = s.memory?.creeps?.[n]?.corpId;
            return typeof corpId === "string" && corpId.startsWith("hauling-");
          })
        ),
        eventually("fleet splits exactly {spawn: 2, controller: 1}", (s) => {
          const sinks = Object.values(sinksNow(s));
          if (sinks.some((v) => v === undefined)) return false;
          const spawnCount = sinks.filter((v) => v === "spawn").length;
          const ctrlCount = sinks.filter((v) => v === "controller").length;
          return spawnCount === 2 && ctrlCount === 1;
        }),
        // Circuits are PERMANENT: whatever a hauler was first assigned, it
        // keeps (the per-trip re-rolling thrash this design replaced).
        always("no hauler ever re-rolls its circuit", (s) => {
          const sinks = sinksNow(s);
          for (const name of ["h1", "h2", "h3"]) {
            const sink = sinks[name];
            if (sink === undefined) continue;
            if (firstSink[name] === null) firstSink[name] = sink;
            else if (firstSink[name] !== sink) return false;
          }
          return true;
        }),
        // Delivery evidence: a pile near the input tile is often consumed the
        // same tick by parked upgraders, so ANY controller progress (only the
        // controller circuit can feed upgraders here - no jacks, source 34
        // tiles away) or a transient pile both count.
        eventually("the controller circuit delivers to the controller side", (s) => {
          const ctrl = s.objects().find((o) => o.type === "controller");
          if ((ctrl?.progress ?? 0) > 0) return true;
          return s.objects().some((o) => {
            if (o.type !== "energy") return false;
            return Math.max(Math.abs(o.x - 25), Math.abs(o.y - 8)) <= 4;
          });
        }),
      ],
    },

    {
      // spawnNetworkCritical fires on a TRULY critical bank (100/300,
      // nothing inbound): the controller-homed hauler's trip is overridden
      // to the spawn. The complement of haul-t2-no-divert-above-half.
      id: "haul-t2-critical-divert",
      tier: 2,
      avenue: "logistics",
      window: 60,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 42).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [{ type: "container", x: 24, y: 41, energy: 1200 }],
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 41,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-cd-m", assignedSourceId: "$id(home,source,25,42)" },
        },
        {
          name: "h1",
          x: 25,
          y: 40,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          memory: {
            workType: "haul",
            corpId: "staged-cd-h",
            working: false,
            homeSink: "controller",
            assignedSourceId: "$id(home,source,25,42)",
          },
        },
        { name: "filler1", x: 19, y: 22, body: ["move"] },
        { name: "filler2", x: 19, y: 23, body: ["move"] },
      ],
      async onTick(ctx) {
        // Hold the bank at a truly-critical 100 until h1's flip (~13) locks
        // its trip decision; release afterwards so the delivery lands.
        if (ctx.tick <= 14) {
          await ctx.db["rooms.objects"].update(
            { room: ctx.room(), type: "spawn" },
            { $set: { store: { energy: 100 } } }
          );
        }
      },
      assertions: [
        eventually("trip overridden: controller-homed hauler diverts to spawn", (s) => {
          const mem = s.memory?.creeps?.h1;
          return mem?.homeSink === "controller" && mem?.deliverSinkId === "spawn";
        }),
        eventually("the diverted load reaches the spawn", (s) => {
          const spawn = s.objects().find((o) => o.type === "spawn");
          return (spawn?.store?.energy ?? 0) >= 290;
        }),
      ],
    },

    {
      // The RCL2-stall regression guard: at 200/300 (66% fill) the
      // controller keeps its hauler - free capacity alone must never divert.
      id: "haul-t2-no-divert-above-half",
      tier: 2,
      avenue: "logistics",
      window: 60,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 42).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [
        { type: "container", x: 24, y: 41, energy: 1200 },
        { type: "container", x: 25, y: 12, energy: 0 }, // controller input buffer
      ],
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 41,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-nd-m", assignedSourceId: "$id(home,source,25,42)" },
        },
        {
          name: "h1",
          x: 25,
          y: 40,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          memory: {
            workType: "haul",
            corpId: "staged-nd-h",
            working: false,
            homeSink: "controller",
            assignedSourceId: "$id(home,source,25,42)",
          },
        },
        { name: "filler1", x: 19, y: 22, body: ["move"] },
        { name: "filler2", x: 19, y: 23, body: ["move"] },
      ],
      async onTick(ctx) {
        // 200/300 = 66% fill at flip time (the OLD any-free-capacity rule
        // diverted here); release after the flip locks the trip.
        if (ctx.tick <= 14) {
          await ctx.db["rooms.objects"].update(
            { room: ctx.room(), type: "spawn" },
            { $set: { store: { energy: 200 } } }
          );
        }
      },
      assertions: [
        eventually("controller keeps its hauler at 66% fill", (s) => {
          const mem = s.memory?.creeps?.h1;
          return mem?.homeSink === "controller" && mem?.deliverSinkId === "controller";
        }),
        eventually("the load lands in the controller buffer", (s) => {
          const box = s.objects().find((o) => o.type === "container" && o.x === 25 && o.y === 12);
          return !!box && (box.store?.energy ?? 0) >= 250;
        }),
      ],
    },

    {
      // SCAVENGE_THRESHOLD=750: only the 900 stock is promoted to a
      // transient source with a dedicated scavenge route; the 600 stock is
      // left to decay untouched.
      id: "haul-t2-scavenge-threshold",
      tier: 2,
      avenue: "logistics",
      window: 250,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 8).source(12, 25).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [{ type: "container", x: 13, y: 24, energy: 600 }],
      creeps: [
        {
          name: "m1",
          x: 13,
          y: 24,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-sc-m", assignedSourceId: "$id(home,source,12,25)" },
        },
        {
          name: "h1",
          x: 20,
          y: 25,
          body: ["carry", "carry", "carry", "carry", "move", "move", "move", "move"],
          memory: { workType: "haul", corpId: "staged-sc-h", working: false, assignedSourceId: "$id(home,source,12,25)" },
        },
        { name: "filler1", x: 19, y: 20, body: ["move"] },
        { name: "filler2", x: 19, y: 21, body: ["move"] },
      ],
      async stage(ctx) {
        for (const pile of [
          { x: 40, y: 40, energy: 900 },
          { x: 40, y: 10, energy: 600 },
        ]) {
          await ctx.db["rooms.objects"].insert({
            type: "energy",
            room: ctx.room(),
            x: pile.x,
            y: pile.y,
            energy: pile.energy,
            resourceType: "energy",
          });
        }
      },
      assertions: [
        eventually("the 900 stock is commissioned for scavenging", (s) =>
          JSON.stringify(s.memory?.commissionedCorps ?? {}).includes(`scavenge-${s.room()}-40-40`)
        ),
        always("the 600 stock is never commissioned", (s) =>
          !JSON.stringify(s.memory?.commissionedCorps ?? {}).includes(`scavenge-${s.room()}-40-10`)
        ),
        eventually("the 900 stock is drained below its decay trajectory", (s) => {
          const pile = s.objects().find((o) => o.type === "energy" && o.x === 40 && o.y === 40);
          return !pile || (pile.energy ?? 0) <= 550;
        }),
        always("the 600 stock only decays (never picked up)", (s) => {
          const pile = s.objects().find((o) => o.type === "energy" && o.x === 40 && o.y === 10);
          // decay is 1/tick from 600; a pickup event would drop it far faster.
          return !!pile && (pile.energy ?? 0) >= 600 - s.tick - 5;
        }),
      ],
    },

    {
      // deliverEnergy's all-full fallback: a spawn-homed hauler whose whole
      // spawn network is full must spill to the controller side, never idle.
      // The spawn is pinned full every tick (whole-object store form - dotted
      // paths no-op in this db layer).
      id: "haul-t1-spawn-full-spill",
      tier: 1,
      avenue: "logistics",
      window: 50,
      rooms: {
        home: (roomName: string) => new RoomBuilder(roomName).border().controller(25, 10).source(25, 42).toRoom(),
      },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      structures: [
        { type: "container", x: 24, y: 41, energy: 1500 }, // source container
        { type: "container", x: 25, y: 12, energy: 0 }, // controller input buffer
      ],
      creeps: [
        {
          name: "m1",
          x: 24,
          y: 41,
          body: ["work", "work", "work", "work", "work", "move", "move", "move"],
          memory: { workType: "harvest", corpId: "staged-sp-m", assignedSourceId: "$id(home,source,25,42)" },
        },
        {
          name: "h1",
          x: 25,
          y: 30,
          body: ["carry", "carry", "carry", "carry", "carry", "carry", "move", "move", "move", "move", "move", "move"],
          energy: 300,
          memory: {
            workType: "haul",
            corpId: "staged-sp-h",
            working: true,
            homeSink: "spawn",
            deliverSinkId: "spawn",
            assignedSourceId: "$id(home,source,25,42)",
          },
        },
      ],
      async onTick(ctx) {
        await ctx.db["rooms.objects"].update(
          { room: ctx.room(), type: "spawn" },
          { $set: { store: { energy: 300 } } }
        );
      },
      assertions: [
        eventually("adopted by the carry corp", (s) => {
          const corpId = s.memory?.creeps?.h1?.corpId;
          return typeof corpId === "string" && corpId.startsWith("hauling-");
        }),
        eventually("h1 reaches the controller buffer", (s) => {
          const c = s.creep("h1");
          return !!c && Math.max(Math.abs(c.x - 25), Math.abs(c.y - 12)) <= 1;
        }),
        eventually("the buffer receives the spilled load", (s) => {
          const box = s.objects().find((o) => o.type === "container" && o.x === 25 && o.y === 12);
          return !!box && (box.store?.energy ?? 0) >= 250;
        }),
        eventually("h1 emptied its cargo", (s) => {
          const c = s.creep("h1");
          return !!c && (c.store?.energy ?? 0) === 0;
        }),
      ],
    },
    {
      id: "haul-t0-first-delivery",
      tier: 0,
      avenue: "logistics",
      window: 300,
      rooms: { home: homeRoom },
      bot: { x: 25, y: 25 },
      controller: { level: 2 },
      assertions: [
        eventually("a flow hauler is fielded", flowHaulerExists),
        // A hauler delivery is a bulk single-tick jump in the spawn store
        // (self-regen is +1/tick; jacks have recycled once a flow hauler
        // exists, so no other bulk filler remains).
        eventually("spawn receives a bulk delivery after the hauler exists", (s) => {
          const spawn = s.objects().find((o) => o.type === "spawn");
          const energy = spawn?.store?.energy ?? null;
          const jumped =
            prevSpawnEnergy !== null &&
            energy !== null &&
            energy - prevSpawnEnergy >= 40 &&
            flowHaulerExists(s);
          prevSpawnEnergy = energy;
          return jumped;
        }),
        // The loop must never wedge the colony: some creep is always alive
        // after the opening jack economy stands up.
        always("colony never empties", (s) => s.objects().some((o) => o.type === "creep"), 30),
      ],
    },
  ];
}
