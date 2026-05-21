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

## License

MIT
