import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import type { Config } from '../config';
import type { GlassHomeDb } from '../db';
import type { HaClient } from '../ha';

const HUB_API = 'https://glasshome.app/api/v1/widgets';

interface HubVersion {
  version: string;
  bundleUrl: string;
  cssUrl?: string;
  bundleSize: number;
  sha256Hash: string;
  cssSha256Hash?: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  minSize: { w: number; h: number };
  maxSize: { w: number; h: number };
  sdkVersion: string;
  configVersion: number | null;
  schema?: Record<string, unknown>;
  capabilities?: Array<{ domain: string; access: string }>;
  yanked: boolean;
  yankedReason?: string;
}

interface HubWidgetDetail {
  widget: {
    scope: string;
    name: string;
    displayName: string;
    description: string | null;
  };
  versions: HubVersion[];
  latestVersion: string | null;
}

/**
 * Register the install_widget tool.
 *
 * Downloads a widget bundle from the GlassHome hub CDN, caches it on disk,
 * and registers it in the `installed_widgets` table so the dash-server
 * can serve it.
 */
export function registerInstallTools(
  server: McpServer,
  ctx: { config: Config; db: GlassHomeDb; ha: HaClient },
): void {
  const { config, db } = ctx;

  server.registerTool(
    'install_widget',
    {
      title: 'Install Widget',
      description:
        'Download a widget bundle from the GlassHome hub CDN, cache it locally, and register it in the installed_widgets table. After install, the widget is available for use in add_widget.',
      inputSchema: {
        scope: z
          .string()
          .describe('Widget scope, e.g. "glasshome" for official widgets'),
        name: z.string().describe('Widget name, e.g. "sensor", "climate", "camera"'),
        version: z
          .string()
          .optional()
          .describe('Specific version to install. Defaults to latest.'),
      },
    },
    async ({ scope, name, version }) => {
      const target = version;

      // 1. Fetch widget detail from the hub
      const detailUrl = `${HUB_API}/${scope}/${name}`;
      const res = await fetch(detailUrl);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Hub API error ${res.status} for ${scope}/${name}: ${body}`);
      }
      const detail = (await res.json()) as HubWidgetDetail;

      // 2. Pick the version
      const ver = target ?? detail.latestVersion;
      if (!ver) {
        throw new Error(`No versions available for ${scope}/${name}`);
      }
      const vEntry = detail.versions.find((v) => v.version === ver);
      if (!vEntry) {
        const available = detail.versions.map((v) => v.version).join(', ');
        throw new Error(`Version ${ver} not found for ${scope}/${name}. Available: ${available}`);
      }
      if (vEntry.yanked) {
        throw new Error(
          `Version ${ver} of ${scope}/${name} is yanked: ${vEntry.yankedReason ?? 'no reason'}`,
        );
      }

      // 3. Determine the local bundle path
      const bundleDir = `/data/bundles/hub/${scope}/${name}/${ver}`;
      const bundlePath = `${bundleDir}/bundle.js`;
      const cssPath = `${bundleDir}/bundle.css`;

      // 4. Check if already installed (skip download if bundle exists)
      const fs = await import('node:fs');
      const path = await import('node:path');
      if (!fs.existsSync(bundlePath)) {
        // Download JS bundle
        const jsRes = await fetch(vEntry.bundleUrl);
        if (!jsRes.ok) {
          throw new Error(`Failed to download bundle: HTTP ${jsRes.status} from ${vEntry.bundleUrl}`);
        }
        const jsBuf = Buffer.from(await jsRes.arrayBuffer());

        // Verify hash
        if (vEntry.sha256Hash) {
          const crypto = await import('node:crypto');
          const hash = crypto.createHash('sha256').update(jsBuf).digest('hex');
          if (hash !== vEntry.sha256Hash) {
            throw new Error(`SHA-256 mismatch for ${scope}/${name}@${ver}: got ${hash}, expected ${vEntry.sha256Hash}`);
          }
        }

        fs.mkdirSync(bundleDir, { recursive: true });
        fs.writeFileSync(bundlePath, jsBuf);

        // Download CSS bundle (if available)
        if (vEntry.cssUrl) {
          const cssRes = await fetch(vEntry.cssUrl);
          if (cssRes.ok) {
            fs.writeFileSync(cssPath, Buffer.from(await cssRes.arrayBuffer()));
          }
        }
        console.log(`[install] downloaded ${scope}/${name}@${ver} (${jsBuf.length}b)`);
      } else {
        console.log(`[install] ${scope}/${name}@${ver} already cached`);
      }

      // 5. Build the manifest JSON (match the format of existing rows)
      const manifest = {
        scope,
        name,
        version: ver,
        displayName: vEntry.displayName,
        description: vEntry.description ?? '',
        icon: vEntry.icon ?? 'mdi:widgets',
        minSize: vEntry.minSize,
        maxSize: vEntry.maxSize,
        sdkVersion: vEntry.sdkVersion,
        configVersion: vEntry.configVersion ?? 1,
        schema: vEntry.schema ?? { type: 'object', properties: {} },
        capabilities: vEntry.capabilities ?? [],
      };

      // 6. Insert into installed_widgets (upsert)
      const d = db.use();
      const orgId = (
        d.prepare('SELECT organization_id FROM household_settings LIMIT 1').get() as
          | { organization_id: string }
          | undefined
      )?.organization_id;
      if (!orgId) {
        throw new Error('No organization found in household_settings');
      }

      // Check if already installed
      const existing = d
        .prepare(
          'SELECT id, version FROM installed_widgets WHERE organization_id = ? AND registry = ? AND scope = ? AND name = ?',
        )
        .get(orgId, 'hub', scope, name) as { id: number; version: string } | undefined;

      if (existing) {
        // Update version + manifest
        d.prepare(
          `UPDATE installed_widgets
           SET previous_version = version,
               previous_manifest_json = manifest_json,
               version = ?,
               bundle_url = ?,
               css_url = ?,
               manifest_json = ?,
               granted_capabilities_json = ?,
               latest_compatible_version = ?,
               latest_compatible_sdk = ?,
               yanked = 0
           WHERE id = ?`,
        ).run(
          ver,
          `/bundles/hub/${scope}/${name}/${ver}/bundle.js`,
          vEntry.cssUrl ? `/bundles/hub/${scope}/${name}/${ver}/bundle.css` : null,
          JSON.stringify(manifest),
          JSON.stringify(manifest.capabilities ?? []),
          ver,
          vEntry.sdkVersion,
          existing.id,
        );
        console.log(`[install] updated ${scope}/${name} to ${ver}`);
      } else {
        d.prepare(
          `INSERT INTO installed_widgets (
            organization_id, registry, scope, name, version,
            bundle_url, css_url, manifest_json, granted_capabilities_json,
            installed_at, yanked, denial_count, latest_compatible_version, latest_compatible_sdk
          ) VALUES (?, 'hub', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        ).run(
          orgId,
          scope,
          name,
          ver,
          `/bundles/hub/${scope}/${name}/${ver}/bundle.js`,
          vEntry.cssUrl ? `/bundles/hub/${scope}/${name}/${ver}/bundle.css` : null,
          JSON.stringify(manifest),
          JSON.stringify(manifest.capabilities ?? []),
          Math.floor(Date.now() / 1000),
          ver,
          vEntry.sdkVersion,
        );
        console.log(`[install] installed ${scope}/${name}@${ver}`);
      }

      // 7. Increment the hub download counter (fire-and-forget)
      try {
        await fetch(`${HUB_API}/${scope}/${name}`, { method: 'POST' });
      } catch {
        // Non-critical
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                installed: true,
                scope,
                name,
                version: ver,
                displayName: vEntry.displayName,
                bundleSize: vEntry.bundleSize,
                bundlePath,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    'search_widgets',
    {
      title: 'Search Widgets',
      description:
        'Search the GlassHome hub for available widgets. Returns name, display name, description, and latest version.',
      inputSchema: {
        query: z.string().optional().describe('Free-text search (matches name + description)'),
        scope: z.string().optional().describe('Restrict to a scope, e.g. "glasshome"'),
        limit: z.number().optional().describe('Max results (default 20, max 100)'),
      },
    },
    async ({ query, scope, limit }) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (scope) params.set('scope', scope);
      params.set('limit', String(limit ?? 20));

      const res = await fetch(`${HUB_API}/search?${params}`);
      if (!res.ok) {
        throw new Error(`Hub search failed: HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        widgets: Array<{
          scope: string;
          name: string;
          displayName: string;
          description: string | null;
          isOfficial: boolean | null;
          latestVersion?: { version: string; bundleSize: number } | null;
        }>;
        total: number;
      };

      const results = data.widgets.map((w) => ({
        scope: w.scope,
        name: w.name,
        display: w.displayName,
        description: w.description ?? '',
        official: w.isOfficial ?? false,
        version: w.latestVersion?.version ?? null,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ total: data.total, widgets: results }, null, 2),
          },
        ],
      };
    },
  );
}


