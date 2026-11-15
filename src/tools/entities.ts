import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  errorResult,
  guardWritable,
  handler,
  jsonResult,
  type ToolContext,
} from './common.js';
import type { HassEntity, HassServiceTarget } from 'home-assistant-js-websocket';

/** Compact per-entity view returned by the entity tools. */
function summarize(state: HassEntity) {
  return {
    entity_id: state.entity_id,
    state: state.state,
    attributes: state.attributes,
    last_changed: state.last_changed,
    last_updated: state.last_updated,
  };
}

/** One HA area as returned by the REST API. */
interface HaArea {
  area_id: string;
  name: string;
  aliases: string[];
  floor_id?: string | null;
  labels?: Record<string, string>;
  icon?: string | null;
  created_at?: string;
  updated_at?: string;
}

const callServiceInput = z.object({
  domain: z.string().min(1).describe('Service domain, e.g. "light".'),
  service: z.string().min(1).describe('Service name, e.g. "turn_on".'),
  target: z
    .object({
      entity_id: z.union([z.string(), z.array(z.string())]).optional(),
      device_id: z.union([z.string(), z.array(z.string())]).optional(),
      area_id: z.union([z.string(), z.array(z.string())]).optional(),
      floor_id: z.union([z.string(), z.array(z.string())]).optional(),
      label_id: z.union([z.string(), z.array(z.string())]).optional(),
    })
    .optional()
    .describe('Target: entity_id / device_id / area_id / floor_id / label_id.'),
  data: z.record(z.unknown()).optional().describe('Service data, e.g. {"brightness": 255}.'),
  return_response: z.boolean().optional().describe('Ask HA for the service response when the service supports it.'),
});
type CallServiceArgs = z.infer<typeof callServiceInput>;

const executeScriptInput = z.object({
  sequence: z
    .array(z.record(z.unknown()))
    .min(1)
    .describe('Script steps, e.g. [{"service": "light.turn_on", "target": {"entity_id": "light.x"}, "data": {}}].'),
  variables: z.record(z.unknown()).optional().describe('Variables exposed to the script.'),
});
type ExecuteScriptArgs = z.infer<typeof executeScriptInput>;

const renderTemplateInput = z.object({
  template: z
    .string()
    .min(1)
    .describe('Jinja template, e.g. "{% if is_state(\'light.x\', \'on\') %}ON{% endif %}".'),
  variables: z.record(z.unknown()).optional().describe('Variables passed to the template.'),
  timeout: z.number().positive().max(15).optional().describe('Optional timeout in seconds for async templates.'),
});
type RenderTemplateArgs = z.infer<typeof renderTemplateInput>;

const getEntityStatesInput = z.object({
  entity_ids: z
    .array(z.string().min(1))
    .optional()
    .describe('Entity IDs like "light.living_room". Omit for all entities.'),
});
type GetEntityStatesArgs = z.infer<typeof getEntityStatesInput>;

const listEntitiesInput = z.object({
  domain: z.string().min(1).optional().describe('Domain filter, e.g. "light".'),
  area_id: z.string().min(1).optional().describe('HA area id filter.'),
});
type ListEntitiesArgs = z.infer<typeof listEntitiesInput>;

const getAreaInput = z.object({
  area_id: z.string().min(1).describe('HA area id, as returned by list_areas.'),
});
type GetAreaArgs = z.infer<typeof getAreaInput>;

/**
 * Register the entity / Home Assistant control tools.
 *
 * @param server MCP server to attach the tools to.
 * @param ctx Shared tool context (config, db, ha).
 */
export function registerEntityTools(server: McpServer, ctx: ToolContext): void {
  const { ha } = ctx;

  server.registerTool(
    'get_entity_states',
    {
      description:
        'Get the current state of one or more Home Assistant entities (state, attributes, last_changed). Omit entity_ids to list every entity the token can read.',
      inputSchema: getEntityStatesInput,
    },
    handler(async (raw) => {
      const { entity_ids } = raw as GetEntityStatesArgs;
      const states = await ha.getEntityStates();
      if (entity_ids === undefined || entity_ids.length === 0) {
        return jsonResult({ count: states.length, entities: states.map(summarize) });
      }
      const wanted = new Set(entity_ids);
      const found = states.filter((s) => wanted.has(s.entity_id)).map(summarize);
      const present = new Set(states.map((s) => s.entity_id));
      const missing = entity_ids.filter((id) => !present.has(id));
      return jsonResult({ requested: entity_ids.length, found: found.length, missing, entities: found });
    }),
  );

  server.registerTool(
    'list_entities',
    {
      description:
        'List Home Assistant entities, optionally filtered by domain (e.g. "light", "sensor") or by HA area id. Returns entity_id, state, area, and friendly name.',
      inputSchema: listEntitiesInput,
    },
    handler(async (raw) => {
      const { domain, area_id } = raw as ListEntitiesArgs;
      const states = await ha.getEntityStates();
      const entities = states
        .filter((s) => {
          if (domain !== undefined && s.entity_id.split('.')[0] !== domain) return false;
          if (area_id !== undefined && (s.attributes as Record<string, unknown>).area_id !== area_id) return false;
          return true;
        })
        .map((s) => ({
          entity_id: s.entity_id,
          domain: s.entity_id.split('.')[0],
          state: s.state,
          area_id: (s.attributes as Record<string, unknown>).area_id ?? null,
          friendly_name: (s.attributes as Record<string, unknown>).friendly_name ?? null,
        }));
      return jsonResult({ count: entities.length, entities });
    }),
  );

  server.registerTool(
    'call_service',
    {
      description:
        'Call a Home Assistant service (e.g. domain "light", service "turn_on") with an optional target and service data. Mutating: disabled when MCP_READONLY=true.',
      inputSchema: callServiceInput,
    },
    handler(async (raw) => {
      const { domain, service, target, data, return_response } = raw as CallServiceArgs;
      const denied = guardWritable(ctx.config);
      if (denied !== undefined) return denied;
      const result = await ha.callService(domain, service, data, target as HassServiceTarget | undefined, return_response);
      return jsonResult({ domain, service, target: target ?? null, data: data ?? null, ok: true, result: result ?? null });
    }),
  );

  server.registerTool(
    'list_areas',
    {
      description: 'List Home Assistant areas (name, aliases, floor) with the entity ids in each area.',
    },
    handler(async () => {
      const areas = await ha.rest<HaArea[]>('/areas');
      const members = await Promise.all(
        areas.map((a) =>
          ha.rest<string[]>(`/area_members/${encodeURIComponent(a.area_id)}`).catch(() => [] as string[]),
        ),
      );
      return jsonResult({
        count: areas.length,
        areas: areas.map((a, i) => ({ ...a, entity_ids: members[i], entity_count: members[i].length })),
      });
    }),
  );

  server.registerTool(
    'get_area',
    {
      description:
        'Get one Home Assistant area by area_id: area details, its entity ids, and the current state of each entity in it.',
      inputSchema: getAreaInput,
    },
    handler(async (raw) => {
      const { area_id } = raw as GetAreaArgs;
      const areas = await ha.rest<HaArea[]>('/areas');
      const area = areas.find((a) => a.area_id === area_id);
      if (area === undefined) {
        return errorResult(`Area "${area_id}" not found. Use list_areas to see available areas.`);
      }
      const memberIds = await ha
        .rest<string[]>(`/area_members/${encodeURIComponent(area_id)}`)
        .catch(() => [] as string[]);
      const wanted = new Set(memberIds);
      const states = await ha.getEntityStates();
      const entities = states.filter((s) => wanted.has(s.entity_id)).map(summarize);
      return jsonResult({ area: { ...area, entity_ids: memberIds }, entities });
    }),
  );

  server.registerTool(
    'execute_script',
    {
      description:
        'Run a Home Assistant script (a sequence of steps like service calls, waits, and template checks). Requires an admin token. Mutating: disabled when MCP_READONLY=true.',
      inputSchema: executeScriptInput,
    },
    handler(async (raw) => {
      const { sequence, variables } = raw as ExecuteScriptArgs;
      const denied = guardWritable(ctx.config);
      if (denied !== undefined) return denied;
      await ha.command({ type: 'execute_script', sequence, variables });
      return jsonResult({ executed: true, steps: sequence.length });
    }),
  );

  server.registerTool(
    'render_template',
    {
      description:
        'Render a Jinja template against live Home Assistant state and return the result (e.g. "{{ states.light.living_room.state }}").',
      inputSchema: renderTemplateInput,
    },
    handler(async (raw) => {
      const { template, variables, timeout } = raw as RenderTemplateArgs;
      const result = await ha.command<{ rendered: string; result_card: string | null }>({
        type: 'render_template',
        template,
        variables,
        timeout,
      });
      return jsonResult({ template, rendered: result.rendered });
    }),
  );
}
