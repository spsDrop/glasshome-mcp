#!/bin/sh
set -eu
# Patch /run.sh to start the MCP sidecar before the main server execs.
# POSIX sh — runs on Alpine (ash) without bash.

if grep -q "GlassHome MCP sidecar" /run.sh; then
  echo "/run.sh already patched"
  exit 0
fi

tmp=$(mktemp)
while IFS= read -r line; do
  if [ "$line" = "exec bun run apps/dash-server/dist/index.js" ]; then
    cat << 'MCP_BLOCK'

# --- GlassHome MCP sidecar ---
if [ "${MCP_ENABLED:-true}" = "true" ]; then
  echo "Starting GlassHome MCP sidecar on port ${MCP_PORT:-3900}..."
  MCP_PORT="${MCP_PORT:-3900}" \
  HA_URL="${HA_URL:-}" \
  HA_TOKEN="${HA_TOKEN:-}" \
  GLASSHOME_DATA_DIR="${DATA_DIR:-/data}" \
  MCP_READONLY="${MCP_READONLY:-false}" \
  bun /app/apps/mcp-server/src/index.ts &
fi
MCP_BLOCK
  fi
  printf '%s\n' "$line"
done < /run.sh > "$tmp"

mv "$tmp" /run.sh
echo "Patched /run.sh"
