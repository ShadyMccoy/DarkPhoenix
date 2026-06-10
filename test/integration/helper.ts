/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync, readFileSync } from "fs";
import * as path from "path";
// screeps-server-mockup ships no type definitions, so require it directly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ScreepsServer, stdHooks } = require("screeps-server-mockup");

const DIST_MAIN_JS = "dist/main.js";

// Each server binds a storage port. server.stop() does not release the port
// synchronously, so consecutive tests reusing the default port hit EADDRINUSE.
// Hand out a fresh port (and working directory) per server instance.
let nextPort = 21025;

export interface AddBotOptions {
  username?: string;
  room: string;
  x: number;
  y: number;
  gcl?: number;
  cpu?: number;
  spawnName?: string;
}

/**
 * Helper for creating and tearing down a screeps-server-mockup server.
 *
 * Each test gets a fresh in-process Screeps engine. `beforeEach()` with no
 * argument reproduces the legacy behaviour: a stubbed 3x3 world with a "player"
 * bot running the compiled `dist/main.js`. Pass a `buildWorld` callback to
 * construct a custom world instead (see `loadLayout`).
 *
 * See https://github.com/screepers/screeps-server-mockup for the world API.
 */
export class IntegrationTestHelper {
  private _server: any;
  private _player: any;
  private _serverPath = "";

  get server() {
    return this._server;
  }

  get player() {
    return this._player;
  }

  /**
   * Filesystem path of the current server instance. The engine reads its
   * `db.json` here as its MODFILE, so tests that want to load engine mods (e.g.
   * the free-economy mod) call `enableMods(helper.serverPath, [...])` from
   * inside the `buildWorld` callback - after the world is built (db.json exists)
   * and before the server starts.
   */
  get serverPath() {
    return this._serverPath;
  }

  /**
   * Stand up a fresh server. If `buildWorld` is provided it is responsible for
   * the world contents (terrain, objects, bots) and the default stub world is
   * skipped. Bots must be added before the server starts, so call
   * `helper.addBot(...)` from inside `buildWorld`.
   */
  async beforeEach(buildWorld?: (world: any) => Promise<void>): Promise<void> {
    const port = nextPort;
    nextPort += 1;
    const serverPath = path.resolve("server", String(port));
    this._serverPath = serverPath;
    const logdir = path.join(serverPath, "logs");
    // The mockup's own mkdir is non-recursive, so ensure the tree exists first.
    mkdirSync(logdir, { recursive: true });
    this._server = new ScreepsServer({ port, path: serverPath, logdir });
    this._player = undefined;

    // reset world but add invaders and source keepers bots
    await this._server.world.reset();

    if (buildWorld) {
      await buildWorld(this._server.world);
    } else {
      // create a stub world composed of 9 rooms with sources and controllers
      await this._server.world.stubWorld();
      this._player = await this.addBot({ username: "player", room: "W0N1", x: 15, y: 15 });
    }

    await this._server.start();
  }

  /**
   * Add a bot running the compiled `dist/main.js`. The target room must already
   * contain a controller. Call this before the server starts (i.e. from within
   * the `beforeEach` `buildWorld` callback). Returns the player emitter and also
   * stores it on `helper.player`.
   */
  async addBot(opts: AddBotOptions): Promise<any> {
    const modules = { main: readFileSync(DIST_MAIN_JS).toString() };
    this._player = await this._server.world.addBot({ ...opts, modules });
    return this._player;
  }

  async afterEach(): Promise<void> {
    if (this._server) {
      await this._server.stop();
    }
  }
}

let consoleHooked = false;

/**
 * Suppress the bot's console output during a test run. Idempotent; call once
 * from a `before` hook in each integration test file.
 */
export function hookConsole(): void {
  if (consoleHooked) {
    return;
  }
  stdHooks.hookWrite();
  consoleHooked = true;
}

export const helper = new IntegrationTestHelper();
