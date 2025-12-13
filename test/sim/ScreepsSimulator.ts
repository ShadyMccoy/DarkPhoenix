/**
 * Screeps Simulator - HTTP API client for headless testing
 *
 * Connects to a running Screeps private server and provides
 * a programmatic interface for running simulations and tests.
 */

interface ServerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

interface RoomObject {
  _id: string;
  type: string;
  x: number;
  y: number;
  room: string;
  [key: string]: unknown;
}

interface GameState {
  tick: number;
  rooms: Record<string, RoomObject[]>;
  memory: Record<string, unknown>;
}

interface ConsoleResult {
  ok: number;
  result?: string;
  error?: string;
}

export class ScreepsSimulator {
  private baseUrl: string;
  private token: string | null = null;
  private username: string;

  constructor(config: Partial<ServerConfig> = {}) {
    const host = config.host || 'localhost';
    const port = config.port || 21025;
    this.baseUrl = `http://${host}:${port}`;
    this.username = config.username || 'testuser';
  }

  /**
   * Initialize connection to the server
   */
  async connect(): Promise<void> {
    // Check server is up
    const version = await this.get('/api/version');
    console.log(`Connected to Screeps server v${version.serverData?.version || 'unknown'}`);
  }

  /**
   * Authenticate with the server (for screepsmod-auth)
   */
  async authenticate(username: string, password: string): Promise<void> {
    this.username = username;
    const result = await this.post('/api/auth/signin', {
      email: username,
      password: password,
    });
    this.token = result.token;
    console.log(`Authenticated as ${username}`);
  }

  /**
   * Register a new user (for testing)
   */
  async registerUser(username: string, password: string): Promise<void> {
    await this.post('/api/register/submit', {
      username,
      password,
      email: `${username}@test.local`,
    });
    console.log(`Registered user: ${username}`);
  }

  /**
   * Get current game tick
   */
  async getTick(): Promise<number> {
    const result = await this.get('/api/game/time');
    return result.time;
  }

  /**
   * Get room terrain
   */
  async getTerrain(room: string): Promise<string> {
    const result = await this.get(`/api/game/room-terrain?room=${room}`);
    return result.terrain?.[0]?.terrain || '';
  }

  /**
   * Get room objects (creeps, structures, etc.)
   */
  async getRoomObjects(room: string): Promise<RoomObject[]> {
    const result = await this.get(`/api/game/room-objects?room=${room}`);
    return result.objects || [];
  }

  /**
   * Get player memory
   */
  async getMemory(path?: string): Promise<unknown> {
    const url = path
      ? `/api/user/memory?path=${encodeURIComponent(path)}`
      : '/api/user/memory';
    const result = await this.get(url);

    if (result.data) {
      // Memory is gzipped and base64 encoded
      const decoded = Buffer.from(result.data.substring(3), 'base64');
      return JSON.parse(decoded.toString());
    }
    return {};
  }

  /**
   * Set player memory
   */
  async setMemory(path: string, value: unknown): Promise<void> {
    await this.post('/api/user/memory', {
      path,
      value: JSON.stringify(value),
    });
  }

  /**
   * Execute console command
   */
  async console(expression: string): Promise<ConsoleResult> {
    return await this.post('/api/user/console', { expression });
  }

  /**
   * Upload code modules to the server
   */
  async uploadCode(modules: Record<string, string>, branch = 'default'): Promise<void> {
    await this.post('/api/user/code', { branch, modules });
    console.log(`Uploaded code to branch: ${branch}`);
  }

  /**
   * Get player stats
   */
  async getStats(): Promise<Record<string, unknown>> {
    return await this.get('/api/user/stats');
  }

  /**
   * Spawn a bot in a room (requires screepsmod-admin-utils)
   */
  async spawnBot(botType: string, room: string): Promise<void> {
    await this.console(`bots.spawn('${botType}', '${room}')`);
    console.log(`Spawned ${botType} in ${room}`);
  }

  /**
   * Wait for specified number of ticks
   */
  async waitTicks(count: number, pollInterval = 100): Promise<number> {
    const startTick = await this.getTick();
    const targetTick = startTick + count;

    while ((await this.getTick()) < targetTick) {
      await this.sleep(pollInterval);
    }

    return await this.getTick();
  }

  /**
   * Run simulation and collect state snapshots
   */
  async runSimulation(
    ticks: number,
    options: {
      snapshotInterval?: number;
      rooms?: string[];
      onTick?: (tick: number, state: GameState) => void | Promise<void>;
    } = {}
  ): Promise<GameState[]> {
    const { snapshotInterval = 10, rooms = ['W0N0'], onTick } = options;
    const snapshots: GameState[] = [];
    const startTick = await this.getTick();

    for (let i = 0; i < ticks; i++) {
      const currentTick = await this.waitTicks(1);

      if ((currentTick - startTick) % snapshotInterval === 0 || i === ticks - 1) {
        const state = await this.captureState(rooms);
        snapshots.push(state);

        if (onTick) {
          await onTick(currentTick, state);
        }
      }
    }

    return snapshots;
  }

  /**
   * Capture current game state
   */
  async captureState(rooms: string[]): Promise<GameState> {
    const tick = await this.getTick();
    const roomStates: Record<string, RoomObject[]> = {};

    for (const room of rooms) {
      roomStates[room] = await this.getRoomObjects(room);
    }

    const memory = await this.getMemory();

    return {
      tick,
      rooms: roomStates,
      memory: memory as Record<string, unknown>,
    };
  }

  /**
   * Count objects of a specific type in a room
   */
  async countObjects(room: string, type: string): Promise<number> {
    const objects = await this.getRoomObjects(room);
    return objects.filter((o) => o.type === type).length;
  }

  /**
   * Find objects matching criteria
   */
  async findObjects(
    room: string,
    predicate: (obj: RoomObject) => boolean
  ): Promise<RoomObject[]> {
    const objects = await this.getRoomObjects(room);
    return objects.filter(predicate);
  }

  // HTTP helpers
  private async get(path: string): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['X-Token'] = this.token;
      headers['X-Username'] = this.username;
    }

    const response = await fetch(`${this.baseUrl}${path}`, { headers });
    return response.json() as Promise<Record<string, unknown>>;
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.token) {
      headers['X-Token'] = this.token;
      headers['X-Username'] = this.username;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    return response.json() as Promise<Record<string, unknown>>;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Convenience factory
export function createSimulator(config?: Partial<ServerConfig>): ScreepsSimulator {
  return new ScreepsSimulator(config);
}
