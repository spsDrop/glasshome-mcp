# GlassHome SQLite Schema Reference

Discovered from live GlassHome v1.4.5 instance (aria, Nov 14 2026).
DB: `/data/glasshome.sqlite` (WAL mode: `-shm` + `-wal` files).
ORM: Drizzle (migrations in `__drizzle_migrations`).

## Key Tables (MCP-relevant)

### dashboards
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | e.g. `d_b7d6f61e-a2d1-4f5c-8f99-cad61d4582c4` |
| user_id | TEXT FK→users | Owner |
| organization_id | TEXT FK→organization | Home/tenant |
| slug | TEXT | Unique per org, e.g. `main` |
| name | TEXT | Display name, e.g. `Home` |
| icon | TEXT | MDI icon or null |
| layouts | TEXT (JSON) | Per-breakpoint layout overrides (default `{}`) |
| area_id | TEXT | Optional HA area binding |
| is_visible_in_dock | INTEGER | 0/1 |
| dock_order | INTEGER | Sort order |
| created_at / updated_at | INTEGER | Unix epoch |

### widget_instances
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | UUID |
| organization_id | TEXT FK | |
| dashboard_id | TEXT FK→dashboards | Which dashboard |
| registry | TEXT | e.g. `hub` |
| scope | TEXT | e.g. `glasshome` |
| name | TEXT | Widget type: `light`, `weather`, `sensor`, etc. |
| config | TEXT (JSON) | Widget config (entity IDs, lamp type, etc.) |
| previous_config | TEXT (JSON) | Last config before update |
| created_at | INTEGER | |

### widget_placements
| Column | Type | Notes |
|--------|------|-------|
| instance_id | TEXT PK (composite) | FK→widget_instances |
| organization_id | TEXT PK (composite) | |
| breakpoint | TEXT PK (composite) | `sm`, `md`, `lg`, `xl` |
| x, y | INTEGER | Grid position |
| w, h | INTEGER | Grid size |

One row per widget per breakpoint. The `xl` breakpoint is auto-derived.

### installed_widgets
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| organization_id | TEXT FK | |
| registry | TEXT | `hub` = GlassHome's registry |
| scope | TEXT | `glasshome` = official |
| name | TEXT | Widget type name |
| version | TEXT | e.g. `1.0.1` |
| bundle_url | TEXT | e.g. `/bundles/hub/glasshome/light/1.0.1/bundle.js` |
| manifest_json | TEXT (JSON) | Full widget manifest (see below) |
| css_url | TEXT | e.g. `/bundles/hub/glasshome/light/1.0.1/bundle.css` |
| granted_capabilities_json | TEXT (JSON) | e.g. `[{"domain":"light","access":"control"}]` |
| latest_compatible_sdk | TEXT | e.g. `1.32.1` |

### manifest_json structure (from installed_widgets)
```json
{
  "scope": "glasshome",
  "name": "light",
  "version": "1.0.1",
  "displayName": "Light",
  "description": "Light control with brightness, color, and temperature",
  "icon": "mdi:lightbulb",
  "minSize": {"w": 1, "h": 1},
  "maxSize": {"w": 8, "h": 8},
  "sdkVersion": "^1.32.1",
  "configVersion": 1,
  "schema": { /* JSON Schema for widget config */ },
  "defaultConfig": {"entityIds": [], "lamp": "table"},
  "examples": [ /* sample configs for preview */ ]
}
```

### household_settings
| Column | Type | Notes |
|--------|------|-------|
| organization_id | TEXT PK | |
| hass_url_default | TEXT | HA base URL, e.g. `https://ha.aria` |
| active_theme_id | TEXT | e.g. `preset:midnight-glass` |
| main_dashboard_slug | TEXT | e.g. `main` |
| dock_mode | TEXT | `floating` |
| dev_mode | INTEGER | 0/1 |
| safe_mode | INTEGER | 0/1 |

### household_credentials
| Column | Type | Notes |
|--------|------|-------|
| organization_id | TEXT PK | |
| tunnel_token | TEXT | For tunneling (not HA token) |

## HA Token Location

The HA long-lived access token is NOT in `household_credentials` (that's for tunneling).
It's likely in the `account` table (OAuth tokens) or encrypted in a separate file
(`.auth-secret` at `/data/.auth-secret`, 64 bytes). The MCP sidecar will need its
own HA token (created by Jesse in HA: Settings → Users → Long-lived access tokens).

## MCP Tool → Table Mapping

| MCP Tool | Tables Touched |
|----------|---------------|
| `list_dashboards` | `dashboards` (SELECT) |
| `get_dashboard` | `dashboards` + `widget_instances` + `widget_placements` (JOIN) |
| `create_dashboard` | `dashboards` (INSERT) |
| `delete_dashboard` | `dashboards` (DELETE, cascades to widget_instances) |
| `add_widget` | `widget_instances` (INSERT) + `widget_placements` (INSERT × 4 breakpoints) |
| `remove_widget` | `widget_instances` (DELETE, cascades to widget_placements) |
| `update_widget` | `widget_instances` (UPDATE config) |
| `rearrange_layout` | `widget_placements` (UPDATE x,y,w,h per breakpoint) |
| `list_available_widgets` | `installed_widgets` (SELECT name, manifest_json) |
| `describe_widget_schema` | `installed_widgets` (SELECT manifest_json → parse schema) |

## Sample Data (from Jesse's instance)

1 dashboard (`main` / `Home`), 1 widget instance (light), 4 placements (one per breakpoint).
2 installed widgets: `weather` v1.0.0, `light` v1.0.1.
HA URL: `https://ha.aria`. Theme: `preset:midnight-glass`.
