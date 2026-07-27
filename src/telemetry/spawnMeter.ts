/**
 * @fileoverview The spawn meter - MEASURED spawn utilization (spec 14 phase 3).
 *
 * Charter: the accumulator that observes every spawn every tick (busy/idle,
 * gapped build-finishes with their fill ratio, idle-cause attribution against
 * the NOW-plan head) plus the pure idle classifier. Accumulation state lives
 * in `Memory.spawnMeter` windows - NOT on the heap - so it survives global
 * resets and Telemetry re-instantiation (the spawnMeter unit suite pins this:
 * "window state in Memory, not heap"). The `last` guard makes a second call in
 * the same tick a no-op, so the orchestrator can run it unconditionally before
 * its interval gate. The READOUT (segment 0's `spawns[]` array) lives in
 * telemetry/coreSegment, which reads these windows.
 *
 * Layer: telemetry instrument (Game/Memory-coupled accumulator; writes only
 * Memory.spawnMeter). `classifySpawnIdle` is pure.
 *
 * @module telemetry/spawnMeter
 */

/** Spawn-meter window length: one creep lifetime, the economy's natural period. */
const SPAWN_METER_WINDOW = 1500;

/** Why a spawn stood idle this tick (spec 14, owner 2026-07-25). */
export type SpawnIdleCause = "empty" | "bank" | "buy" | "hold";

/**
 * Classify one idle (non-spawning) spawn tick by its NOW-plan queue head, so the
 * ~13% steady-state idle on a saturated single spawn is attributable instead of
 * a guess. Reads the SAME agenda the scheduler published this tick:
 *
 *   - empty: no queue head - the plan is not demanding a body. Genuine spare
 *            capacity; if we are "short on haulers" the gap is on the DEMAND
 *            side (the planner isn't asking), not the spawn.
 *   - bank:  the head can't afford its own minCost (`bank>=N` precondition) -
 *            energy-STARVED at the spawn door (tender refill lag or an
 *            indivisible body banking). Recoverable by feeding the spawn faster.
 *   - buy:   the head was gated "buy" yet the spawn idled - decision/exec
 *            latency (the director should have spawned it).
 *   - hold:  the head is affordable but held/queued behind a higher demand or
 *            banking for its desiredCost - a CHOSEN wait.
 *
 * An unaffordable head is energy-starved regardless of a stale gate, so the
 * `bank` precondition is checked first. Pure.
 */
export function classifySpawnIdle(head: { precondition?: string; gate?: string } | undefined): SpawnIdleCause {
  if (!head) return "empty";
  if (typeof head.precondition === "string" && head.precondition.indexOf("bank>=") === 0) return "bank";
  if (head.gate === "buy") return "buy";
  return "hold";
}

/**
 * Accumulate the spawn meter: one observation per spawn per tick (the `last`
 * guard makes a second update() call in the same tick a no-op). Windows roll
 * after SPAWN_METER_WINDOW ticks.
 */
export function meterSpawns(): void {
  const spawns = Game.spawns ?? {};
  const meter = (Memory.spawnMeter = Memory.spawnMeter ?? {});
  for (const name in spawns) {
    const s = spawns[name];
    let w = meter[s.id];
    if (!w || Game.time - w.t0 >= SPAWN_METER_WINDOW) {
      w = meter[s.id] = { t0: Game.time, last: -1, ticks: 0, busy: 0 };
    }
    if (w.last === Game.time) continue;
    w.last = Game.time;
    w.ticks++;
    const busyNow = !!s.spawning;
    if (busyNow) {
      w.busy++;
    } else {
      // IDLE-CAUSE tally (owner 2026-07-25): attribute every non-spawning
      // tick to the NOW-plan head - names where the steady-state idle goes
      // (no-demand vs energy-starved vs held vs latency) so "spawn capacity
      // but short on haulers" becomes a read, not a guess.
      const head = Memory.spawnAgenda?.[s.id]?.queue?.[0] as { precondition?: string; gate?: string } | undefined;
      switch (classifySpawnIdle(head)) {
        case "empty":
          w.idleEmpty = (w.idleEmpty ?? 0) + 1;
          break;
        case "bank":
          w.idleBank = (w.idleBank ?? 0) + 1;
          break;
        case "buy":
          w.idleBuy = (w.idleBuy ?? 0) + 1;
          break;
        case "hold":
          w.idleHold = (w.idleHold ?? 0) + 1;
          break;
      }
    }
    // BUILD-FINISH fill probe (owner 2026-07-21: refill must overlap the
    // build "or we have to measure and fix that"). A back-to-back restart
    // keeps spawning true and never registers here - every counted finish
    // is a duty GAP, and its fill ratio names the cause: low = the refill
    // did NOT overlap the build (tender lag); high = affordable-but-idle
    // (agenda/decision latency).
    if (w.wasBusy && !busyNow) {
      w.finishes = (w.finishes ?? 0) + 1;
      const cap = s.room?.energyCapacityAvailable || 1;
      w.fillSum = (w.fillSum ?? 0) + (s.room?.energyAvailable ?? 0) / cap;
    }
    w.wasBusy = busyNow;
  }
}
