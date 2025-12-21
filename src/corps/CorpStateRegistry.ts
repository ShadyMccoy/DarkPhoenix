/**
 * @fileoverview Registry for resolving corp state dependencies.
 *
 * The CorpStateRegistry provides:
 * - Fast lookup of corp states by ID
 * - Dependency resolution for operations
 * - Validation of dependency integrity
 *
 * Usage:
 * ```
 * const registry = new CorpStateRegistry(corpStates);
 * const source = registry.get<SourceCorpState>(miningState.sourceCorpId);
 * ```
 */

import {
  AnyCorpState,
  SourceCorpState,
  MiningCorpState,
  SpawningCorpState,
  UpgradingCorpState,
  HaulingCorpState
} from "./CorpState";

/**
 * Registry for looking up corp states by ID.
 */
export class CorpStateRegistry {
  private readonly stateById: Map<string, AnyCorpState>;

  constructor(states: AnyCorpState[] = []) {
    this.stateById = new Map();
    for (const state of states) {
      this.stateById.set(state.id, state);
    }
  }

  /**
   * Get a corp state by ID with type checking.
   * @throws Error if not found
   */
  get<T extends AnyCorpState>(id: string): T {
    const state = this.stateById.get(id);
    if (!state) {
      throw new Error(`Corp state not found: ${id}`);
    }
    return state as T;
  }

  /**
   * Get a corp state by ID, returning undefined if not found.
   */
  tryGet<T extends AnyCorpState>(id: string): T | undefined {
    return this.stateById.get(id) as T | undefined;
  }

  /**
   * Check if a corp state exists.
   */
  has(id: string): boolean {
    return this.stateById.has(id);
  }

  /**
   * Register a new corp state.
   */
  register(state: AnyCorpState): void {
    this.stateById.set(state.id, state);
  }

  /**
   * Get all registered states.
   */
  getAll(): AnyCorpState[] {
    return Array.from(this.stateById.values());
  }

  /**
   * Get states by type.
   */
  getByType<T extends AnyCorpState>(type: T["type"]): T[] {
    return this.getAll().filter(s => s.type === type) as T[];
  }

  /**
   * Get the source corp for a mining operation.
   */
  getSourceForMining(miningState: MiningCorpState): SourceCorpState {
    return this.get<SourceCorpState>(miningState.sourceCorpId);
  }

  /**
   * Get the spawning corp for an operation.
   */
  getSpawning(corpId: string): SpawningCorpState {
    return this.get<SpawningCorpState>(corpId);
  }

  /**
   * Get the mining corp for a hauling operation.
   */
  getMiningForHauling(haulingState: HaulingCorpState): MiningCorpState {
    return this.get<MiningCorpState>(haulingState.miningCorpId);
  }

  /**
   * Validate that all dependencies are satisfied.
   * Returns a list of missing dependencies.
   */
  validateDependencies(): string[] {
    const missing: string[] = [];

    for (const state of this.getAll()) {
      switch (state.type) {
        case "mining": {
          const mining = state as MiningCorpState;
          if (!this.has(mining.sourceCorpId)) {
            missing.push(`Mining ${mining.id} missing source: ${mining.sourceCorpId}`);
          }
          if (!this.has(mining.spawningCorpId)) {
            missing.push(`Mining ${mining.id} missing spawning: ${mining.spawningCorpId}`);
          }
          break;
        }
        case "hauling": {
          const hauling = state as HaulingCorpState;
          if (!this.has(hauling.miningCorpId)) {
            missing.push(`Hauling ${hauling.id} missing mining: ${hauling.miningCorpId}`);
          }
          if (!this.has(hauling.spawningCorpId)) {
            missing.push(`Hauling ${hauling.id} missing spawning: ${hauling.spawningCorpId}`);
          }
          break;
        }
        case "upgrading": {
          const upgrading = state as UpgradingCorpState;
          if (!this.has(upgrading.spawningCorpId)) {
            missing.push(`Upgrading ${upgrading.id} missing spawning: ${upgrading.spawningCorpId}`);
          }
          break;
        }
        // source, spawning have no dependencies
      }
    }

    return missing;
  }

  /**
   * Check if all dependencies are satisfied.
   */
  isValid(): boolean {
    return this.validateDependencies().length === 0;
  }

  /**
   * Get the number of registered states.
   */
  get size(): number {
    return this.stateById.size;
  }

  /**
   * Clear all registered states.
   */
  clear(): void {
    this.stateById.clear();
  }
}

/**
 * Create a registry from a list of corp states.
 */
export function createCorpStateRegistry(states: AnyCorpState[]): CorpStateRegistry {
  return new CorpStateRegistry(states);
}
