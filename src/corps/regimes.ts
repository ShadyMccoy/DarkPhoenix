/**
 * @fileoverview regimes - the neutral home for the cross-kind REGIME-flag
 * lenses (spec 35 phase D; audit finding corps-heavy/4).
 *
 * The RoomMemory regime flags (`extensionTenderCovered`/
 * `extensionTenderActive`, `controllerFeederActive`,
 * `dedicatedBuildSourceId`) are ONTOLOGY §9's declared coupling debt: mover
 * kinds signal their room coverage through room memory and
 * CarryCorp/UpgradingCorp branch on it. This module gives the LENS side one
 * neutral home - previously `tenderOwnsExtensions` (the tender regime's
 * definition) lived inside CarryCorp, the regime's biggest READER, so the
 * tender kind depended on the hauler kind's file for its own regime. The
 * flags themselves, their liveness-keyed semantics, and every write value
 * are UNCHANGED here - the structural-regime upgrade (feeder-COVERED from
 * structures) is spec 35 phase E's own gated change and lands with the
 * integration trio + grid, not in this move.
 *
 * Writers stamp through the documented setters below so the write sites sit
 * beside the lens that interprets them.
 *
 * @module corps/regimes
 */

/**
 * Do extensions belong to the tender corp in this room? The ONE lens every
 * hauler fan-fill site reads (owner 2026-07-22 accountability ruling: "each
 * corp needs to do their job, not cover for each other"). COVERED is the
 * STRUCTURAL flag (depot + extensions exist, stamped by
 * ExtensionTenderCorp.work) - it does NOT flap with tender deaths, so a dead
 * tender no longer hands extension duty back to the haulers; the tender
 * corp's own bootstrap demand (value 150) re-fields one instead. Haulers keep
 * the SPAWN STRUCTURE topped in every regime, so a tender gap can never
 * deadlock the colony. ACTIVE is OR-ed in only for rooms whose stamp predates
 * the covered flag (a deploy-boundary nicety, not a doctrine).
 */
export function tenderOwnsExtensions(
  mem?: { extensionTenderCovered?: boolean; extensionTenderActive?: boolean }
): boolean {
  return mem?.extensionTenderCovered === true || mem?.extensionTenderActive === true;
}

/**
 * ExtensionTenderCorp.work()'s regime stamp - the ONE writer of the tender
 * flags. COVERED is STRUCTURAL (depot + extensions exist; does not flap with
 * tender deaths); ACTIVE tracks liveness for telemetry and the depot-reserve
 * buffer nuances. The booleans are computed at the call site (they read live
 * room structures); this setter only keeps the write beside the lens that
 * interprets it.
 */
export function stampTenderRegime(
  mem: { extensionTenderCovered?: boolean; extensionTenderActive?: boolean },
  covered: boolean,
  active: boolean
): void {
  mem.extensionTenderCovered = covered;
  mem.extensionTenderActive = active;
}

/**
 * LinkCorp.work()'s regime stamp - the ONE writer of
 * `controllerFeederActive`. Deliberately LIVENESS-keyed (storage exists AND a
 * feeder is alive): if the feeder dies the flag clears and haulers resume
 * delivering to the controller directly, so a dead feeder never starves
 * upgrading - today the flap IS the fallback. This is the flapping-signal
 * class ONTOLOGY §9 flags; the structural upgrade (feeder-COVERED from
 * structures) is phase E's own gated change, and its lens will live here
 * when it lands.
 */
export function stampControllerFeederRegime(mem: { controllerFeederActive?: boolean }, active: boolean): void {
  mem.controllerFeederActive = active;
}
