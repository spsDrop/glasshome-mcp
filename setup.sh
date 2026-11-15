#!/usr/bin/env bash
set -euo pipefail

# glasshome-mcp setup — build, save, or deploy the MCP sidecar image.
#
# Usage:
#   ./setup.sh build              # build glasshome-mcp:latest
#   ./setup.sh save [file]        # build + save to tarball
#   ./setup.sh deploy <host>      # build, scp to host, docker load, restart
#   ./setup.sh tools              # list available MCP tools (requires running server)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="glasshome-mcp:latest"

cmd="${1:-help}"

case "$cmd" in
  build)
    echo "→ Building $IMAGE"
    cd "$SCRIPT_DIR"
    docker build -f Dockerfile.child -t "$IMAGE" .
    echo "✓ Done. Image: $IMAGE"
    ;;

  save)
    FILE="${2:-glasshome-mcp.tar.gz}"
    echo "→ Building + saving to $FILE"
    cd "$SCRIPT_DIR"
    docker build -f Dockerfile.child -t "$IMAGE" .
    docker save "$IMAGE" | gzip > "$FILE"
    echo "✓ Saved: $FILE ($(du -h "$FILE" | cut -f1))"
    ;;

  deploy)
    HOST="${2:?Usage: ./setup.sh deploy <host> [compose-file] [service] [port]}"
    COMPOSE="${3:-}"
    SERVICE="${4:-glasshome}"
    PORT="${5:-3900}"

    # Build + save
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    tarball="$tmp/glasshome-mcp.tar.gz"

    echo "→ Building"
    (cd "$SCRIPT_DIR" && docker build -f Dockerfile.child -t "$IMAGE" .)

    echo "→ Saving + transferring to $HOST"
    (cd "$SCRIPT_DIR" && docker save "$IMAGE" | gzip > "$tarball")
    scp "$tarball" "$HOST:glasshome-mcp.tar.gz"

    echo "→ Loading on $HOST"
    ssh "$HOST" "docker load < ~/glasshome-mcp.tar.gz"

    if [[ -n "$COMPOSE" ]]; then
      echo "→ Recreating service '$SERVICE' via $COMPOSE"
      ssh "$HOST" "docker compose -f $COMPOSE up -d $SERVICE"
    else
      echo "→ Restarting glasshome container"
      ssh "$HOST" "docker restart glasshome"
    fi

    echo "✓ Deployed. MCP at http://$HOST:$PORT/mcp"
    ;;

  tools)
    PORT="${2:-3900}"
    echo "→ Fetching tool list from localhost:$PORT"
    curl -s "http://localhost:$PORT/mcp" \
      -H 'content-type: application/json' \
      -H 'accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
      | python3 -c "
import sys, json
data = json.load(sys.stdin)
tools = data.get('result', {}).get('tools', [])
print(f'{len(tools)} tools:')
for t in tools:
    print(f'  {t[\"name\"]:25s} {t.get(\"description\", \"\")[:60]}')
"
    ;;

  help|*)
    grep '^#   ' "$0" | sed 's/^#   //'
    ;;
esac
