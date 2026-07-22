/**
 * @fileoverview Body-shape vocabulary retained from the retired EdgeVariant
 * optimization layer (spec 17 P5 shrank this file to the two types the spawn
 * path actually consumes; the variant search itself was never populated and
 * was deleted - see ONTOLOGY §10).
 *
 * @module framework/EdgeVariant
 */

/** Hauler CARRY:MOVE body ratio (road 2:1, plains 1:1, swamp 1:2). */
export type HaulerRatio = "2:1" | "1:1" | "1:2";

/** Miner harvesting mode (affects CARRY on the mining body). */
export type MiningMode = "drop" | "container" | "link";
