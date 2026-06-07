/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Scenario - a named, reusable, loadable world for economy iteration.
 *
 * A Scenario bundles everything needed to stand a colony up in the mock server:
 * the room terrain + objects (from {@link RoomBuilder}), where the bot spawns,
 * and an optional captured `state` (controller progress, built structures,
 * memory) so a snapshot can be replayed without re-running the slow bootstrap.
 *
 * Build one by hand, pull one from the library, or capture one from a running
 * server with {@link exportSnapshot}.
 */

import { loadLayout, padNeighborTerrain } from "../loadLayout";
import { ScenarioRoom } from "./RoomBuilder";

/** Dynamic state captured from (or injected into) a running world. */
export interface ScenarioState {
  /** Controller level + progress to start from (skips the climb to that RCL). */
  controller?: { level: number; progress?: number; downgradeTime?: number | null };
  /** Already-built structures (e.g. extensions) with optional stored energy. */
  structures?: Array<{
    room: string;
    type: string;
    x: number;
    y: number;
    energy?: number;
  }>;
  /** Raw bot Memory to inject (so corps/flow state replays). */
  memory?: unknown;
}

export interface Scenario {
  name: string;
  description?: string;
  rooms: ScenarioRoom[];
  /** Where the bot's first spawn is placed (addBot also claims the controller). */
  bot: { room: string; x: number; y: number; username?: string };
  /** Optional captured state to inject after the bot is added. */
  state?: ScenarioState;
}

/** Handle returned by {@link loadScenario} for driving/inspecting the run. */
export interface LoadedScenario {
  bot: any;
  scenario: Scenario;
}

/**
 * Load a scenario into a fresh (already-reset) mock server: rooms + neighbour
 * padding + bot, then inject any captured state. Returns the bot handle.
 */
export async function loadScenario(
  server: any,
  scenario: Scenario,
  mainModule: string
): Promise<LoadedScenario> {
  await loadLayout(server.world, scenario.rooms);
  await padNeighborTerrain(server.world, scenario.rooms.map((r) => r.room));

  const bot = await server.world.addBot({
    username: scenario.bot.username ?? "player",
    room: scenario.bot.room,
    x: scenario.bot.x,
    y: scenario.bot.y,
    modules: { main: mainModule },
  });

  if (scenario.state) {
    await applyState(server, scenario.bot.room, scenario.state, bot);
  }

  return { bot, scenario };
}

/** Inject a captured ScenarioState into a loaded world. */
async function applyState(
  server: any,
  room: string,
  state: ScenarioState,
  bot: any
): Promise<void> {
  const { db } = await server.world.load();

  if (state.controller) {
    await db["rooms.objects"].update(
      { room, type: "controller" },
      {
        $set: {
          level: state.controller.level,
          progress: state.controller.progress ?? 0,
          downgradeTime: state.controller.downgradeTime ?? null,
          safeMode: null,
        },
      }
    );
  }

  for (const s of state.structures ?? []) {
    const attrs: any = {};
    if (s.energy != null) {
      attrs.store = { energy: s.energy };
      attrs.storeCapacityResource = { energy: structureCapacity(s.type) };
    }
    await server.world.addRoomObject(s.room, s.type, s.x, s.y, attrs);
  }

  if (state.memory !== undefined) {
    const { env } = server.common.storage;
    await env.set(env.keys.MEMORY + bot.id, JSON.stringify(state.memory));
  }
}

/** Energy capacity for common structures (RCL-independent approximations). */
function structureCapacity(type: string): number {
  switch (type) {
    case "extension":
      return 50;
    case "container":
      return 2000;
    case "storage":
      return 1000000;
    case "tower":
      return 1000;
    default:
      return 0;
  }
}
