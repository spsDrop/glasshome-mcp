import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { Config } from '../config';
import type { GlassHomeDb } from '../db';
import type { HaClient } from '../ha';

/** Everything tool groups need to do their work. */
export interface ToolContext {
  readonly config: Config;
  readonly db: GlassHomeDb;
  readonly ha: HaClient;
}

/** JSON-serializable MCP tool payload (text content is the tool's result). */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Serialize a value as the tool's JSON result. */
export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Build an MCP error result (isError: true) from a message. */
export function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/**
 * Reject mutating tools when the server runs read-only.
 *
 * @param config Server configuration.
 * @returns An error result when read-only, or undefined when writes are allowed.
 */
export function guardWritable(config: Config): ToolResult | undefined {
  return config.mcpReadonly
    ? errorResult('Server is running with MCP_READONLY=true; this tool would modify state and is disabled.')
    : undefined;
}

/**
 * Wrap a tool handler so any thrown error becomes an MCP error result
 * instead of crashing the session. The wrapper stays non-generic on purpose:
 * SDK contextual typing does not flow through nested generics, so each tool
 * casts `args` to its own `z.infer` type at the top of the handler.
 *
 * @param fn Handler that may throw; receives the raw (unknown) args.
 * @returns A handler that always resolves.
 */
export function handler(fn: (args: unknown) => Promise<ToolResult>): (args: unknown) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  };
}

/** One row of the GlassHome `dashboards` table. */
export interface DashboardRow {
  id: string;
  user_id: string | null;
  organization_id: string | null;
  slug: string | null;
  name: string | null;
  icon: string | null;
  layouts: string | null;
  area_id: string | null;
  is_visible_in_dock: number | null;
  dock_order: number | null;
  created_at: number | null;
  updated_at: number | null;
}

/** One row of the GlassHome `widget_instances` table. */
export interface WidgetInstanceRow {
  id: string;
  organization_id: string | null;
  dashboard_id: string;
  registry: string;
  scope: string;
  name: string;
  config: string | null;
  previous_config: string | null;
  created_at: number | null;
}

/** Layout breakpoints used by GlassHome grid placements. */
export const BREAKPOINTS = ['sm', 'md', 'lg', 'xl'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** Shared grid cell shape for every placement argument. */
export const placementShape = {
  x: z.number().int().min(0).describe('Grid column (0-based).'),
  y: z.number().int().min(0).describe('Grid row (0-based).'),
  w: z.number().int().positive().describe('Width in grid units.'),
  h: z.number().int().positive().describe('Height in grid units.'),
};
/** Concrete grid cell (structural twin of {@link placementShape}). */
export type PlacementSpec = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/** Per-breakpoint placement overrides; any omitted breakpoint inherits the base placement. */
const cell = z.object(placementShape).optional();
export const breakpointsShape = { sm: cell, md: cell, lg: cell, xl: cell } satisfies Record<
  Breakpoint,
  z.ZodTypeAny
>;
/** Shape of the per-breakpoint overrides argument (structural twin of {@link breakpointsShape}). */
export type BreakpointOverrides = {
  [BP in Breakpoint]?: PlacementSpec;
};

/**
 * Resolve a dashboard by id or slug.
 *
 * @param db Open GlassHome database.
 * @param ref Dashboard id (e.g. `d_<uuid>`) or slug.
 * @returns The dashboard row.
 * @throws Error naming the known dashboards when the ref matches nothing.
 */
export function resolveDashboard(db: Database, ref: string): DashboardRow {
  const row = db
    .prepare('SELECT * FROM dashboards WHERE id = ? OR slug = ? LIMIT 1')
    .get(ref, ref) as DashboardRow | undefined;
  if (row === undefined) {
    const known = db
      .prepare('SELECT slug, name FROM dashboards ORDER BY (dock_order IS NULL), dock_order, created_at')
      .all() as Array<{ slug: string | null; name: string | null }>;
    const names = known.map((d) => d.slug ?? d.name).filter((s): s is string => s !== null);
    throw new Error(`Dashboard "${ref}" not found by id or slug. Known dashboards: ${names.join(', ') || '(none)'}`);
  }
  return row;
}

/**
 * Determine the GlassHome organization (tenant) this instance belongs to.
 *
 * @param db Open GlassHome database.
 * @returns The organization id, or null when no table can answer.
 */
export function resolveOrganization(db: Database): string | null {
  const fromSettings = db
    .prepare('SELECT organization_id FROM household_settings WHERE organization_id IS NOT NULL LIMIT 1')
    .get() as { organization_id: string } | undefined;
  if (fromSettings !== undefined) return fromSettings.organization_id;
  const fromDashboards = db
    .prepare('SELECT organization_id FROM dashboards WHERE organization_id IS NOT NULL ORDER BY created_at DESC LIMIT 1')
    .get() as { organization_id: string } | undefined;
  return fromDashboards?.organization_id ?? null;
}

/**
 * Parse a JSON column, tolerating null and malformed values.
 *
 * @param value Raw column text.
 * @returns The parsed value, or the raw text when parsing fails.
 */
export function parseJson(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Normalize a base placement plus per-breakpoint overrides into concrete
 * cells for all four breakpoints.
 *
 * @param base Default placement applied to every breakpoint.
 * @param overrides Per-breakpoint wins over the base.
 * @param fallback Last-resort cell (e.g. the widget's minSize).
 * @returns Placement per breakpoint.
 */
export function effectivePlacements(
  base: PlacementSpec | undefined,
  overrides: BreakpointOverrides | undefined,
  fallback: PlacementSpec,
): Record<Breakpoint, PlacementSpec> {
  const out = {} as Record<Breakpoint, PlacementSpec>;
  for (const bp of BREAKPOINTS) {
    out[bp] = overrides?.[bp] ?? base ?? fallback;
  }
  return out;
}

/** Make a URL-safe slug from a dashboard name. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'dashboard';
}
