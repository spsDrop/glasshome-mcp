import type { Config } from './config.js';
import type { GlassHomeDb } from './db.js';

interface AccountRow {
  access_token: string;
  refresh_token: string;
  access_token_expires_at: number | null;
  metadata: string | null;
}

/**
 * HA auth resolver: uses an explicit long-lived token (HA_TOKEN env) when
 * set, otherwise falls back to the OAuth tokens stored in GlassHome's
 * SQLite `account` table (provider_id = 'hass').
 *
 * The OAuth access token is a JWT that expires; when it does, the
 * refresh token is used to mint a new one from `{haUrl}/auth/token`.
 */
export class HaAuth {
  private readonly config: Config;
  private readonly db: GlassHomeDb;
  /** Refresh token (from the DB, non-expiring). */
  private refreshToken: string | undefined;

  constructor(config: Config, db: GlassHomeDb) {
    this.config = config;
    this.db = db;
  }

  /**
   * Resolve a valid HA access token.
   *
   * Priority:
   *  1. `HA_TOKEN` env (long-lived, no expiry) — used verbatim.
   *  2. GlassHome DB `account` table (OAuth JWT + refresh token).
   *     Always re-reads from the DB (the dash-server keeps the token fresh).
   *     Falls back to a refresh only when the stored token is expired.
   *
   * @returns A valid access token, or `undefined` when none is available.
   */
  async getToken(): Promise<string | undefined> {
    // 1. Explicit long-lived token
    if (this.config.haToken) {
      return this.config.haToken;
    }

    // 2. Read from DB (always fresh — the dash-server refreshes tokens)
    const row = this.readAccount();
    if (row === undefined) return undefined;

    this.refreshToken = row.refresh_token;

    // Use the stored token if it's still valid (or close enough)
    if (row.access_token && (!row.access_token_expires_at || Date.now() / 1000 < row.access_token_expires_at)) {
      return row.access_token;
    }

    // 3. Stored token is expired — try to refresh
    const refreshed = await this.refresh();
    if (refreshed) return refreshed;

    // 4. Refresh failed — fall back to the stored token anyway (HA may
    //    still accept it during a grace window, and the dash-server will
    //    refresh the DB row on its next cycle).
    console.warn('[auth] refresh failed, falling back to stored (possibly expired) token');
    return row.access_token;
  }

  /** Effective HA URL: env var, or GlassHome DB fallback. */
  haUrl(): string {
    if (this.config.haUrl !== '') return this.config.haUrl;
    return this.db.haUrl() ?? '';
  }

  /** True when a token source is configured (env or DB). */
  hasToken(): boolean {
    if (this.config.haToken) return true;
    return this.readAccount() !== undefined;
  }

  /** Describe the token source for health/status output. */
  source(): string {
    if (this.config.haToken) return 'env (long-lived)';
    if (this.readAccount()) return 'glasshome db (oauth)';
    return 'none';
  }

  /** Force a refresh (used after a 401 from HA). */
  async forceRefresh(): Promise<string | undefined> {
    this.refreshToken = undefined;
    return this.getToken();
  }

  // ── internals ──────────────────────────────────────────────────────

  private readAccount(): AccountRow | undefined {
    try {
      const d = this.db.use();
      const row = d
        .prepare(
          `SELECT access_token, refresh_token, access_token_expires_at, metadata
           FROM account WHERE provider_id = 'hass'
           LIMIT 1`,
        )
        .get() as AccountRow | undefined;
      return row;
    } catch {
      return undefined;
    }
  }

  private async refresh(): Promise<string | undefined> {
    if (this.refreshToken === undefined) {
      const row = this.readAccount();
      if (row === undefined) return undefined;
      this.refreshToken = row.refresh_token;
    }

    try {
      const res = await fetch(`${this.haUrl()}/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
        }),
      });
      if (!res.ok) {
        console.warn(`[auth] token refresh failed: HTTP ${res.status}`);
        return undefined;
      }
      const body = (await res.json()) as {
        access_token: string;
        expires_in?: number;
      };
      console.log('[auth] refreshed HA access token from GlassHome DB');
      return body.access_token;
    } catch (error) {
      console.warn(`[auth] token refresh error: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
