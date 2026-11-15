import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import {
  BREAKPOINTS,
  breakpointsShape,
  effectivePlacements,
  guardWritable,
  handler,
  jsonResult,
  parseJson,
  placementShape,
  resolveDashboard,
  resolveOrganization,
  type Breakpoint,
  type DashboardRow,
  type PlacementSpec,
  type ToolContext,
  type WidgetInstanceRow,
} from './common';

/** Parsed `installed_widgets.manifest_json` (only the fields the sidecar uses). */
interface WidgetManifest {
  scope?: string;
  name?: string;
  version?: string;
  displayName?: string;
  description?: string;
  icon?: string;
  minSize?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  sdkVersion?: string;
  configVersion?: number;
  schema?: unknown;
  defaultConfig?: Record<string, unknown>;
  examples?: unknown[];
}

/** One row of the GlassHome `installed_widgets` table. */
interface InstalledWidgetRow {
  organization_id: string | null;
  registry: string;
  scope: string;
  name: string;
  version: string;
  bundle_url: string | null;
  manifest_json: string | null;
  css_url: string | null;
  granted_capabilities_json: string | null;
  latest_compatible_sdk: string | null;
}

const DEFAULT_REGISTRY = 'hub';
const DEFAULT_SCOPE = 'glasshome';

const addWidgetInput = z.object({
  dashboard: z.string().min(1).describe('Dashboard id (d_<uuid>) or slug.'),
  name: z.string().min(1).describe('Widget type, e.g. "light" or "weather".'),
  config: z.record(z.unknown()).optional().describe('Widget config; defaults to the widget defaultConfig.'),
  registry: z.string().optional().describe(`Widget registry (default "${DEFAULT_REGISTRY}").`),
  scope: z.string().optional().describe(`Widget scope (default "${DEFAULT_SCOPE}").`),
  placement: z.object(placementShape).optional().describe('Grid cell applied to every breakpoint unless overridden.'),
  breakpoints: z
    .object(breakpointsShape)
    .optional()
    .describe('Per-breakpoint cells (sm/md/lg/xl) that override placement.'),
});
type AddWidgetArgs = z.infer<typeof addWidgetInput>;

const removeWidgetInput = z.object({
  widget: z.string().min(1).describe('Widget instance id (UUID), as returned by get_dashboard / add_widget.'),
});
type RemoveWidgetArgs = z.infer<typeof removeWidgetInput>;

const updateWidgetInput = z.object({
  widget: z.string().min(1).describe('Widget instance id (UUID).'),
  config: z.record(z.unknown()).optional().describe('New full widget config (replaces the old one).'),
  placement: z.object(placementShape).optional().describe('New grid cell applied to every breakpoint.'),
  breakpoints: z
    .object(breakpointsShape)
    .optional()
    .describe('Per-breakpoint cells; win over placement for the breakpoints they set.'),
});
type UpdateWidgetArgs = z.infer<typeof updateWidgetInput>;

const rearrangeLayoutInput = z.object({
  dashboard: z.string().min(1).describe('Dashboard id (d_<uuid>) or slug.'),
  moves: z
    .array(
      z.object({
        widget: z.string().min(1).describe('Widget instance id (UUID).'),
        breakpoint: z.enum(BREAKPOINTS).optional().describe('Only this breakpoint; defaults to all four.'),
        x: z.number().int().min(0),
        y: z.number().int().min(0),
        w: z.number().int().positive(),
        h: z.number().int().positive(),
      }),
    )
    .min(1),
});
type RearrangeLayoutArgs = z.infer<typeof rearrangeLayoutInput>;

const listAvailableWidgetsInput = z.object({
  include_schemas: z.boolean().optional().describe('Include the per-widget config JSON Schema (larger response).'),
});
type ListAvailableWidgetsArgs = z.infer<typeof listAvailableWidgetsInput>;

const describeWidgetSchemaInput = z.object({
  widget: z.string().min(1).describe('Widget type, e.g. "light".'),
  registry: z.string().optional().describe(`Widget registry (default "${DEFAULT_REGISTRY}").`),
  scope: z.string().optional().describe(`Widget scope (default "${DEFAULT_SCOPE}").`),
});
type DescribeWidgetSchemaArgs = z.infer<typeof describeWidgetSchemaInput>;

function parseManifest(value: string | null | undefined): WidgetManifest | undefined {
  const parsed = parseJson(value);
  return parsed !== null && typeof parsed === 'object' ? (parsed as WidgetManifest) : undefined;
}

/**
 * Find an installed widget by registry/scope/name, preferring the row of the
 * given organization when several exist.
 */
function findInstalledWidget(
  d: Database,
  organization: string | null,
  registry: string,
  scope: string,
  name: string,
): InstalledWidgetRow | undefined {
  const rows = d
    .prepare('SELECT * FROM installed_widgets WHERE name = ? AND registry = ? AND scope = ? ORDER BY version DESC')
    .all(name, registry, scope) as InstalledWidgetRow[];
  if (rows.length === 0) return undefined;
  if (organization !== null) {
    const owned = rows.find((r) => r.organization_id === organization);
    if (owned !== undefined) return owned;
  }
  return rows[0];
}

/**
 * Register the widget management and discovery tools (GlassHome SQLite-backed).
 *
 * @param server MCP server to attach the tools to.
 * @param ctx Shared tool context.
 */
export function registerWidgetTools(server: McpServer, ctx: ToolContext): void {
  const { config, db } = ctx;

  server.registerTool(
    'add_widget',
    {
      description:
        'Add a widget to a GlassHome dashboard: creates the widget instance and its grid placements for all four breakpoints (sm, md, lg, xl). The widget type must be an installed widget; use list_available_widgets to see which. Mutating: disabled when MCP_READONLY=true.',
      inputSchema: addWidgetInput,
    },
    handler(async (raw) => {
      const { dashboard, name, config: widgetConfig, registry, scope, placement, breakpoints } = raw as AddWidgetArgs;
      const denied = guardWritable(config);
      if (denied !== undefined) return denied;
      const d = db.use();
      const row = resolveDashboard(d, dashboard);
      if (row.organization_id === null) {
        throw new Error(`Dashboard "${dashboard}" has no organization_id; cannot place widgets in it.`);
      }
      const registryName = registry ?? DEFAULT_REGISTRY;
      const scopeName = scope ?? DEFAULT_SCOPE;
      const installed = findInstalledWidget(d, row.organization_id, registryName, scopeName, name);
      if (installed === undefined) {
        throw new Error(
          `Widget "${name}" is not installed (registry="${registryName}", scope="${scopeName}"). Use list_available_widgets to see installed widget types.`,
        );
      }
      const manifest = parseManifest(installed.manifest_json);
      const fallback: PlacementSpec = { x: 0, y: 0, w: manifest?.minSize?.w ?? 1, h: manifest?.minSize?.h ?? 1 };
      const placements = effectivePlacements(placement, breakpoints, fallback);
      const instanceId = randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const add = d.transaction(() => {
        d.prepare(
          `INSERT INTO widget_instances
             (id, organization_id, dashboard_id, registry, scope, name, config, previous_config, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        ).run(
          instanceId,
          row.organization_id,
          row.id,
          registryName,
          scopeName,
          name,
          JSON.stringify(widgetConfig ?? manifest?.defaultConfig ?? {}),
          now,
        );
        for (const bp of BREAKPOINTS) {
          const cell = placements[bp];
          d.prepare(
            'INSERT INTO widget_placements (instance_id, organization_id, breakpoint, x, y, w, h) VALUES (?, ?, ?, ?, ?, ?, ?)',
          ).run(instanceId, row.organization_id, bp, cell.x, cell.y, cell.w, cell.h);
        }
      });
      add();
      return jsonResult({
        added: {
          instance_id: instanceId,
          dashboard_id: row.id,
          widget: name,
          registry: registryName,
          scope: scopeName,
          config: widgetConfig ?? manifest?.defaultConfig ?? {},
          placements,
        },
      });
    }),
  );

  server.registerTool(
    'remove_widget',
    {
      description:
        'Remove a widget instance from its GlassHome dashboard (also removes its placements). Mutating: disabled when MCP_READONLY=true.',
      inputSchema: removeWidgetInput,
    },
    handler(async (raw) => {
      const { widget } = raw as RemoveWidgetArgs;
      const denied = guardWritable(config);
      if (denied !== undefined) return denied;
      const d = db.use();
      const remove = d.transaction(() => {
        d.prepare('DELETE FROM widget_placements WHERE instance_id = ?').run(widget);
        return d.prepare('DELETE FROM widget_instances WHERE id = ?').run(widget);
      });
      const result = remove();
      if (result.changes === 0) {
        throw new Error(`Widget instance "${widget}" not found (it may already be removed).`);
      }
      return jsonResult({ removed: widget });
    }),
  );

  server.registerTool(
    'update_widget',
    {
      description:
        'Update a widget instance: replace its config (the old config is kept as previous_config) and/or move/resize it on one or all breakpoints. Mutating: disabled when MCP_READONLY=true.',
      inputSchema: updateWidgetInput,
    },
    handler(async (raw) => {
      const { widget, config: newConfig, placement, breakpoints } = raw as UpdateWidgetArgs;
      const denied = guardWritable(config);
      if (denied !== undefined) return denied;
      const d = db.use();
      const row = d.prepare('SELECT * FROM widget_instances WHERE id = ?').get(widget) as WidgetInstanceRow | undefined;
      if (row === undefined) {
        throw new Error(`Widget instance "${widget}" not found. Use get_dashboard to list instance ids.`);
      }
      const updated: string[] = [];
      const apply = d.transaction(() => {
        if (newConfig !== undefined) {
          d.prepare('UPDATE widget_instances SET config = ?, previous_config = config WHERE id = ?').run(
            JSON.stringify(newConfig),
            widget,
          );
          updated.push('config');
        }
        const targets = new Map<Breakpoint, PlacementSpec>();
        if (placement !== undefined) for (const bp of BREAKPOINTS) targets.set(bp, placement);
        if (breakpoints !== undefined) {
          for (const bp of BREAKPOINTS) {
            const override = breakpoints[bp];
            if (override !== undefined) targets.set(bp, override);
          }
        }
        for (const [bp, cell] of targets) {
          d.prepare(
            'UPDATE widget_placements SET x = ?, y = ?, w = ?, h = ? WHERE instance_id = ? AND organization_id = ? AND breakpoint = ?',
          ).run(cell.x, cell.y, cell.w, cell.h, widget, row.organization_id, bp);
        }
        if (targets.size > 0) updated.push(...[...targets.keys()]);
      });
      apply();
      if (updated.length === 0) {
        throw new Error('Nothing to update: pass config, placement, and/or breakpoints.');
      }
      return jsonResult({ updated: { widget, fields: updated } });
    }),
  );

  server.registerTool(
    'rearrange_layout',
    {
      description:
        'Reorder/resize widgets on a GlassHome dashboard by moving their grid cells. Each move targets one widget; a move without a breakpoint applies to all four. Mutating: disabled when MCP_READONLY=true.',
      inputSchema: rearrangeLayoutInput,
    },
    handler(async (raw) => {
      const { dashboard, moves } = raw as RearrangeLayoutArgs;
      const denied = guardWritable(config);
      if (denied !== undefined) return denied;
      const d = db.use();
      const row = resolveDashboard(d, dashboard);
      if (row.organization_id === null) {
        throw new Error(`Dashboard "${dashboard}" has no organization_id; cannot rearrange its layout.`);
      }
      const apply = d.transaction(() => {
        for (const move of moves) {
          const instance = d
            .prepare('SELECT id FROM widget_instances WHERE id = ? AND dashboard_id = ?')
            .get(move.widget, row.id) as { id: string } | undefined;
          if (instance === undefined) {
            throw new Error(
              `Widget "${move.widget}" is not on dashboard "${row.slug ?? row.id}". Use get_dashboard to list instance ids.`,
            );
          }
          const bps: readonly Breakpoint[] = move.breakpoint !== undefined ? [move.breakpoint] : BREAKPOINTS;
          for (const bp of bps) {
            d.prepare(
              'UPDATE widget_placements SET x = ?, y = ?, w = ?, h = ? WHERE instance_id = ? AND organization_id = ? AND breakpoint = ?',
            ).run(move.x, move.y, move.w, move.h, move.widget, row.organization_id, bp);
          }
        }
      });
      apply();
      return jsonResult({
        dashboard: row.id,
        moved: moves.map((m) => ({
          widget: m.widget,
          breakpoint: m.breakpoint ?? [...BREAKPOINTS],
          cell: { x: m.x, y: m.y, w: m.w, h: m.h },
        })),
      });
    }),
  );

  server.registerTool(
    'list_available_widgets',
    {
      description:
        'List widget types installed in GlassHome (from installed_widgets), with display info, size limits, and granted capabilities. Set include_schemas to also get each widget config JSON Schema.',
      inputSchema: listAvailableWidgetsInput,
    },
    handler(async (raw) => {
      const { include_schemas } = raw as ListAvailableWidgetsArgs;
      const d = db.use();
      const organization = resolveOrganization(d);
      const rows =
        organization !== null
          ? (d.prepare('SELECT * FROM installed_widgets WHERE organization_id = ? ORDER BY name, version DESC').all(organization) as InstalledWidgetRow[])
          : (d.prepare('SELECT * FROM installed_widgets ORDER BY name, version DESC').all() as InstalledWidgetRow[]);
      const seen = new Set<string>();
      const widgets: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const key = `${row.registry}|${row.scope}|${row.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const manifest = parseManifest(row.manifest_json);
        const entry: Record<string, unknown> = {
          name: row.name,
          registry: row.registry,
          scope: row.scope,
          version: row.version,
          display_name: manifest?.displayName ?? row.name,
          description: manifest?.description ?? null,
          icon: manifest?.icon ?? null,
          min_size: manifest?.minSize ?? null,
          max_size: manifest?.maxSize ?? null,
          capabilities: parseJson(row.granted_capabilities_json) ?? [],
        };
        if (include_schemas) {
          entry.schema = manifest?.schema ?? null;
          entry.default_config = manifest?.defaultConfig ?? null;
          entry.examples = manifest?.examples ?? [];
        }
        widgets.push(entry);
      }
      return jsonResult({ count: widgets.length, widgets });
    }),
  );

  server.registerTool(
    'describe_widget_schema',
    {
      description:
        'Get the config JSON Schema, default config, examples, size limits, and capabilities for one installed widget type — what the LLM needs to fill in a valid add_widget config.',
      inputSchema: describeWidgetSchemaInput,
    },
    handler(async (raw) => {
      const { widget, registry, scope } = raw as DescribeWidgetSchemaArgs;
      const d = db.use();
      const organization = resolveOrganization(d);
      const row = findInstalledWidget(d, organization, registry ?? DEFAULT_REGISTRY, scope ?? DEFAULT_SCOPE, widget);
      if (row === undefined) {
        throw new Error(
          `Widget "${widget}" is not installed (registry="${registry ?? DEFAULT_REGISTRY}", scope="${scope ?? DEFAULT_SCOPE}"). Use list_available_widgets to see installed widget types.`,
        );
      }
      const manifest = parseManifest(row.manifest_json);
      return jsonResult({
        name: row.name,
        version: row.version,
        registry: row.registry,
        scope: row.scope,
        display_name: manifest?.displayName ?? row.name,
        description: manifest?.description ?? null,
        icon: manifest?.icon ?? null,
        min_size: manifest?.minSize ?? null,
        max_size: manifest?.maxSize ?? null,
        capabilities: parseJson(row.granted_capabilities_json) ?? [],
        default_config: manifest?.defaultConfig ?? null,
        examples: manifest?.examples ?? [],
        schema: manifest?.schema ?? null,
      });
    }),
  );

  server.registerTool(
    'get_dashboard_summary',
    {
      description:
        'Compact overview of the GlassHome instance: every dashboard with its widget counts and widget-type breakdown, installed widget types, and household settings (HA URL, theme, main dashboard).',
    },
    handler(async () => {
      const d = db.use();
      const organization = resolveOrganization(d);
      const settings =
        organization !== null
          ? (d
              .prepare('SELECT * FROM household_settings WHERE organization_id = ?')
              .get(organization) as {
              hass_url_default: string | null;
              active_theme_id: string | null;
              main_dashboard_slug: string | null;
              dock_mode: string | null;
            } | undefined)
          : undefined;
      const dashboards = (
        organization !== null
          ? d
              .prepare(
                'SELECT id, slug, name, area_id FROM dashboards WHERE organization_id = ? ORDER BY (dock_order IS NULL), dock_order, created_at',
              )
              .all(organization)
          : d.prepare(
              'SELECT id, slug, name, area_id FROM dashboards ORDER BY (dock_order IS NULL), dock_order, created_at',
            )
            .all()
      ) as DashboardRow[];
      const counts = (
        organization !== null
          ? d
              .prepare('SELECT dashboard_id, name, COUNT(*) AS n FROM widget_instances WHERE organization_id = ? GROUP BY dashboard_id, name')
              .all(organization)
          : d
              .prepare('SELECT dashboard_id, name, COUNT(*) AS n FROM widget_instances GROUP BY dashboard_id, name')
              .all()
      ) as Array<{ dashboard_id: string; name: string; n: number }>;
      const byDashboard = new Map<string, { total: number; types: Record<string, number> }>();
      for (const c of counts) {
        const entry = byDashboard.get(c.dashboard_id) ?? { total: 0, types: {} };
        entry.total += c.n;
        entry.types[c.name] = c.n;
        byDashboard.set(c.dashboard_id, entry);
      }
      const installedTypes = (
        organization !== null
          ? d.prepare('SELECT COUNT(DISTINCT name) AS n FROM installed_widgets WHERE organization_id = ?').get(organization)
          : d.prepare('SELECT COUNT(DISTINCT name) AS n FROM installed_widgets').get()
      ) as { n: number };
      const totalWidgets = [...byDashboard.values()].reduce((sum, e) => sum + e.total, 0);
      return jsonResult({
        organization,
        settings:
          settings !== undefined
            ? {
                hass_url_default: settings.hass_url_default,
                active_theme_id: settings.active_theme_id,
                main_dashboard_slug: settings.main_dashboard_slug,
                dock_mode: settings.dock_mode,
              }
            : null,
        dashboards: dashboards.map((row) => ({
          id: row.id,
          slug: row.slug,
          name: row.name,
          area_id: row.area_id,
          widget_count: byDashboard.get(row.id)?.total ?? 0,
          widget_types: byDashboard.get(row.id)?.types ?? {},
        })),
        totals: {
          dashboards: dashboards.length,
          widgets: totalWidgets,
          installed_widget_types: installedTypes.n,
        },
      });
    }),
  );
}
