/**
 * @fileoverview Corps module exports.
 *
 * Corps are the execution units that actually control creeps in the game.
 *
 * @module corps
 */

// Shared constants
export * from "./CorpConstants";

export { Corp, CorpType, SerializedCorp, calculateROI } from "./Corp";

export { BootstrapCorp, SerializedBootstrapCorp, createBootstrapCorp } from "./BootstrapCorp";

export { HarvestCorp, SerializedHarvestCorp, createHarvestCorp } from "./HarvestCorp";

export { CarryCorp, SerializedCarryCorp, createCarryCorp } from "./CarryCorp";

export { UpgradingCorp, SerializedUpgradingCorp, createUpgradingCorp } from "./UpgradingCorp";

export { ScoutCorp, SerializedScoutCorp, createScoutCorp } from "./ScoutCorp";

export { ConstructionCorp, SerializedConstructionCorp, createConstructionCorp } from "./ConstructionCorp";

export { ReservationCorp, SerializedReservationCorp, createReservationCorp } from "./ReservationCorp";

export {
  ExtensionTenderCorp,
  SerializedExtensionTenderCorp,
  createExtensionTenderCorp
} from "./ExtensionTenderCorp";

export {
  SpawningCorp,
  SerializedSpawningCorp,
  SpawnOrder,
  SpawnableCreepType,
  createSpawningCorp
} from "./SpawningCorp";
