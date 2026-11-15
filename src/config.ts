import path from 'node:path';

/** Environment-driven configuration for the GlassHome MCP sidecar. */
export interface Config {
  /** Base URL of the Home Assistant instance, e.g. `http://ha:8123`. */
  readonly haUrl: string;
  /** HA long-lived access token used for both WebSocket and REST calls. */
  readonly haToken: string;
  /** Directory containing GlassHome data (`glasshome.sqlite`). */
  readonly glasshomeDataDir: string;
  /** TCP port for the MCP Streamable HTTP endpoint. */
  readonly mcpPort: number;
  /** When true, every mutating tool is rejected with a clear error. */
  readonly mcpReadonly: boolean;
}

/** Minimal env-map shape so {@link loadConfig} stays testable. */
export interface EnvLike {
  readonly [key: string]: string | undefined;
}

const DEFAULTS = {
  haUrl: '',  // empty = resolve from GlassHome DB (household_settings.hass_url_default)
  glasshomeDataDir: '/data',
  mcpPort: 3900,
} as const;

/**
 * Load sidecar configuration from environment variables.
 *
 * @param env Environment to read (defaults to `process.env`).
 * @returns Parsed, validated configuration.
 * @throws Error when `MCP_PORT` is set but is not an integer port.
 */
export function loadConfig(env: EnvLike = process.env): Config {
  const port = env.MCP_PORT !== undefined ? Number(env.MCP_PORT) : DEFAULTS.mcpPort;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`MCP_PORT must be an integer TCP port, got: ${env.MCP_PORT}`);
  }
  return {
    haUrl: (env.HA_URL ?? DEFAULTS.haUrl).replace(/\/+$/, ''),
    haToken: env.HA_TOKEN ?? '',
    glasshomeDataDir: env.GLASSHOME_DATA_DIR ?? DEFAULTS.glasshomeDataDir,
    mcpPort: port,
    mcpReadonly: env.MCP_READONLY === 'true',
  };
}

/** Absolute path of the GlassHome SQLite database file. */
export function databasePath(config: Config): string {
  return path.join(config.glasshomeDataDir, 'glasshome.sqlite');
}
