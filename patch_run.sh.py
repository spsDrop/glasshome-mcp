#!/usr/bin/env python3
"""Patch /run.sh to start the MCP sidecar before the main server execs."""
with open('/run.sh', 'r') as f:
    content = f.read()

mcp_block = '''
# --- GlassHome MCP sidecar ---
if [ "${MCP_ENABLED:-true}" = "true" ]; then
  bashio::log.info "Starting GlassHome MCP sidecar on port ${MCP_PORT:-3900}..."
  MCP_PORT="${MCP_PORT:-3900}" \\
  HA_URL="${HA_URL:-}" \\
  HA_TOKEN="${HA_TOKEN:-}" \\
  GLASSHOME_DATA_DIR="${DATA_DIR:-/data}" \\
  MCP_READONLY="${MCP_READONLY:-false}" \\
  bun /app/apps/mcp-server/src/index.ts &
fi
'''

content = content.replace(
    'exec bun run apps/dash-server/dist/index.js',
    mcp_block + 'exec bun run apps/dash-server/dist/index.js'
)

with open('/run.sh', 'w') as f:
    f.write(content)
