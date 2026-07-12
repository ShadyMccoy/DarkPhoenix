/**
 * The extension refill SLA (owner directive 2026-07-10): "refilling extensions
 * should finish before the creep that drained them finishes spawning."
 *
 * A spawn drains the bank the tick spawnCreep succeeds and takes 3 ticks per
 * body part to build the creep - that build time IS the refill deadline. Which
 * reduces to one clean invariant, checkable every tick with no bookkeeping:
 *
 *     an ARMED bank may only be short while a creep is actively building.
 *
 * The moment nothing is spawning and the bank is still short - the draining
 * creep finished, or the drain never even had a builder - the apparatus has
 * missed its deadline. Back-to-back spawns chain the deadline to the newest
 * build, which matches the directive (each drain's deadline is its own
 * creep's completion).
 *
 * The check is HORIZONTAL: one factory, attachable to any cell - staged
 * scenarios and long organic sims alike - so every extension-bearing world
 * enforces the same contract.
 *
 * Semantics:
 *  - ARMED only after the extension bank first reaches full (a ramping colony
 *    that has never filled its bank is an income story, not a refill story).
 *  - FUEL-GATED: a shortfall only violates if, at some point during it, the
 *    room held enough drawable energy (piles + containers + storage + spawn
 *    store + loads on creeps) to cover the deficit - the SLA binds the refill
 *    apparatus, not the income it moves. A fuel-starved shortfall resolves
 *    without violation and the SLA re-arms on the next full bank.
 */

import { CellAssertion, CellSample } from "./GridCell";

const extFree = (o: any): number => Math.max(0, (o.storeCapacityResource?.energy ?? 50) - (o.store?.energy ?? 0));

/**
 * NEAR fuel: drawable energy within reach of the bank. A 3t/part deadline
 * cannot be met from a source container 15 tiles out - counting far fuel
 * turned thin-income churn moments into false apparatus failures (measured,
 * remote-pipeline t=566: 598 total fuel, every unit at the far source).
 */
const NEAR_FUEL_RANGE = 10;

function roomFuel(objects: any[], userId: string, creepMemory: Record<string, any> = {}): number {
  const spawns = objects.filter((o) => o.type === "spawn" && o.user === userId);
  if (spawns.length === 0) return 0;
  const near = (o: any): boolean =>
    spawns.some((sp) => Math.max(Math.abs(sp.x - o.x), Math.abs(sp.y - o.y)) <= NEAR_FUEL_RANGE);
  let fuel = 0;
  for (const o of objects) {
    if (!near(o)) continue;
    if (o.type === "energy") fuel += o.energy ?? o.amount ?? 0;
    else if (o.type === "container" || o.type === "storage" || o.type === "spawn") fuel += o.store?.energy ?? 0;
    else if (o.type === "creep") {
      // Loads already in transit count - EXCEPT a construction corp's
      // dedicated site shuttles: their cargo is committed to a build site
      // and the refill apparatus can never draw it (measured, pipeline
      // t=1142: nearly all of the 371 "near fuel" rode on tanker-uction
      // creeps while one extension sat 50 short - unservable in fact).
      const corpId = String(creepMemory[o.name]?.corpId ?? "");
      if (corpId.startsWith("construction-")) continue;
      fuel += o.store?.energy ?? 0;
    }
  }
  return fuel;
}

/**
 * Build the SLA assertion for one cell. `handle` picks the room (default
 * "home"); `graceTicks` delays enforcement past staging warm-up.
 */
export function makeRefillSla(handle?: string, graceTicks = 0): CellAssertion {
  let armed = false;
  let fuelSeen = false;

  return {
    name: `extensions refill before the draining spawn finishes${handle ? ` (${handle})` : ""}`,
    mode: "always",
    graceTicks,
    check: (s: CellSample): boolean => {
      const objects = s.objects(handle);
      const exts = objects.filter((o) => o.type === "extension" && o.user === s.userId);
      if (exts.length === 0) return true;

      const deficit = exts.reduce((sum, o) => sum + extFree(o), 0);
      if (deficit === 0) {
        // Arm only once the colony HAS a refill apparatus (a live tender):
        // the SLA binds the apparatus, and the drain that BUILDS the first
        // tender cannot be serviced by it (measured: a 17-energy dribble
        // missed the deadline exactly while the tender was in the spawn).
        // Once armed, a later tender death does NOT disarm - death gaps are
        // the apparatus's own delivery contract to cover.
        if (!armed) {
          // workType "tank" is shared with construction tankers - only the
          // tender corp's creep is the refill apparatus.
          const tenderAlive = Object.values(s.memory?.creeps ?? {}).some(
            (m: any) => m?.workType === "tank" && String(m?.corpId ?? "").includes("tender")
          );
          if (tenderAlive) armed = true;
        }
        fuelSeen = false;
        return true;
      }
      if (!armed) return true; // still ramping toward apparatus + first full bank

      const building = objects.some((o) => o.type === "spawn" && o.user === s.userId && o.spawning);
      if (building) return true; // the drain's creep is still building - deadline open

      // Fuel is judged AT the due moment, not latched from earlier in the
      // shortfall: successive drains legitimately deepen the deficit past
      // what was once coverable, and that is an income story (measured,
      // pipeline t=778: nearFuel 184 vs deficit 360 at the deadline after an
      // early sample latched fuelSeen on a shallower deficit).
      if (roomFuel(objects, s.userId, s.memory?.creeps ?? {}) >= deficit) fuelSeen = true;
      else fuelSeen = false;

      if (fuelSeen) {
        const tenders = objects
          .filter((o) => o.type === "creep" && s.memory?.creeps?.[o.name]?.workType === "tank")
          .map((o) => `${o.name}@${o.x},${o.y}:${o.store?.energy ?? 0}`);
        const emptyExts = exts.filter((o) => extFree(o) > 0).map((o) => `(${o.x},${o.y}):${extFree(o)}`);
        console.log(
          `  [refill-sla] VIOLATION t=${s.tick} deficit=${deficit} nearFuel=${roomFuel(objects, s.userId, s.memory?.creeps ?? {})} ` +
            `tanks=${tenders.join(" ")} short=${emptyExts.join(" ")}`
        );
        return false;
      }
      // Fuel never covered the deficit: an income shortfall, not a refill
      // failure. Disarm until the bank recovers on its own.
      armed = false;
      return true;
    },
  };
}
