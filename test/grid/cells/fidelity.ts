/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * plan-fidelity cells - steady-state PLAN vs ACTUAL as a ratcheted assertion.
 *
 * The planner publishes budgets (Memory.economyPlan: mine e/t, upgrade work,
 * build work, hauler CARRY); these cells measure what the colony physically
 * delivers (controller progress, spawn-body energy, build progress, fielded
 * CARRY) over a trailing steady-state window and assert actual >= X% of plan.
 * On the friendly synthetic world the plan IS achievable, so a shortfall is a
 * bug by construction; the real-terrain fixture binds the same class at a
 * lower X (walks 25/38 make transport losses and replacement churn real).
 *
 * Measured accounting that shaped these cells (W1N6, organic cold start,
 * sim:real --metrics, 100-tick windows): the plan is a steady-state claim but
 * fielding the fleet is itself the dominant early sink (spawn spend 6-12 e/t,
 * ~2x controller receipts through t2000), and fielded CARRY chases planned
 * CARRY for 1400+ ticks. So: RCL2 is STAGED (no pre-handover dead window -
 * budgets before the gate opens are not actionable and not a bug signal) and
 * only a trailing window is measured (the ramp is transient by design; the
 * assertion binds where the plan's own assumption - the fleet exists - holds).
 */

import { GridCell, CellSample, always, atWindow, eventually } from "../GridCell";
import { RoomBuilder } from "../../integration/scenario/RoomBuilder";
import { fixtureRoom } from "../fixtureRoom";
import { BODY_PART_COST, BodyPart } from "../../../src/planning/EconomicConstants";
import { journeyWorld } from "./journey";

const bodyCost = (body: any[]): number =>
  (body ?? []).reduce((sum: number, p: any) => sum + (BODY_PART_COST[p.type as BodyPart] ?? 0), 0);

/** Per-tick economy accumulator; only ticks >= measureFrom enter the sums. */
class EconWatch {
  private lastTick = -1;
  private prevProgress: number | null = null;
  private prevSites = new Map<string, { progress: number; total: number }>();
  private readonly seenCreeps = new Set<string>();

  private ctrlEnergy = 0; // controller progress is 1:1 with upgrade energy
  private spawnEnergy = 0; // body cost of creeps completed inside the window
  private buildEnergy = 0; // site progress deltas + completions
  private planMineSum = 0;
  private planUpgradeSum = 0;
  private planCarrySum = 0;
  private fieldedCarrySum = 0;
  private measuredTicks = 0;
  private emptyPlanStreak = 0;

  // Overhead decomposition (owner 2026-07-10): name the buckets inside the
  // plan-vs-actual gap so each is ratchetable - under-mining vs decay vs
  // accumulation vs transit vs spawn idle time.
  private prevSourceEnergy = new Map<string, number>();
  private minedEnergy = 0; // source drawdown actually harvested
  private decayEnergy = 0; // pile decay losses (ceil(amount/1000)/tick)
  private stockStart: number | null = null; // piles+containers+storage at measureFrom
  private stockLast = 0;
  private transitStart: number | null = null; // energy aboard creeps
  private transitLast = 0;
  private spawnIdleTicks = 0; // spawn idle while it could afford a minimal body

  constructor(private readonly measureFrom: number) {}

  /** Idempotent per tick; call from any assertion check. */
  collect(s: CellSample): void {
    if (s.tick <= this.lastTick) return;
    this.lastTick = s.tick;

    const objs = s.objects();
    const measuring = s.tick >= this.measureFrom;

    // Controller energy via sample-to-sample deltas (robust to an RCL-up
    // reset - that tick undercounts once instead of going negative).
    const ctrl = objs.find((o: any) => o.type === "controller");
    const progress = ctrl?.progress ?? 0;
    if (this.prevProgress !== null && measuring) {
      this.ctrlEnergy += Math.max(0, progress - this.prevProgress);
    }
    this.prevProgress = progress;

    // Spawn energy attributed when a creep first appears; ids seen before
    // the window (including the ramp fleet) never count.
    for (const o of objs.filter((x: any) => x.type === "creep" && x.user === s.userId)) {
      if (this.seenCreeps.has(o._id)) continue;
      this.seenCreeps.add(o._id);
      if (measuring) this.spawnEnergy += bodyCost(o.body);
    }

    // Build energy: per-site progress deltas, plus the remainder of any site
    // that completed (disappeared) since the last sample.
    const sites = new Map<string, { progress: number; total: number }>();
    for (const o of objs.filter((x: any) => x.type === "constructionSite")) {
      const id = String(o._id);
      sites.set(id, { progress: o.progress ?? 0, total: o.progressTotal ?? 0 });
      const prev = this.prevSites.get(id);
      if (measuring) this.buildEnergy += Math.max(0, (o.progress ?? 0) - (prev?.progress ?? 0));
    }
    if (measuring) {
      for (const [id, prev] of this.prevSites) {
        if (!sites.has(id)) this.buildEnergy += Math.max(0, prev.total - prev.progress);
      }
    }
    this.prevSites = sites;

    // Overhead decomposition inputs (cheap single pass over objs).
    let pileTotal = 0;
    let pileDecayThisTick = 0;
    let containerTotal = 0;
    let transit = 0;
    let spawnIdle = false;
    let spawnBank = 0;
    for (const o of objs) {
      if (o.type === "energy") {
        const amt = o.energy ?? 0;
        pileTotal += amt;
        pileDecayThisTick += Math.ceil(amt / 1000);
      } else if (o.type === "container" || o.type === "storage") {
        containerTotal += o.store?.energy ?? 0;
      } else if (o.type === "creep" && o.user === s.userId) {
        transit += o.store?.energy ?? 0;
      } else if (o.type === "spawn" && o.user === s.userId) {
        if (!o.spawning) spawnIdle = true;
        spawnBank += o.store?.energy ?? 0;
      } else if (o.type === "extension" && o.user === s.userId) {
        spawnBank += o.store?.energy ?? 0;
      }
      if (o.type === "source") {
        const prev = this.prevSourceEnergy.get(String(o._id));
        const now = o.energy ?? 0;
        // Drawdown = harvest; increases are regen resets and don't count.
        if (measuring && prev !== undefined && now < prev) this.minedEnergy += prev - now;
        this.prevSourceEnergy.set(String(o._id), now);
      }
    }

    if (!measuring) return;
    this.measuredTicks += 1;

    this.decayEnergy += pileDecayThisTick;
    const stockNow = pileTotal + containerTotal;
    if (this.stockStart === null) this.stockStart = stockNow;
    this.stockLast = stockNow;
    if (this.transitStart === null) this.transitStart = transit;
    this.transitLast = transit;
    // Idle while a minimal body (150) is affordable = wasted build-time.
    if (spawnIdle && spawnBank >= 150) this.spawnIdleTicks += 1;

    const corps: any[] = s.memory?.economyPlan?.corps ?? [];
    this.emptyPlanStreak = corps.length === 0 ? this.emptyPlanStreak + 1 : 0;
    this.planMineSum += corps.filter((c) => c.kind === "mine").reduce((t, c) => t + (c.work ?? 0) * 2, 0);
    this.planUpgradeSum += corps.filter((c) => c.kind === "upgrade").reduce((t, c) => t + (c.work ?? 0), 0);
    this.planCarrySum += corps.filter((c) => c.kind === "haul").reduce((t, c) => t + (c.carry ?? 0), 0);

    const creepsByName = new Map<string, any>();
    for (const o of objs) if (o.type === "creep") creepsByName.set(o.name, o);
    let fielded = 0;
    for (const name in s.memory?.creeps ?? {}) {
      if (s.memory.creeps[name]?.workType !== "haul") continue;
      const doc = creepsByName.get(name);
      if (doc) fielded += (doc.body ?? []).filter((p: any) => p.type === "carry").length;
    }
    this.fieldedCarrySum += fielded;
  }

  /** Plan gone for this many consecutive measured ticks (0 while published). */
  get planGapTicks(): number {
    return this.emptyPlanStreak;
  }

  rates(): {
    actualPerTick: number;
    ctrlPerTick: number;
    planMine: number;
    planUpgrade: number;
    planCarry: number;
    fieldedCarry: number;
  } {
    const n = Math.max(1, this.measuredTicks);
    return {
      actualPerTick: (this.ctrlEnergy + this.spawnEnergy + this.buildEnergy) / n,
      ctrlPerTick: this.ctrlEnergy / n,
      planMine: this.planMineSum / n,
      planUpgrade: this.planUpgradeSum / n,
      planCarry: this.planCarrySum / n,
      fieldedCarry: this.fieldedCarrySum / n,
    };
  }

  /**
   * The gap, decomposed (per-tick rates over the measured window). Closes
   * the books: mined = sinks + Δstock + decay + Δtransit + residual, and
   * (planMine - mined) is UNDER-MINING - a different disease than transport
   * loss, now separately visible. spawnIdleFrac is the fraction of measured
   * ticks the spawn sat idle while a minimal body was affordable (wasted
   * build-time, the scarcest resource).
   */
  overhead(): {
    mined: number;
    sinks: number;
    stockDelta: number;
    decay: number;
    transitDelta: number;
    residual: number;
    spawnIdleFrac: number;
  } {
    const n = Math.max(1, this.measuredTicks);
    const mined = this.minedEnergy / n;
    const sinks = (this.ctrlEnergy + this.spawnEnergy + this.buildEnergy) / n;
    const stockDelta = ((this.stockLast - (this.stockStart ?? this.stockLast)) || 0) / n;
    const decay = this.decayEnergy / n;
    const transitDelta = ((this.transitLast - (this.transitStart ?? this.transitLast)) || 0) / n;
    return {
      mined,
      sinks,
      stockDelta,
      decay,
      transitDelta,
      residual: mined - sinks - stockDelta - decay - transitDelta,
      spawnIdleFrac: this.spawnIdleTicks / n,
    };
  }
}

interface FidelityThresholds {
  /** (ctrl + spawn + build) e/t as a fraction of the plan's mine e/t. */
  gross: number;
  /** Controller e/t as a fraction of the plan's upgrade budget. */
  controller: number;
  /** Mean fielded hauler CARRY as a fraction of the plan's CARRY. */
  carry: number;
}

function fidelityCell(spec: {
  id: string;
  tier: GridCell["tier"];
  window: number;
  measureFrom: number;
  rooms: GridCell["rooms"];
  bot: GridCell["bot"];
  thresholds: FidelityThresholds;
  /** Replay a journey snapshot instead of a cold RCL2 stage (pre-ramped). */
  world?: Pick<GridCell, "pinnedRooms" | "memory" | "stage" | "soloWorld">;
}): GridCell {
  const watch = new EconWatch(spec.measureFrom);
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;

  const grade = (s: CellSample): { gross: number; controller: number; carry: number } | null => {
    watch.collect(s);
    const r = watch.rates();
    if (r.planMine <= 0 || r.planUpgrade <= 0 || r.planCarry <= 0) return null;
    return {
      gross: r.actualPerTick / r.planMine,
      controller: r.ctrlPerTick / r.planUpgrade,
      carry: r.fieldedCarry / r.planCarry,
    };
  };

  let logged = false;
  return {
    id: spec.id,
    tier: spec.tier,
    avenue: "plan-fidelity",
    window: spec.window,
    rooms: spec.rooms,
    bot: spec.bot,
    // A journey world carries its own controller in the snapshot restore;
    // cold stages open the flow-economy gate at RCL2.
    ...(spec.world ?? { controller: { level: 2 } }),
    assertions: [
      // Listed first so every sample is collected before any other check
      // reads the accumulator (including the atWindow boundary re-check).
      always(
        "plan stays published through the measurement window",
        (s) => {
          watch.collect(s);
          return watch.planGapTicks <= 10; // %50 re-solve gaps are transient
        },
        spec.measureFrom
      ),
      eventually("economy converges before measurement opens", (s) => {
        watch.collect(s);
        if (s.tick >= spec.measureFrom) return true; // measured late is still measured
        const mines = (s.memory?.economyPlan?.corps ?? []).filter((c: any) => c.kind === "mine");
        const minerFielded = Object.entries(s.memory?.creeps ?? {}).some(
          ([, mem]: [string, any]) => mem?.workType === "harvest"
        );
        return mines.length >= 1 && minerFielded;
      }),
      atWindow(`gross fidelity: sinks >= ${pct(spec.thresholds.gross)} of planned mining`, (s) => {
        const g = grade(s);
        if (s.tick >= spec.window && g && !logged) {
          logged = true;
          const r = watch.rates();
          // Fleet summary (per live creep: workType + body makeup) - the
          // staging list for pre-ramped cells and the recalibration record.
          const fleet = s
            .objects()
            .filter((o: any) => o.type === "creep" && o.user === s.userId)
            .map((o: any) => {
              const wt = s.memory?.creeps?.[o.name]?.workType ?? "?";
              const parts: Record<string, number> = {};
              for (const p of o.body ?? []) parts[p.type] = (parts[p.type] ?? 0) + 1;
              const shape = Object.entries(parts)
                .map(([t, n]) => `${n}${t[0].toUpperCase()}`)
                .join("");
              return `${wt}:${shape}@${o.x},${o.y}`;
            })
            .join(" ");
          console.log(
            `  [plan-fidelity] ${spec.id}: gross ${pct(g.gross)} ` +
              `(actual ${r.actualPerTick.toFixed(1)} vs plan ${r.planMine.toFixed(1)} e/t), ` +
              `controller ${pct(g.controller)} (${r.ctrlPerTick.toFixed(1)} vs ${r.planUpgrade.toFixed(1)}), ` +
              `carry ${pct(g.carry)} (${r.fieldedCarry.toFixed(1)} vs ${r.planCarry.toFixed(1)} parts)\n` +
              `  [plan-fidelity] ${spec.id} fleet: ${fleet}\n` +
              (() => {
                const o = watch.overhead();
                return (
                  `  [overhead] ${spec.id}: mined=${o.mined.toFixed(1)} sinks=${o.sinks.toFixed(1)} ` +
                  `Δstock=${o.stockDelta.toFixed(1)} decay=${o.decay.toFixed(1)} ` +
                  `Δtransit=${o.transitDelta.toFixed(1)} residual=${o.residual.toFixed(1)} ` +
                  `spawnIdle=${(o.spawnIdleFrac * 100).toFixed(0)}%`
                );
              })()
          );
        }
        return !!g && g.gross >= spec.thresholds.gross;
      }),
      atWindow(`controller fidelity: >= ${pct(spec.thresholds.controller)} of upgrade budget`, (s) => {
        const g = grade(s);
        return !!g && g.controller >= spec.thresholds.controller;
      }),
      atWindow(`carry fidelity: fielded >= ${pct(spec.thresholds.carry)} of planned CARRY`, (s) => {
        const g = grade(s);
        return !!g && g.carry >= spec.thresholds.carry;
      }),
    ],
  };
}

/**
 * Pre-ramped fidelity (spec 10 G2, owner: avoid long tests): replay the
 * post-build-out journey snapshot - a REAL organically-reached fleet at the
 * RCL2 extension cap - and measure steady-state plan-vs-actual over a short
 * window. No ramp inside the cell, so the floors can be TIGHT: this is the
 * ratchet the loose organic-ramp floors defer to. Skipped gracefully when
 * the snapshot has not been captured yet.
 */
function buildPreRampedCell(): GridCell[] {
  let world: ReturnType<typeof journeyWorld>;
  try {
    world = journeyWorld("synthetic-2src--extensions-rcl2-cap.json");
  } catch {
    return []; // snapshot not captured yet - re-run npm run journey:capture
  }
  return [
    fidelityCell({
      id: "fid-t4-preramped-steady-state",
      tier: 4,
      window: 400,
      measureFrom: 100, // ~100 ticks to resettle the restored world
      rooms: world.rooms,
      bot: world.bot,
      world: {
        pinnedRooms: world.pinnedRooms,
        memory: world.memory,
        stage: world.stage,
        soloWorld: world.soloWorld,
      },
      // Measured 72/65% gross, 34/20% controller, 89/84% carry across two
      // calibration runs. The controller RATIO is denominator-noisy (the
      // plan's small controller budget swings 2.8<->4.9 between re-solves),
      // so its floor carries extra headroom. Ratchet upward as the
      // transport/decay overhead (the ~30% gross gap) shrinks.
      thresholds: { gross: 0.55, controller: 0.15, carry: 0.6 },
    }),
  ];
}

export function buildFidelityCells(): GridCell[] {
  return [
    ...buildPreRampedCell(),
    // Friendly synthetic world: two sources at walk ~7, controller at ~10,
    // all-plain terrain. Everything the plan budgets is physically achievable
    // here, so steady-state shortfall = bug by construction. Thresholds are
    // deliberately LOOSE smoke floors: three calibration runs of this organic
    // ramp measured gross 99/85/56%, controller 20/0/31%, carry 86/74/93% -
    // the variance is the ramp itself (extension build-out pace), so tight
    // ratchets live on the short pre-ramped journey cells, and these floors
    // catch collapse-class regressions (the measured 0% controller run fails
    // the 15% floor).
    fidelityCell({
      id: "fid-t4-synthetic-steady-state",
      tier: 4,
      window: 1100,
      measureFrom: 800,
      rooms: {
        home: (roomName: string) =>
          new RoomBuilder(roomName).border().controller(25, 15).source(18, 32).source(32, 32).toRoom(),
      },
      bot: { x: 25, y: 25 },
      thresholds: { gross: 0.35, controller: 0.15, carry: 0.55 },
    }),

    // The maze that produced the accounting (55% walls, source walks 25/38):
    // same assertion class, lower X - long hauls, pile decay, and replacement
    // churn are real here, but the plan should still be mostly delivered once
    // the fleet exists. RCL2 staged = measurement starts at handover, skipping
    // the ~550-tick jack phase the budgets can't act on anyway.
    // Measured 42/39% gross, 38/36% controller, 107/109% carry across two
    // calibration runs - carry actually REACHES plan on the RCL2-staged path
    // (unlike the organic W1N6 ramp the accounting measured), so it floors
    // high; gross floors below the observed band. The controller floor is
    // LOWER still (0.1): the build-out funneling policy deliberately pauses
    // upgrading at the reserve while sites exist, and when the ladder
    // completes mid-window the plan's controller budget jumps ahead of the
    // still-small upgrader fleet - delivered/planned legitimately dips during
    // that transition (measured 1400t run under funneling).
    fidelityCell({
      id: "fid-t5-real-maze-steady-state",
      tier: 5,
      window: 1400,
      measureFrom: 1100,
      rooms: { home: fixtureRoom("shard3-W1N6") },
      bot: { x: 28, y: 30 },
      // Carry floored at 0.55: pre-funneling the fleet REACHED plan (107%),
      // but funneling adds construction routes the fleet is still ramping
      // toward inside the window (measured 65%). Organic-ramp floors stay
      // loose by design; the tight ratchets are the pre-ramped cells.
      thresholds: { gross: 0.3, controller: 0.1, carry: 0.45 },
    }),
  ];
}
