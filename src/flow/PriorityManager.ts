/**
 * PriorityManager - Dynamic Sink Priority Calculation
 *
 * Calculates sink priorities based on current game state.
 * Handles transitions like RCL-up, defense mode, low storage, etc.
 *
 * Priority values range from 0-100:
 * - 100: Critical (spawn overhead)
 * - 80-99: High (defense, urgent building)
 * - 60-79: Normal (upgrading, extensions)
 * - 40-59: Low (storage buffer)
 * - 0-39: Minimal (luxury, excess)
 */

import {
  SinkType,
  PriorityContext,
  DEFAULT_SINK_PRIORITIES,
  FlowSink,
} from "./FlowTypes";

// =============================================================================
// PRIORITY RULES
// =============================================================================

/**
 * Priority rule definition.
 * Rules are evaluated in order and the first matching rule wins.
 */
interface PriorityRule {
  /** Rule name for debugging */
  name: string;

  /** Sink types this rule applies to */
  sinkTypes: SinkType[];

  /** Condition function - returns true if rule applies */
  condition: (context: PriorityContext, sink?: FlowSink) => boolean;

  /** Priority value when rule matches */
  priority: number;
}

/**
 * Default priority rules.
 * Evaluated in order - first matching rule wins.
 */
const PRIORITY_RULES: PriorityRule[] = [
  // === CRITICAL RULES (100) ===
  {
    name: "spawn-always-critical",
    sinkTypes: ["spawn"],
    condition: () => true,
    priority: 100,
  },

  // === DEFENSE RULES (95-99) ===
  {
    name: "tower-under-attack",
    sinkTypes: ["tower"],
    condition: (ctx) => ctx.underAttack || ctx.hostileCreeps > 0,
    priority: 98,
  },

  // === BUILD PHASE RULES (80-90) ===
  {
    name: "construction-after-rcl-up",
    sinkTypes: ["construction"],
    condition: (ctx) => ctx.constructionSites > 0 && ctx.ticksSinceRclUp < 5000,
    priority: 88,
  },
  {
    name: "construction-normal",
    sinkTypes: ["construction"],
    condition: (ctx) => ctx.constructionSites > 0,
    priority: 75,
  },

  // === SPAWN CAPACITY RULES (85-95) ===
  {
    name: "extension-spawn-starved",
    sinkTypes: ["extension"],
    condition: (ctx) =>
      ctx.spawnQueueSize > 0 &&
      ctx.extensionEnergy < ctx.extensionCapacity * 0.3,
    priority: 92,
  },
  {
    name: "extension-spawn-waiting",
    sinkTypes: ["extension"],
    condition: (ctx) =>
      ctx.spawnQueueSize > 0 &&
      ctx.extensionEnergy < ctx.extensionCapacity * 0.8,
    priority: 85,
  },

  // === CONTROLLER RULES (10-70) ===
  {
    name: "controller-building-pause",
    sinkTypes: ["controller"],
    condition: (ctx) => ctx.constructionSites > 0 && ctx.ticksSinceRclUp < 10000,
    priority: 12, // Just enough to prevent downgrade
  },
  {
    name: "controller-low-storage",
    sinkTypes: ["controller"],
    condition: (ctx) => ctx.storageEnergy < 10000,
    priority: 40,
  },
  {
    name: "controller-normal",
    sinkTypes: ["controller"],
    condition: () => true,
    priority: 65,
  },

  // === TOWER NORMAL (30-50) ===
  {
    name: "tower-low-energy",
    sinkTypes: ["tower"],
    condition: () => true, // Would check tower energy in real impl
    priority: 45,
  },
  {
    name: "tower-normal",
    sinkTypes: ["tower"],
    condition: () => true,
    priority: 30,
  },

  // === EXTENSION NORMAL (50-60) ===
  {
    name: "extension-normal",
    sinkTypes: ["extension"],
    condition: () => true,
    priority: 55,
  },

  // === LINK NETWORK (40-50) ===
  {
    name: "link-normal",
    sinkTypes: ["link"],
    condition: () => true,
    priority: 45,
  },

  // === TERMINAL (30-40) ===
  {
    name: "terminal-normal",
    sinkTypes: ["terminal"],
    condition: () => true,
    priority: 35,
  },

  // === STORAGE BUFFER (5-20) ===
  {
    name: "storage-low",
    sinkTypes: ["storage"],
    condition: (ctx) => ctx.storageEnergy < 50000,
    priority: 20,
  },
  {
    name: "storage-normal",
    sinkTypes: ["storage"],
    condition: () => true,
    priority: 8,
  },

  // === PRODUCTION (15-25) ===
  {
    name: "lab-normal",
    sinkTypes: ["lab"],
    condition: () => true,
    priority: 22,
  },
  {
    name: "factory-normal",
    sinkTypes: ["factory"],
    condition: () => true,
    priority: 18,
  },

  // === LUXURY (1-10) ===
  {
    name: "power-spawn-normal",
    sinkTypes: ["powerSpawn"],
    condition: () => true,
    priority: 8,
  },
  {
    name: "nuker-normal",
    sinkTypes: ["nuker"],
    condition: () => true,
    priority: 3,
  },
];

// =============================================================================
// PRIORITY MANAGER CLASS
// =============================================================================

/**
 * PriorityManager calculates dynamic priorities for sinks based on game state.
 *
 * Usage:
 * ```typescript
 * const manager = new PriorityManager();
 * const context = manager.buildContext(room);
 * const priorities = manager.calculatePriorities(context);
 * // or for a specific sink:
 * const priority = manager.getSinkPriority(sink, context);
 * ```
 */
export class PriorityManager {
  /** Custom rules (prepended to default rules) */
  private customRules: PriorityRule[];

  /** All active rules (custom + default) */
  private rules: PriorityRule[];

  constructor() {
    this.customRules = [];
    this.rules = [...PRIORITY_RULES];
  }

  /**
   * Add a custom priority rule.
   * Custom rules are evaluated before default rules.
   */
  addRule(rule: PriorityRule): void {
    this.customRules.push(rule);
    this.rules = [...this.customRules, ...PRIORITY_RULES];
  }

  /**
   * Clear all custom rules.
   */
  clearCustomRules(): void {
    this.customRules = [];
    this.rules = [...PRIORITY_RULES];
  }

  /**
   * Calculate priorities for all sink types.
   *
   * @param context - Current game state
   * @returns Map of sink type to priority
   */
  calculatePriorities(context: PriorityContext): Map<SinkType, number> {
    const priorities = new Map<SinkType, number>();

    // Get all sink types
    const sinkTypes: SinkType[] = [
      "spawn", "extension", "tower", "construction", "controller",
      "terminal", "link", "storage", "lab", "factory", "powerSpawn", "nuker"
    ];

    for (const type of sinkTypes) {
      const priority = this.getPriorityForType(type, context);
      priorities.set(type, priority);
    }

    return priorities;
  }

  /**
   * Get priority for a specific sink.
   *
   * @param sink - The sink to get priority for
   * @param context - Current game state
   * @returns Priority value (0-100)
   */
  getSinkPriority(sink: FlowSink, context: PriorityContext): number {
    // Find first matching rule
    for (const rule of this.rules) {
      if (rule.sinkTypes.includes(sink.type) && rule.condition(context, sink)) {
        return rule.priority;
      }
    }

    // Fall back to default
    return DEFAULT_SINK_PRIORITIES[sink.type];
  }

  /**
   * Get priority for a sink type (not a specific sink).
   */
  private getPriorityForType(type: SinkType, context: PriorityContext): number {
    // Find first matching rule for this type
    for (const rule of this.rules) {
      if (rule.sinkTypes.includes(type) && rule.condition(context)) {
        return rule.priority;
      }
    }

    // Fall back to default
    return DEFAULT_SINK_PRIORITIES[type];
  }

  /**
   * Build a priority context from a room.
   * This is a convenience method for real Screeps usage.
   *
   * @param room - The room to analyze
   * @returns PriorityContext
   */
  buildContext(room: Room): PriorityContext {
    const controller = room.controller;
    const storage = room.storage;
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    const spawns = room.find(FIND_MY_SPAWNS);

    // Calculate extension energy
    const extensions = room.find(FIND_MY_STRUCTURES, {
      filter: (s) => s.structureType === STRUCTURE_EXTENSION
    }) as StructureExtension[];

    let extensionEnergy = 0;
    let extensionCapacity = 0;
    for (const ext of extensions) {
      extensionEnergy += ext.store[RESOURCE_ENERGY];
      extensionCapacity += ext.store.getCapacity(RESOURCE_ENERGY);
    }

    // Calculate spawn queue size (simplified - would need access to spawn queue)
    let spawnQueueSize = 0;
    for (const spawn of spawns) {
      if (spawn.spawning) spawnQueueSize++;
    }

    // Estimate ticks since RCL up (would need memory tracking in real impl)
    const ticksSinceRclUp = 50000; // Default to "long ago"

    return {
      tick: Game.time,
      rcl: controller?.level ?? 0,
      rclProgress: controller
        ? controller.progress / controller.progressTotal
        : 0,
      constructionSites: sites.length,
      hostileCreeps: hostiles.length,
      storageEnergy: storage?.store[RESOURCE_ENERGY] ?? 0,
      spawnQueueSize,
      underAttack: hostiles.length > 0,
      ticksSinceRclUp,
      extensionEnergy,
      extensionCapacity,
    };
  }

  /**
   * Create a mock context for testing.
   */
  static createMockContext(overrides: Partial<PriorityContext> = {}): PriorityContext {
    return {
      tick: 0,
      rcl: 4,
      rclProgress: 0.5,
      constructionSites: 0,
      hostileCreeps: 0,
      storageEnergy: 100000,
      spawnQueueSize: 0,
      underAttack: false,
      ticksSinceRclUp: 50000,
      extensionEnergy: 1000,
      extensionCapacity: 1000,
      ...overrides,
    };
  }
}

// =============================================================================
// PRIORITY PRESETS
// =============================================================================

/**
 * Preset priority configurations for common scenarios.
 */
export const PRIORITY_PRESETS = {
  /**
   * Normal operation - balanced priorities.
   */
  normal: (): Map<SinkType, number> => {
    return new Map([
      ["spawn", 100],
      ["extension", 55],
      ["tower", 30],
      ["construction", 0],
      ["controller", 65],
      ["terminal", 35],
      ["link", 45],
      ["storage", 8],
      ["lab", 22],
      ["factory", 18],
      ["powerSpawn", 8],
      ["nuker", 3],
    ]);
  },

  /**
   * Build phase - prioritize construction over upgrading.
   */
  buildPhase: (): Map<SinkType, number> => {
    return new Map([
      ["spawn", 100],
      ["extension", 85],
      ["tower", 30],
      ["construction", 88],
      ["controller", 12],
      ["terminal", 20],
      ["link", 25],
      ["storage", 5],
      ["lab", 10],
      ["factory", 8],
      ["powerSpawn", 3],
      ["nuker", 1],
    ]);
  },

  /**
   * Defense mode - prioritize towers and spawn.
   */
  defense: (): Map<SinkType, number> => {
    return new Map([
      ["spawn", 100],
      ["extension", 95],
      ["tower", 98],
      ["construction", 20],
      ["controller", 10],
      ["terminal", 15],
      ["link", 30],
      ["storage", 5],
      ["lab", 5],
      ["factory", 5],
      ["powerSpawn", 3],
      ["nuker", 1],
    ]);
  },

  /**
   * Emergency - spawn and survival only.
   */
  emergency: (): Map<SinkType, number> => {
    return new Map([
      ["spawn", 100],
      ["extension", 98],
      ["tower", 95],
      ["construction", 0],
      ["controller", 5],
      ["terminal", 0],
      ["link", 0],
      ["storage", 0],
      ["lab", 0],
      ["factory", 0],
      ["powerSpawn", 0],
      ["nuker", 0],
    ]);
  },

  /**
   * Upgrade rush - maximize controller upgrading.
   */
  upgradeRush: (): Map<SinkType, number> => {
    return new Map([
      ["spawn", 100],
      ["extension", 50],
      ["tower", 25],
      ["construction", 30],
      ["controller", 90],
      ["terminal", 20],
      ["link", 40],
      ["storage", 10],
      ["lab", 15],
      ["factory", 10],
      ["powerSpawn", 5],
      ["nuker", 1],
    ]);
  },
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get a human-readable description of priority level.
 */
export function describePriority(priority: number): string {
  if (priority >= 95) return "Critical";
  if (priority >= 80) return "High";
  if (priority >= 60) return "Normal";
  if (priority >= 40) return "Low";
  if (priority >= 20) return "Minimal";
  return "Negligible";
}

/**
 * Compare two priority maps and describe the differences.
 */
export function comparePriorities(
  before: Map<SinkType, number>,
  after: Map<SinkType, number>
): string[] {
  const changes: string[] = [];

  for (const [type, afterPri] of after) {
    const beforePri = before.get(type) ?? 0;
    const diff = afterPri - beforePri;

    if (Math.abs(diff) >= 5) {
      const direction = diff > 0 ? "↑" : "↓";
      changes.push(`${type}: ${beforePri} → ${afterPri} (${direction}${Math.abs(diff)})`);
    }
  }

  return changes;
}
