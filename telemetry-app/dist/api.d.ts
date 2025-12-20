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
export declare class ScreepsAPI {
    private config;
    private baseUrl;
    private lastRequestTime;
    private minRequestInterval;
    constructor(config: ScreepsConfig);
    /**
     * Wait for rate limit cooldown before making a request.
     */
    private waitForRateLimit;
    /**
     * Read a memory segment with retry logic for rate limiting.
     */
    readSegment(segment: number, retries?: number): Promise<string | null>;
    /**
     * Read multiple memory segments.
     * Reads sequentially with built-in rate limiting.
     */
    readSegments(segments: number[]): Promise<MemorySegmentData>;
    /**
     * Delay helper for rate limiting.
     */
    private delay;
    /**
     * Get server time (to check connectivity).
     */
    getTime(): Promise<number | null>;
    /**
     * Test connection and authentication.
     */
    testConnection(): Promise<boolean>;
}
