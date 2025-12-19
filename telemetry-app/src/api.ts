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
   * Read a memory segment with retry logic for rate limiting.
   */
  async readSegment(segment: number, retries = 3): Promise<string | null> {
    const url = `${this.baseUrl}/user/memory-segment?segment=${segment}&shard=${this.config.shard}`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            "X-Token": this.config.token,
            "Content-Type": "application/json",
          },
        });

        if (response.status === 429) {
          // Rate limited - wait with exponential backoff
          const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
          if (attempt < retries) {
            console.log(`  Rate limited on segment ${segment}, retrying in ${waitTime}ms...`);
            await this.delay(waitTime);
            continue;
          }
          console.error(`  Rate limited on segment ${segment}, max retries exceeded`);
          return null;
        }

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
    return null;
  }

  /**
   * Read multiple memory segments.
   * Reads sequentially with delay to avoid rate limiting.
   */
  async readSegments(segments: number[], delayMs = 250): Promise<MemorySegmentData> {
    const results: MemorySegmentData = {};

    // Read segments sequentially to avoid rate limiting
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      results[segment] = await this.readSegment(segment);

      // Add delay between requests (except after the last one)
      if (i < segments.length - 1) {
        await this.delay(delayMs);
      }
    }

    return results;
  }

  /**
   * Delay helper for rate limiting.
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
