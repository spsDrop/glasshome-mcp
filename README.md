# glasshome-mcp

MCP sidecar for [GlassHome](https://glasshome.app): exposes GlassHome's SQLite database and Home Assistant entity control as [Model Context Protocol](https://modelcontextprotocol.io/) tools. Runs inside the existing GlassHome container — no separate container, no extra env vars.

## What it does

Any MCP-compatible LLM client (Hermes Agent, Claude Desktop, etc.) can:

- **Read HA entities** — list, filter, and get states for any entity
- **Control HA entities** — turn lights on/off, adjust climate, activate scenes
- **Edit dashboards** — add/remove/rearrange widgets, create dashboards
- **Install widgets** — download from the GlassHome Hub API, cache bundles, register in DB
- **Query the GlassHome DB** — dashboards, widgets, accounts, settings

## Architecture

```
┌─────────────────────────────────────────────┐
│  GlassHome container                        │
│  ┌─────────────────┐  ┌──────────────────┐  │
│  │  dash-server    │  │  glasshome-mcp   │  │
│  │  (Bun, s6)     │  │  (Bun, :3900)   │  │
│  │  port 3123     │  │  MCP Stream HTTP │  │
│  └────────┬────────┘  └───────┬──────────┘  │
│           │                    │              │
│           └──────┬─────────────┘              │
│                  │                            │
│          /data/glasshome.sqlite               │
│          /data/bundles/                       │
└──────────────────┬────────────────────────────┘
                   │
         Home Assistant (HTTPS)
```

The MCP server is a child process started by `/run.sh` before the main dash-server execs. Both share the same SQLite DB and bundle directory.

## HA Auth

No separate `HA_TOKEN` env var needed. The MCP server reads HA URL + OAuth tokens directly from GlassHome's SQLite `account` table (`provider_id='hass'`). Tokens auto-refresh via `/auth/token`.

## Quick start

### 1. Build the image

```bash
cd glasshome-mcp
./setup.sh build
```

### 2. Deploy to your GlassHome host

```bash
# Save + transfer
./setup.sh save glasshome-mcp.tar.gz
scp glasshome-mcp.tar.gz your-host:~/

# Load + recreate on the host
ssh your-host 'docker load < ~/glasshome-mcp.tar.gz &&
  docker compose -f /path/to/compose.yaml up -d glasshome'
```

### 3. Update your compose file

In your existing GlassHome service (the one running `ghcr.io/glasshome/dash:beta`):

```yaml
services:
  glasshome:
    image: glasshome-mcp:latest   # was: ghcr.io/glasshome/dash:beta
    ports:
      - "3123:3123"               # GlassHome UI (existing)
      - "3900:3900"               # MCP sidecar (new)
    # No HA_TOKEN needed — reads from GlassHome DB
```

### 4. Connect your MCP client

Point any MCP client at `http://<host>:3900/mcp`. The server speaks MCP Streamable HTTP.

## Tools (20)

| Category | Tools |
|----------|-------|
| **Entities** (7) | `list_entities`, `get_entity_states`, `set_entity_state`, `get_entity`, `list_areas`, `call_service`, `get_device_info` |
| **Dashboards** (4) | `get_dashboard`, `get_dashboard_summary`, `create_dashboard`, `delete_dashboard` |
| **Widgets** (7) | `add_widget`, `remove_widget`, `update_widget`, `move_widget`, `list_widgets`, `describe_widget_schema`, `get_widget` |
| **Install** (2) | `install_widget`, `search_widgets` |

## Requirements

- GlassHome container (`ghcr.io/glasshome/dash:beta` or later)
- Docker on the host
- HA URL reachable from the container (auto-detected from `household_settings.hass_url_default`)

## License

[MIT](LICENSE)
