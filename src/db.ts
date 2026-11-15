import { Database } from 'bun:sqlite';
import { databasePath, type Config } from './config';

/**
 * Lazily opening, WAL-mode connection to GlassHome's SQLite database
 * using Bun's built-in SQLite (bun:sqlite).
 */
export class GlassHomeDb {
  private readonly config: Config;
  private connection: Database | undefined;

  constructor(config: Config) {
    this.config = config;
  }

  /** True once the underlying connection is open. */
  get opened(): boolean {
    return this.connection !== undefined;
  }

  /**
   * Open (or return the cached) connection in WAL mode with a 5 s busy timeout.
   */
  use(): Database {
    if (this.connection !== undefined) return this.connection;
    const file = databasePath(this.config);
    // bun:sqlite quirk: passing an options object (even empty {}) triggers
    // SQLITE_MISUSE on some DBs; only pass options when actually readonly.
    const db = this.config.mcpReadonly
      ? new Database(file, { readonly: true })
      : new Database(file);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    this.connection = db;
    return db;
  }

  /**
   * Probe the database file.
   */
  probe(): string {
    try {
      const db = this.use();
      const row = db.query('SELECT COUNT(*) AS n FROM sqlite_master').get() as { n: number };
      return row.n > 0 ? 'open (GlassHome schema found)' : 'open (empty database — no tables yet)';
    } catch (error) {
      return `unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Read the HA URL from GlassHome's household_settings table.
   * Returns the stored URL, or `undefined` when unavailable.
   */
  haUrl(): string | undefined {
    try {
      const db = this.use();
      const row = db
        .prepare('SELECT hass_url_default FROM household_settings LIMIT 1')
        .get() as { hass_url_default: string } | undefined;
      return row?.hass_url_default || undefined;
    } catch {
      return undefined;
    }
  }

  /** Close the connection, if open. Safe to call multiple times. */
  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }
}
