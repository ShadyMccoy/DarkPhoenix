/**
 * @fileoverview Corps module exports.
 *
 * Corps are the execution units that actually control creeps in the game.
 *
 * @module corps
 */

// Shared constants
export * from "./CorpConstants";

export { Corp, CorpType, SerializedCorp } from "./Corp";

export { BootstrapCorp, SerializedBootstrapCorp, createBootstrapCorp } from "./BootstrapCorp";

export { HarvestCorp, SerializedHarvestCorp, createHarvestCorp } from "./HarvestCorp";

export { CarryCorp, SerializedCarryCorp, createCarryCorp } from "./CarryCorp";

export { UpgradingCorp, SerializedUpgradingCorp, createUpgradingCorp } from "./UpgradingCorp";

export { ScoutCorp, SerializedScoutCorp } from "./ScoutCorp";

export { ConstructionCorp, SerializedConstructionCorp, createConstructionCorp } from "./ConstructionCorp";

export { ReservationCorp, SerializedReservationCorp } from "./ReservationCorp";

export { ExtensionTenderCorp, SerializedExtensionTenderCorp } from "./ExtensionTenderCorp";

export {
  SpawningCorp,
  SerializedSpawningCorp,
  SpawnOrder,
  SpawnableCreepType,
  createSpawningCorp
} from "./SpawningCorp";
