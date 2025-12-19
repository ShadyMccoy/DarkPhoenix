/**
 * Screeps API client for reading RawMemory segments.
 *
 * Uses the official Screeps HTTP API to poll telemetry data.
 */

export interface ScreepsConfig {
  /** Auth token (from account settings) */
  token: string;
  /** Shard to read from */
  shard: string;
  /** API base URL (default: https://screeps.com/api) */
  apiUrl?: string;
}

export interface SegmentResponse {
  ok: number;
  data: string;
}

export interface MemorySegmentData {
  [segment: number]: string | null;
}

/**
 * Screeps API client for reading memory segments.
 */
export class ScreepsAPI {
  private config: ScreepsConfig;
  private baseUrl: string;

  constructor(config: ScreepsConfig) {
    this.config = config;
    this.baseUrl = config.apiUrl || "https://screeps.com/api";
  }

  /**
   * Read a memory segment.
   */
  async readSegment(segment: number): Promise<string | null> {
    const url = `${this.baseUrl}/user/memory-segment?segment=${segment}&shard=${this.config.shard}`;

    try {
      const response = await fetch(url, {
        headers: {
          "X-Token": this.config.token,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        console.error(`API error: ${response.status} ${response.statusText}`);
        return null;
      }

      const data = (await response.json()) as SegmentResponse;

      if (data.ok !== 1) {
        console.error("Segment read failed:", data);
        return null;
      }

      return data.data || null;
    } catch (error) {
      console.error("Failed to read segment:", error);
      return null;
    }
  }

  /**
   * Read multiple memory segments.
   */
  async readSegments(segments: number[]): Promise<MemorySegmentData> {
    const results: MemorySegmentData = {};

    // Read segments in parallel
    const promises = segments.map(async (segment) => {
      const data = await this.readSegment(segment);
      results[segment] = data;
    });

    await Promise.all(promises);
    return results;
  }

  /**
   * Get server time (to check connectivity).
   */
  async getTime(): Promise<number | null> {
    const url = `${this.baseUrl}/game/time?shard=${this.config.shard}`;

    try {
      const response = await fetch(url, {
        headers: {
          "X-Token": this.config.token,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as { ok: number; time: number };
      return data.ok === 1 ? data.time : null;
    } catch (error) {
      console.error("Failed to get time:", error);
      return null;
    }
  }

  /**
   * Test connection and authentication.
   */
  async testConnection(): Promise<boolean> {
    const time = await this.getTime();
    return time !== null;
  }
}
