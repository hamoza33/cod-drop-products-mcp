# cod-drop-products-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
**COD Network marketplace** ([COD Drop](https://seller.cod.network/cod-drop) —
"all website products" section).

It fetches every product from the marketplace catalog, stores daily snapshots,
and compares quantities across days to identify **best-selling products**.

## Tools

| Tool | Description |
| ---- | ----------- |
| `cod_drop_fetch_products` | Fetch all marketplace products with filtering (country, category, price, availability, search) and sorting |
| `cod_drop_get_product` | Get full details of a single marketplace product by ID |
| `cod_drop_get_product_images` | Fetch product images by ID(s) or search |
| `cod_drop_snapshot_today` | Fetch all products & store a daily snapshot (name, country, cost, recommended price, status, warehouse, quantity, reference) |
| `cod_drop_best_sellers` | Compare two snapshot dates to find best sellers by quantity drop |
| `cod_drop_snapshot_dates` | List available snapshot dates |
| `cod_drop_snapshot_data` | Retrieve stored snapshot data with filters |

### How daily comparison works

1. Call `cod_drop_snapshot_today` once per day.
2. The tool fetches all ~1,500 marketplace products and cross-references them
   with your drop-products (which carry quantity + warehouse data).
3. After at least 2 snapshots exist, call `cod_drop_best_sellers` to see which
   products had the biggest quantity drop — those are your best sellers.

## Public snapshot files (`/snapshots`)

In HTTP mode the server publishes daily snapshots as public, no-auth files and
lists them at `GET /snapshots` (newest first, grouped by date):

| File | Format | Description |
| ---- | ------ | ----------- |
| `coddata{YYYY-MM-DD}.json` | JSON | Full daily snapshot (every product, incl. `product_link`) |
| `coddata{YYYY-MM-DD}.xlsx` | Excel | Same data for humans; `image_url`/`product_link` are clickable hyperlinks |
| `coddataQuantitySold{YYYY-MM-DD}.json` | JSON | Day-over-day quantity-sold report |
| `coddataQuantitySold{YYYY-MM-DD}.xlsx` | Excel | Same report; `quantity_sold` shows `4`, `New 10`, `Removed 10`, or `Restock 10` |
| `latest.json` / `latest.xlsx` | — | Always alias the most recent `coddata` snapshot |

Each file is directly downloadable, e.g. `GET /snapshots/coddata2026-06-02.xlsx`
or `GET /snapshots/latest.json`. SQLite remains the source of truth for tool
responses; these files are output-only.

### Quantity-sold logic

For each product, comparing today vs. the previous snapshot:

- **Sold** — `quantity_sold = yesterday − today` (a number, e.g. `4`)
- **New** — present today but not yesterday → `"New {today}"`
- **Removed** — present yesterday but missing today → `"Removed {yesterday}"`
- **Restock** — today higher than yesterday → `"Restock {today − yesterday}"`

## Daily automation (cron)

The HTTP server runs an in-process scheduler that calls `cod_drop_snapshot_today`
automatically once per day at a fixed UTC time (with retry + logging), then
writes the files above. No external crontab is needed — `systemd`/Fly keeps the
process alive. Configure via `SNAPSHOT_CRON_UTC` (default `01:00`),
`SNAPSHOT_CRON_ATTEMPTS` (default `3`), or disable with `SNAPSHOT_CRON_DISABLED=1`.

## Authentication

Set the `COD_NETWORK_API_TOKEN` environment variable with your seller API token.

### How to get your token

1. Log in to [cod.network](https://cod.network).
2. Go to **My profile → API developer → API Token**.
3. Copy the token.

## Quick start (local stdio)

```bash
npm install
npm run build
COD_NETWORK_API_TOKEN=your-token node dist/server.js
```

## HTTP mode (for ChatGPT, Claude, etc.)

```bash
COD_NETWORK_API_TOKEN=your-token \
MCP_AUTH_TOKEN=$(openssl rand -base64 32) \
npm run start:http
```

The MCP endpoint is at `POST /mcp`.

## Deploy to Fly.io

```bash
fly launch --no-deploy
fly secrets set COD_NETWORK_API_TOKEN=your-token MCP_AUTH_TOKEN=$(openssl rand -base64 32)
fly volumes create cod_drop_data --size 1 --region cdg
fly deploy
```

## Environment variables

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `COD_NETWORK_API_TOKEN` | Yes | Bearer token for the COD Network seller API |
| `MCP_AUTH_TOKEN` | HTTP mode | Admin token for OAuth / direct Bearer auth |
| `DATA_DIR` | No | Directory for SQLite database (default: `.` or `/data` in Docker) |
| `PORT` | No | HTTP port (default: 8080) |
| `MCP_PUBLIC_URL` | No | Public URL for OAuth discovery |
| `SNAPSHOTS_DIR` | No | Directory for public snapshot files (default: `{DATA_DIR}/snapshots`) |
| `SNAPSHOT_CRON_UTC` | No | Daily snapshot time, `HH:MM` UTC (default: `01:00`) |
| `SNAPSHOT_CRON_ATTEMPTS` | No | Retry attempts on failure (default: `3`) |
| `SNAPSHOT_CRON_DISABLED` | No | Set to `1` to disable the daily scheduler |

## License

MIT
