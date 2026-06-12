/**
 * free-economy mod - remove the build and upgrade energy sinks in a sim.
 *
 * The in-process Screeps engine reads its MODFILE (here, the server's db.json)
 * through @screeps/common's config-manager, which calls each listed mod with the
 * live `config` object. Zeroing the construction cost and shrinking the
 * controller level thresholds means a colony is never bottlenecked by building
 * or upgrading, so it reaches a steady, energy-rich state in far fewer ticks -
 * letting us run much more game-time per real second to study corp economics
 * (budget vs actual) instead of waiting out a slow, energy-starved bootstrap.
 *
 * CommonJS on purpose: config-manager `require()`s it.
 */
module.exports = function freeEconomy(config) {
  const C = config.common.constants;

  // Building is (almost) free: cost 1, NOT 0 - the engine rejects
  // createConstructionSite for any structure whose CONSTRUCTION_COST is falsy
  // (ERR_INVALID_ARGS), so a literal 0 makes building impossible rather than
  // free. At cost 1 a single builder hit completes any site.
  if (C.CONSTRUCTION_COST) {
    for (const key of Object.keys(C.CONSTRUCTION_COST)) {
      C.CONSTRUCTION_COST[key] = 1;
    }
  }

  // Controller levels climb almost for free: a tiny, flat progress per level so
  // upgrading drains a negligible amount of energy.
  if (C.CONTROLLER_LEVELS) {
    for (const key of Object.keys(C.CONTROLLER_LEVELS)) {
      if (C.CONTROLLER_LEVELS[key]) C.CONTROLLER_LEVELS[key] = 100;
    }
  }
};
