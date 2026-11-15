import {
  Connection,
  createConnection,
  createLongLivedTokenAuth,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  type HassServiceTarget,
  type HassEntity,
} from 'home-assistant-js-websocket';
import { getStates, callService } from 'home-assistant-js-websocket';
import type { Config } from './config';
import { HaAuth } from './auth';
import type { GlassHomeDb } from './db';

/** Interval for the liveness watchdog (reconnect nudge + heartbeat probe). */
const WATCHDOG_INTERVAL_MS = 30_000;
/** How long `requireConnection` waits for a reconnect before giving up. */
const RECONNECT_WAIT_MS = 10_000;

/**
 * Home Assistant client for the sidecar.
 *
 * Wraps the `home-assistant-js-websocket` v9 connection (which reconnects on
 * its own when the socket drops) and adds:
 * - a background watchdog that nudges a stalled reconnect,
 * - a heartbeat (`ping` round-trip) that detects half-open sockets,
 * - a REST helper (areas, area members) using the same long-lived token.
 *
 * Connection failures are logged, never fatal: the MCP server stays up and
 * HA-backed tools report a clear error until HA is reachable.
 */
export class HaClient {
  private readonly config: Config;
  private readonly auth: HaAuth;
  private connection: Connection | undefined;
  private readonly timers: Array<NodeJS.Timeout> = [];
  /** Last time the connection was known healthy (heartbeat or (re)connect). */
  private lastHealthyAt: Date | undefined;

  constructor(config: Config, db: GlassHomeDb) {
    this.config = config;
    this.auth = new HaAuth(config, db);
  }

  /**
   * Start the background connection attempt and the watchdog.
   * Non-blocking: returns immediately, logs failures.
   */
  start(): void {
    if (!this.auth.hasToken()) {
      console.warn('[ha] no HA token available (set HA_TOKEN env or configure GlassHome HA account); Home Assistant tools will return an error.');
      return;
    }
    void this.connect();
    const watchdog = setInterval(() => {
      void this.watchdogTick();
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref();
    this.timers.push(watchdog);
  }

  /** True when a usable WebSocket to HA is open. */
  get connected(): boolean {
    return this.connection?.connected ?? false;
  }

  /**
   * Snapshot for health endpoints and startup logging.
   *
   * @returns Current HA client state.
   */
  status(): { url: string; tokenConfigured: boolean; tokenSource: string; connected: boolean; haVersion: string | null; lastHealthyAt: string | null } {
    return {
      url: this.auth.haUrl(),
      tokenConfigured: this.auth.hasToken(),
      tokenSource: this.auth.source(),
      connected: this.connected,
      haVersion: this.connection?.haVersion ?? null,
      lastHealthyAt: this.lastHealthyAt?.toISOString() ?? null,
    };
  }

  /**
   * Await a usable connection, reconnecting if needed.
   *
   * @returns The open connection.
   * @throws Error with an actionable message when HA is unreachable.
   */
  async requireConnection(): Promise<Connection> {
    if (!this.auth.hasToken()) {
      throw new Error('No HA token available. Set the HA_TOKEN env var or configure the GlassHome HA account.');
    }
    if (this.connection === undefined) await this.connect();
    const conn = this.connection;
    if (conn === undefined) {
      throw new Error(`Could not connect to Home Assistant at ${this.auth.haUrl()}. Check HA_URL and HA_TOKEN.`);
    }
    if (conn.connected) return conn;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RECONNECT_WAIT_MS);
      conn.addEventListener('ready', () => {
        clearTimeout(timer);
        resolve();
      });
      conn.reconnect();
    });
    if (!conn.connected) {
      throw new Error(`Not connected to Home Assistant at ${this.auth.haUrl()}. Check that HA is running and the token is valid.`);
    }
    return conn;
  }

  /**
   * Issue an HA WebSocket command with an explicit response type.
   *
   * @param message The raw WS command (e.g. `{ type: 'render_template', ... }`).
   * @returns The command result, or throws with the HA error message.
   */
  async command<Result>(message: { type: string; [key: string]: unknown }): Promise<Result> {
    const conn = await this.requireConnection();
    return conn.sendMessagePromise<Result>(message);
  }

  /**
   * Fetch the current state of every entity the token can read.
   *
   * @returns Entity states (entity_id keyed fields per state).
   */
  async getEntityStates(): Promise<HassEntity[]> {
    return getStates(await this.requireConnection());
  }

  /**
   * Call a Home Assistant service.
   *
   * @param domain Service domain, e.g. `light`.
   * @param service Service name, e.g. `turn_on`.
   * @param data Service data (optional).
   * @param target Target entities/devices/areas (optional).
   * @param returnResponse Request the service response when supported.
   * @returns The service result (undefined unless `returnResponse`).
   */
  async callService(domain: string, service: string, data?: Record<string, unknown>, target?: HassServiceTarget, returnResponse?: boolean): Promise<unknown> {
    return callService(await this.requireConnection(), domain, service, data, target, returnResponse);
  }

  /**
   * GET an HA REST API endpoint with the long-lived token.
   *
   * @param path Path relative to `/api`, e.g. `/areas`.
   * @returns The decoded JSON response.
   * @throws Error on HTTP or auth failure.
   */
  async rest<T>(path: string): Promise<T> {
    const token = await this.auth.getToken();
    if (token === undefined) {
      throw new Error('No HA token available; cannot call Home Assistant REST API.');
    }
    const res = await fetch(`${this.auth.haUrl()}/api${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Home Assistant REST GET ${path} failed with HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  /** Close the connection and stop background timers. */
  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.connection?.close();
    this.connection = undefined;
  }

  private async connect(): Promise<void> {
    try {
      const token = await this.auth.getToken();
      if (token === undefined) {
        console.warn('[ha] no HA token available; skipping connection');
        return;
      }
      const auth = createLongLivedTokenAuth(this.auth.haUrl(), token);
      const conn = await createConnection({ auth, setupRetry: 3 });
      conn.addEventListener('ready', () => {
        this.lastHealthyAt = new Date();
        console.log(`[ha] connected to ${this.auth.haUrl()} (HA ${conn.haVersion || 'unknown version'})`);
      });
      conn.addEventListener('disconnected', () => {
        console.warn('[ha] connection lost; auto-reconnect active');
      });
      conn.addEventListener('reconnect-error', () => {
        console.warn('[ha] reconnect attempt failed; watchdog will retry');
      });
      this.connection = conn;
    } catch (error) {
      // The library rejects with the raw error code number or an Error.
      const detail =
        error === ERR_INVALID_AUTH
          ? 'invalid or missing token'
          : error === ERR_CANNOT_CONNECT
            ? 'host unreachable'
            : error instanceof Error
              ? error.message
              : String(error);
      console.warn(`[ha] initial connection to ${this.auth.haUrl()} failed: ${detail}; will keep retrying in background`);
    }
  }

  private async watchdogTick(): Promise<void> {
    const conn = this.connection;
    if (conn === undefined) return;
    if (!conn.connected) {
      console.warn('[ha] watchdog: connection down, nudging reconnect');
      conn.reconnect();
      return;
    }
    // Heartbeat: a real round-trip that fails on a dead socket.
    try {
      await conn.ping();
      this.lastHealthyAt = new Date();
    } catch {
      console.warn('[ha] heartbeat failed; forcing socket replacement');
      try {
        conn.reconnect(true);
      } catch {
        // Reconnect is best-effort here; the next tick retries.
      }
    }
  }
}
