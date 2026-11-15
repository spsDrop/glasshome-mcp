import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import {
  guardWritable,
  handler,
  jsonResult,
  parseJson,
  resolveDashboard,
  resolveOrganization,
  slugify,
  type DashboardRow,
  type ToolContext,
} from './common.js';

const getDashboardInput = z.object({
  dashboard: z.string().min(1).describe('Dashboard id (d_<uuid>) or slug.'),
});
type GetDashboardArgs = z.infer<typeof getDashboardInput>;

const createDashboardInput = z.object({
  name: z.string().min(1).describe('Display name, e.g. "Bedroom".'),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional()
    .describe('URL-safe slug; defaults to a slugified name. Must be unique per organization.'),
  icon: z.string().optional().describe('MDI icon, e.g. "mdi:bed".'),
  area_id: z.string().optional().describe('Optional HA area this dashboard represents.'),
  organization_id: z.string().optional().describe('Defaults to the instance organization.'),
});
type CreateDashboardArgs = z.infer<typeof createDashboardInput>;

const deleteDashboardInput = z.object({
  dashboard: z.string().min(1).describe('Dashboard id (d_<uuid>) or slug.'),
});
type DeleteDashboardArgs = z.infer<typeof deleteDashboardInput>;

/**
 * Register the dashboard management tools (GlassHome SQLite-backed).
 *
 * @param server MCP server to attach the tools to.
 * @param ctx Shared tool context.
 */
export function registerDashboardTools(server: McpServer, ctx: ToolContext): void {
  const { config, db } = ctx;

  server.registerTool(
    'list_dashboards',
    {
      description:
        'List all GlassHome dashboards (screens): id, slug, name, icon, dock order, and optional HA area binding.',
    },
    handler(async () => {
      const d = db.use();
      const rows = d
        .prepare(
          `SELECT id, slug, name, icon, area_id, is_visible_in_dock, dock_order,
                  organization_id, created_at, updated_at
           FROM dashboards
           ORDER BY (dock_order IS NULL), dock_order, created_at`,
        )
        .all() as DashboardRow[];
      const dashboards = rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        icon: row.icon,
        area_id: row.area_id,
        is_visible_in_dock: row.is_visible_in_dock === 1,
        dock_order: row.dock_order,
        organization_id: row.organization_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        layouts: parseJson(row.layouts),
      }));
      return jsonResult({ count: dashboards.length, dashboards });
    }),
  );

  server.registerTool(
    'get_dashboard',
    {
      description:
        'Get one GlassHome dashboard by id or slug, joined with its widget instances and per-breakpoint grid placements (sm/md/lg/xl).',
      inputSchema: getDashboardInput,
    },
    handler(async (raw) => {
      const { dashboard } = raw as GetDashboardArgs;
      const d = db.use();
      const row = resolveDashboard(d, dashboard);
      const widgets = collectDashboardWidgets(d, row);
      return jsonResult({
        dashboard: {
          id: row.id,
          slug: row.slug,
          name: row.name,
          icon: row.icon,
          area_id: row.area_id,
          is_visible_in_dock: row.is_visible_in_dock === 1,
          dock_order: row.dock_order,
          organization_id: row.organization_id,
          created_at: row.created_at,
          updated_at: row.updated_at,
          layouts: parseJson(row.layouts),
        },
        widgets,
      });
    }),
  );

  server.registerTool(
    'create_dashboard',
    {
      description: 'Create a new empty GlassHome dashboard. Mutating: disabled when MCP_READONLY=true.',
      inputSchema: createDashboardInput,
    },
    handler(async (raw) => {
      const { name, slug, icon, area_id, organization_id } = raw as CreateDashboardArgs;
      const denied = guardWritable(config);
      if (denied !== undefined) return denied;
      const d = db.use();
      const organization = organization_id ?? resolveOrganization(d);
      if (organization === null) {
        throw new Error('Could not determine the GlassHome organization; pass organization_id explicitly.');
      }
      const created = createDashboardRow(d, {
        organization,
        name,
        slug: slug ?? slugify(name),
        icon,
        area_id,
      });
      return jsonResult({ created });
    }),
  );

  server.registerTool(
    'delete_dashboard',
    {
      description:
        'Delete a GlassHome dashboard by id or slug. Its widget instances and placements are removed too. Mutating: disabled when MCP_READONLY=true.',
      inputSchema: deleteDashboardInput,
    },
    handler(async (raw) => {
      const { dashboard } = raw as DeleteDashboardArgs;
      const denied = guardWritable(config);
      if (denied !== undefined) return denied;
      const d = db.use();
      const row = resolveDashboard(d, dashboard);
      const remove = d.transaction(() => {
        d.prepare('DELETE FROM widget_placements WHERE instance_id IN (SELECT id FROM widget_instances WHERE dashboard_id = ?)').run(row.id);
        d.prepare('DELETE FROM widget_instances WHERE dashboard_id = ?').run(row.id);
        d.prepare('DELETE FROM dashboards WHERE id = ?').run(row.id);
      });
      remove();
      return jsonResult({ deleted: { id: row.id, slug: row.slug, name: row.name } });
    }),
  );
}

/**
 * Join a dashboard with its widget instances and placements.
 *
 * @param d Open database.
 * @param row The dashboard row.
 * @returns Widgets with their configs and per-breakpoint placements.
 */
function collectDashboardWidgets(d: Database, row: DashboardRow) {
  const rows = d
    .prepare(
      `SELECT wi.id AS instance_id, wi.registry, wi.scope, wi.name AS widget,
              wi.config AS config_json, wi.created_at AS created_at,
              wp.breakpoint, wp.x, wp.y, wp.w, wp.h
       FROM widget_instances AS wi
       LEFT JOIN widget_placements AS wp
              ON wp.instance_id = wi.id AND wp.organization_id = wi.organization_id
       WHERE wi.dashboard_id = ?
       ORDER BY wi.created_at, wp.breakpoint`,
    )
    .all(row.id) as Array<{
    instance_id: string;
    registry: string;
    scope: string;
    widget: string;
    config_json: string | null;
    created_at: number | null;
    breakpoint: string | null;
    x: number | null;
    y: number | null;
    w: number | null;
    h: number | null;
  }>;

  const byInstance = new Map<
    string,
    {
      instance_id: string;
      registry: string;
      scope: string;
      widget: string;
      config: unknown;
      created_at: number | null;
      placements: Record<string, { x: number; y: number; w: number; h: number }>;
    }
  >();
  for (const r of rows) {
    let entry = byInstance.get(r.instance_id);
    if (entry === undefined) {
      entry = {
        instance_id: r.instance_id,
        registry: r.registry,
        scope: r.scope,
        widget: r.widget,
        config: parseJson(r.config_json),
        created_at: r.created_at,
        placements: {},
      };
      byInstance.set(r.instance_id, entry);
    }
    if (r.breakpoint !== null && r.x !== null && r.y !== null && r.w !== null && r.h !== null) {
      entry.placements[r.breakpoint] = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
  }
  return [...byInstance.values()];
}

/**
 * Insert a new dashboard row with generated id, unique slug, and next dock order.
 *
 * @param d Open database.
 * @param args Dashboard fields.
 * @returns The created dashboard as stored.
 */
function createDashboardRow(
  d: Database,
  args: { organization: string; name: string; slug: string; icon?: string; area_id?: string },
): {
  id: string;
  slug: string;
  name: string;
  icon: string | null;
  area_id: string | null;
  organization_id: string;
} {
  let slug = args.slug;
  let suffix = 2;
  while (
    (
      d.prepare('SELECT 1 FROM dashboards WHERE organization_id = ? AND slug = ?').get(args.organization, slug) as
        | { 1: 1 }
        | undefined
    ) !== undefined
  ) {
    slug = `${args.slug}-${suffix++}`;
  }
  const owner = d
    .prepare(
      'SELECT user_id FROM dashboards WHERE organization_id = ? AND user_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1',
    )
    .get(args.organization) as { user_id: string } | undefined;
  const dockOrder = d
    .prepare('SELECT COALESCE(MAX(dock_order) + 1, 0) AS next FROM dashboards WHERE organization_id = ?')
    .get(args.organization) as { next: number };
  const id = `d_${randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  d.prepare(
    `INSERT INTO dashboards
       (id, user_id, organization_id, slug, name, icon, layouts, area_id, is_visible_in_dock, dock_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?, ?)`,
  ).run(
    id,
    owner?.user_id ?? null,
    args.organization,
    slug,
    args.name,
    args.icon ?? null,
    args.area_id ?? null,
    dockOrder.next,
    now,
    now,
  );
  return {
    id,
    slug,
    name: args.name,
    icon: args.icon ?? null,
    area_id: args.area_id ?? null,
    organization_id: args.organization,
  };
}
