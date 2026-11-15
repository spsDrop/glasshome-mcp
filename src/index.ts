import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { GlassHomeDb } from './db.js';
import { HaClient } from './ha.js';
import { registerDashboardTools } from './tools/dashboards.js';
import { registerEntityTools } from './tools/entities.js';
import { registerInstallTools } from './tools/install.js';
import { registerWidgetTools } from './tools/widgets.js';

const SERVER_NAME = 'glasshome-mcp';
const SERVER_VERSION = '0.1.0';

/**
 * Boot the GlassHome MCP sidecar: MCP Streamable HTTP server (stateless,
 * one JSON response per POST /mcp) backed by Home Assistant (WebSocket +
 * REST) and GlassHome's SQLite database.
 */
function main(): void {
  const config = loadConfig();
  const db = new GlassHomeDb(config);
  const ha = new HaClient(config, db);
  const ctx = { config, db, ha };

  // Stateless mode: the SDK forbids reusing one stateless transport across
  // requests (message id collisions), so each POST gets a fresh
  // server + transport pair. Tool registration is cheap and everything
  // stateful (HA connection, DB handle, config) lives in the shared ctx.
  const handleMcpPost = (req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void => {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      {
        instructions:
          'Tools for a GlassHome dashboard: control Home Assistant entities (states, services, scripts, templates, areas) and manage GlassHome dashboards, widgets, and per-breakpoint layouts. Dashboard mutations are disabled when the server runs read-only (MCP_READONLY=true).',
      },
    );
    registerEntityTools(server, ctx);
    registerDashboardTools(server, ctx);
    registerInstallTools(server, ctx);
    registerWidgetTools(server, ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    server
      .connect(transport)
      .then(() => transport.handleRequest(req, res, body))
      .catch((error: unknown) => {
        console.error('[mcp] request failed:', error instanceof Error ? error.message : error);
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      })
      .finally(() => {
        res.on('close', () => {
          void transport.close();
          void server.close();
        });
      });
  };

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/mcp') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: unknown;
        try {
          body = raw === '' ? undefined : JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON body' }));
          return;
        }
        handleMcpPost(req, res, body);
      });
      req.on('error', (error: Error) => {
        console.error('[http] request stream error:', error.message);
        res.destroy();
      });
    } else if (req.method === 'GET' && url === '/health') {
      const body = {
        ok: true,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        ha: ha.status(),
        mcp_readonly: config.mcpReadonly,
        glasshome_db: db.opened ? 'open' : db.probe(),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body, null, 2));
    } else if (url === '/mcp' && (req.method === 'GET' || req.method === 'DELETE')) {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'MCP Streamable HTTP endpoint is stateless: use POST /mcp.' }));
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. POST /mcp (MCP), GET /health.' }));
    }
  });

  ha.start();
  httpServer.listen(config.mcpPort, () => {
    console.log(`[${SERVER_NAME}] MCP Streamable HTTP listening on http://0.0.0.0:${config.mcpPort}/mcp`);
    console.log(
      `[${SERVER_NAME}] HA ${ha.status().url || '(no URL)'} (token: ${ha.status().tokenSource}), ` +
        `data dir ${config.glasshomeDataDir}${config.mcpReadonly ? ' (read-only)' : ''}; glasshome db: ${db.probe()}`,
    );
  });

  const shutdown = (signal: string): void => {
    console.log(`[${SERVER_NAME}] ${signal} received, shutting down`);
    ha.stop();
    db.close();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
