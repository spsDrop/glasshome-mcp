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
GlassHome container (ghcr.io/glasshome/dash:beta)
├── dash-server     :3123  (Bun, s6-supervised)
├── glasshome-mcp   :3900  (Bun, MCP Streamable HTTP)
├── /data/glasshome.sqlite
└── /data/bundles/
         │
         ▼
  Home Assistant (HTTPS)
```

The MCP server is a child process started by `/run.sh` before the main dash-server execs. Both share the same SQLite DB and bundle directory — no volume sharing or sidecar containers.

## HA Auth

No separate `HA_TOKEN` env var needed. The MCP server reads HA URL + OAuth tokens directly from GlassHome's SQLite `account` table (`provider_id='hass'`). Tokens auto-refresh via `/auth/token`.

## Quick start

### 1. Deploy

```bash
./setup.sh deploy your-host /path/to/compose.yaml
```

Builds the image, transfers it, loads it, and recreates the GlassHome container. MCP is live at `http://your-host:3900/mcp`.

### 2. Update your compose file

In your existing GlassHome service, point the image at `glasshome-mcp:latest` and add port `3900`:

```yaml
services:
  glasshome:
    image: glasshome-mcp:latest   # was: ghcr.io/glasshome/dash:beta
    ports:
      - "3123:3123"               # GlassHome UI (existing)
      - "3900:3900"               # MCP sidecar (new)
```

No `HA_TOKEN` needed — the MCP reads HA URL + OAuth tokens from GlassHome's SQLite DB automatically.

### 3. Connect your MCP client

Point any MCP client at `http://<host>:3900/mcp`. The server speaks [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).

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
