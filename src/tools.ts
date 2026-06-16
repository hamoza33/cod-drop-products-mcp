/**
 * MCP tool definitions for the COD Drop Products server.
 *
 * Tools:
 *  - cod_drop_fetch_products    : Paginate all marketplace products with filters
 *  - cod_drop_snapshot_today    : Fetch all products & store daily snapshot
 *  - cod_drop_best_sellers      : Compare two snapshot dates, rank by qty drop
 *  - cod_drop_get_product       : Single product detail
 *  - cod_drop_get_product_images: Fetch product images
 *  - cod_drop_snapshot_dates    : List stored snapshot dates
 *  - cod_drop_snapshot_data     : Retrieve stored snapshot for a given date
 */

import { z } from "zod";
import type { CodClient } from "./client.js";
import {
  compareDays,
  getSnapshotDates,
  getSnapshotsForDate,
  getSnapshotCount,
  getLatestTwoDates,
  type ProductSnapshot,
} from "./db.js";
import {
  paginateAll,
  MAX_PAGES,
  type MarketplaceProduct,
  type DropProduct,
} from "./marketplace.js";
import { runSnapshot } from "./snapshot.js";
import { productLink, stableImageUrl } from "./snapshot-files.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (input: unknown, client: CodClient) => Promise<unknown>;
}

interface TypedToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: S;
  handler: (input: z.infer<S>, client: CodClient) => Promise<unknown>;
}

function tool<S extends z.ZodTypeAny>(def: TypedToolDef<S>): ToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    handler: (input, client) => def.handler(input as z.infer<S>, client),
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/** Map common country abbreviations/names to ISO 2-letter codes. */
const COUNTRY_ALIASES: Record<string, string> = {
  ksa: "sa",
  "saudi arabia": "sa",
  "saudi": "sa",
  uae: "ae",
  "united arab emirates": "ae",
  emirates: "ae",
  kuwait: "kw",
  bahrain: "bh",
  qatar: "qa",
  oman: "om",
  jordan: "jo",
  egypt: "eg",
  iraq: "iq",
  morocco: "ma",
  tunisia: "tn",
  algeria: "dz",
  libya: "ly",
  lebanon: "lb",
  palestine: "ps",
  yemen: "ye",
  sudan: "sd",
  syria: "sy",
};

/**
 * Resolve a user-provided country string to its ISO 2-letter code.
 * Returns the lowercase input if no alias is found.
 */
function resolveCountryCode(input: string): string {
  const lower = input.toLowerCase().trim();
  return COUNTRY_ALIASES[lower] ?? lower;
}

/**
 * Check if a product matches the given country filter.
 * Tries ISO code match, full name match, and partial name match.
 */
function matchesCountry(
  productCountry: string,
  productCountryName: string,
  filterValue: string,
): boolean {
  const resolved = resolveCountryCode(filterValue);
  const pCode = productCountry.toLowerCase().trim();
  const pName = productCountryName.toLowerCase().trim();

  // Exact ISO code match
  if (pCode === resolved) return true;
  // Exact country name match
  if (pName === resolved) return true;
  // Original filter value matches name (for partial)
  const lower = filterValue.toLowerCase().trim();
  if (pName === lower) return true;
  if (pName.includes(lower) || lower.includes(pName)) return true;

  return false;
}

type SortField = "price_asc" | "price_desc" | "name_asc" | "name_desc";

function applyFilters(
  products: MarketplaceProduct[],
  filters: {
    country?: string;
    category?: string;
    in_stock?: boolean;
    available_for_drop?: boolean;
    min_price?: number;
    max_price?: number;
    search?: string;
    sort?: SortField;
  },
): MarketplaceProduct[] {
  let result = [...products];

  if (filters.country) {
    result = result.filter((p) =>
      matchesCountry(p.country, p.country_name, filters.country!),
    );
  }
  if (filters.category) {
    const cat = filters.category.toLowerCase();
    result = result.filter((p) => p.type.label.toLowerCase().includes(cat));
  }
  if (filters.in_stock !== undefined) {
    result = result.filter((p) => p.inStock === filters.in_stock);
  }
  if (filters.available_for_drop !== undefined) {
    result = result.filter((p) => p.available_for_drop === filters.available_for_drop);
  }
  if (filters.min_price !== undefined) {
    result = result.filter((p) => parseFloat(p.price) >= filters.min_price!);
  }
  if (filters.max_price !== undefined) {
    result = result.filter((p) => parseFloat(p.price) <= filters.max_price!);
  }
  if (filters.search) {
    const s = filters.search.toLowerCase();
    result = result.filter(
      (p) =>
        p.name.toLowerCase().includes(s) ||
        (p.sku && p.sku.toLowerCase().includes(s)),
    );
  }

  if (filters.sort) {
    switch (filters.sort) {
      case "price_asc":
        result.sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        break;
      case "price_desc":
        result.sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        break;
      case "name_asc":
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "name_desc":
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
    }
  }

  return result;
}


function marketplaceProductResponse(
  p: MarketplaceProduct,
  dropMatch?: DropProduct,
): Record<string, unknown> {
  const quantity = p.stocks?.data?.[0]?.quantity ?? dropMatch?.quantity ?? null;
  const project = p.stocks?.data?.[0]?.project?.data;
  return {
    id: p.id,
    product_id: p.id,
    name: p.name,
    sku: p.sku || null,
    slug: p.slug,
    description: p.description,
    country: p.country,
    country_name: p.country_name,
    cost: p.price,
    currency: p.currency,
    backup_price_currency: p.backup_price_currency,
    recommended_selling_price: p.recommended_selling_price,
    category: p.type.label,
    category_code: p.type.code,
    in_stock: p.inStock,
    available_for_drop: p.available_for_drop,
    available_for_sourcing: p.available_for_sourcing,
    is_pinned: p.is_pinned,
    is_dropped: p.is_dropped,
    is_favorite: p.is_favorite,
    image_url: p.image_url,
    image_preview_url: stableImageUrl(p.id, p.image_url),
    path_image: p.path_image,
    source_url: p.url,
    product_link: productLink(p.id),
    quantity,
    project_id: project?.id ?? null,
    project_name: project?.name ?? dropMatch?.project_name ?? null,
    drop_product: dropMatch ? {
      id: dropMatch.id,
      quantity: dropMatch.quantity,
      project_name: dropMatch.project_name,
      product_cost: dropMatch.product_cost,
      notes: dropMatch.notes,
      is_low_quantity: dropMatch.is_low_quantity,
      is_enabled: dropMatch.is_enabled,
      created_at: dropMatch.created_at,
      marketplace_status: dropMatch.marketplace_status,
      up_sell_and_backup_prices: dropMatch.up_sell_and_backup_prices,
    } : null,
  };
}

function snapshotProductResponse(s: ProductSnapshot): Record<string, unknown> {
  return {
    product_id: s.product_id,
    id: s.product_id,
    name: s.name,
    sku: s.sku || null,
    country: s.country,
    country_name: s.country_name,
    cost: s.cost,
    currency: s.currency,
    recommended_selling_price: s.recommended_selling_price,
    category: s.category,
    in_stock: Boolean(s.in_stock),
    available_for_drop: Boolean(s.available_for_drop),
    quantity: s.quantity,
    project_name: s.project_name,
    image_url: s.image_url,
    image_preview_url: stableImageUrl(s.product_id, s.image_url),
    product_link: productLink(s.product_id),
    snapshot_date: s.snapshot_date,
  };
}

/* -------------------------------------------------------------------------- */
/*  Tool: fetch marketplace products with filters                             */
/* -------------------------------------------------------------------------- */

const fetchProducts = tool({
  name: "cod_drop_fetch_products",
  description:
    "Fetch products from the COD Drop marketplace (all website products). " +
    "Paginates through all pages (API caps at 10/page). Supports client-side " +
    "filtering by country, category, price range, availability, and text search. " +
    "Returns up to `limit` results (default 50). Use `page` for paginated results.",
  inputSchema: z.object({
    country: z
      .string()
      .optional()
      .describe("Filter by country code or name (e.g. 'SA', 'KSA', 'ae', 'UAE'). Case-insensitive."),
    category: z
      .string()
      .optional()
      .describe("Filter by product category/type (e.g. 'Gadget', 'Beauty'). Case-insensitive substring."),
    in_stock: z
      .boolean()
      .optional()
      .describe("Filter by availability. true = in stock only, false = out of stock only."),
    available_for_drop: z
      .boolean()
      .optional()
      .describe("Filter by drop availability."),
    min_price: z.number().optional().describe("Minimum cost (USD)."),
    max_price: z.number().optional().describe("Maximum cost (USD)."),
    sort: z
      .enum(["price_asc", "price_desc", "name_asc", "name_desc"])
      .optional()
      .describe("Sort order for results."),
    search: z.string().optional().describe("Search by name or SKU (case-insensitive substring)."),
    limit: z.number().int().min(1).max(2000).optional().default(50).describe("Max products to return (default 50)."),
    offset: z.number().int().min(0).optional().default(0).describe("Skip this many results (for pagination)."),
    max_pages: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGES)
      .optional()
      .default(MAX_PAGES)
      .describe("Max API pages to scan (10 items/page). Default scans all."),
  }),
  handler: async (input, client) => {
    // Pass country as server-side filter if provided (reduces pages to scan)
    const marketplaceQuery: Record<string, string | number | boolean> = { include: "stocks.project" };
    const dropQuery: Record<string, string | number | boolean> = {};
    if (input.country) {
      const code = resolveCountryCode(input.country);
      marketplaceQuery.country = code;
      dropQuery.country = code;
    }

    const [{ items, totalPages, pagesScanned }, dropResult] = await Promise.all([
      paginateAll<MarketplaceProduct>(
        client,
        "/seller/marketplace/products",
        marketplaceQuery,
        input.max_pages ?? MAX_PAGES,
      ),
      paginateAll<DropProduct>(client, "/seller/drop-products", dropQuery),
    ]);

    const dropBySku = new Map<string, DropProduct>();
    const dropByName = new Map<string, DropProduct>();
    for (const dp of dropResult.items) {
      if (dp.sku) {
        dropBySku.set(dp.sku, dp);
      }
      dropByName.set(dp.name.toLowerCase(), dp);
    }

    const filtered = applyFilters(items, {
      country: input.country,
      category: input.category,
      in_stock: input.in_stock,
      available_for_drop: input.available_for_drop,
      min_price: input.min_price,
      max_price: input.max_price,
      search: input.search,
      sort: input.sort,
    });

    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    const page = filtered.slice(offset, offset + limit);

    return {
      total_fetched: items.length,
      total_filtered: filtered.length,
      returned: page.length,
      offset,
      limit,
      pages_scanned: pagesScanned,
      total_api_pages: totalPages,
      products: page.map((p) => {
        const dropMatch = (p.sku ? dropBySku.get(p.sku) : undefined) ?? dropByName.get(p.name.toLowerCase());
        return marketplaceProductResponse(p, dropMatch);
      }),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Tool: single product detail                                               */
/* -------------------------------------------------------------------------- */

const getProduct = tool({
  name: "cod_drop_get_product",
  description: "Get full details of a single COD Drop marketplace product by ID.",
  inputSchema: z.object({
    id: z.number().int().describe("Marketplace product ID."),
  }),
  handler: async (input, client) => {
    const resp = await client.request<{ data: MarketplaceProduct }>({
      path: `/seller/marketplace/products/${input.id}`,
      query: { include: "stocks.project" },
    });
    const p = resp.data;
    return marketplaceProductResponse(p);
  },
});

/* -------------------------------------------------------------------------- */
/*  Tool: product images                                                      */
/* -------------------------------------------------------------------------- */

const getProductImages = tool({
  name: "cod_drop_get_product_images",
  description:
    "Get image URLs for one or more COD Drop marketplace products. " +
    "If no IDs are provided, fetches images for all products (may be slow for large catalogs).",
  inputSchema: z.object({
    product_ids: z
      .array(z.number().int())
      .optional()
      .describe("Product IDs to get images for. If empty, fetches all."),
    search: z.string().optional().describe("Search by name to filter which products to get images for."),
    limit: z.number().int().min(1).max(500).optional().default(50).describe("Max products (default 50)."),
  }),
  handler: async (input, client) => {
    if (input.product_ids && input.product_ids.length > 0) {
      const results = await Promise.all(
        input.product_ids.map(async (id) => {
          try {
            const resp = await client.request<{ data: MarketplaceProduct }>({
              path: `/seller/marketplace/products/${id}`,
            });
            return {
              id: resp.data.id,
              name: resp.data.name,
              image_url: resp.data.image_url,
              image_preview_url: stableImageUrl(resp.data.id, resp.data.image_url),
              path_image: resp.data.path_image,
              product_link: productLink(resp.data.id),
            };
          } catch {
            return { id, name: null, image_url: null, path_image: null, error: "not found" };
          }
        }),
      );
      return { products: results };
    }

    const { items } = await paginateAll<MarketplaceProduct>(
      client,
      "/seller/marketplace/products",
      { include: "stocks.project" },
    );

    let filtered = items;
    if (input.search) {
      const s = input.search.toLowerCase();
      filtered = items.filter(
        (p) => p.name.toLowerCase().includes(s) || (p.sku && p.sku.toLowerCase().includes(s)),
      );
    }

    const limit = input.limit ?? 50;
    return {
      total: filtered.length,
      returned: Math.min(filtered.length, limit),
      products: filtered.slice(0, limit).map((p) => ({
        id: p.id,
        name: p.name,
        image_url: p.image_url,
        image_preview_url: stableImageUrl(p.id, p.image_url),
        path_image: p.path_image,
        product_link: productLink(p.id),
      })),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Tool: snapshot today — fetch all + store in DB + write public files       */
/* -------------------------------------------------------------------------- */

const snapshotToday = tool({
  name: "cod_drop_snapshot_today",
  description:
    "Fetch ALL marketplace products from COD Drop and store a daily snapshot in the database. " +
    "Also fetches the seller's own drop-products (which have quantity and warehouse info) and " +
    "cross-references them with marketplace products to enrich with quantity and project data. " +
    "Writes public JSON + Excel files (coddata{date}.json/.xlsx), updates the latest.* aliases, " +
    "and generates the day-over-day quantity-sold report vs the previous snapshot. " +
    "Call this once per day to build history for best-seller comparison. " +
    "Returns a summary of what was stored.",
  inputSchema: z.object({
    date: z
      .string()
      .optional()
      .describe("Override snapshot date (YYYY-MM-DD). Defaults to today UTC."),
  }),
  handler: async (input, client) => {
    return runSnapshot(client, input.date);
  },
});

/* -------------------------------------------------------------------------- */
/*  Tool: best sellers (daily comparison)                                     */
/* -------------------------------------------------------------------------- */

const bestSellers = tool({
  name: "cod_drop_best_sellers",
  description:
    "Compare product quantities between two snapshot dates to find best-selling products. " +
    "Best sellers = products whose quantity dropped the most (more sold). " +
    "If no dates specified, compares the two most recent snapshots. " +
    "You must call `cod_drop_snapshot_today` at least twice (on different days) before this works.",
  inputSchema: z.object({
    today_date: z
      .string()
      .optional()
      .describe("The newer date (YYYY-MM-DD). Defaults to the most recent snapshot."),
    yesterday_date: z
      .string()
      .optional()
      .describe("The older date (YYYY-MM-DD). Defaults to the second most recent snapshot."),
    country: z.string().optional().describe("Filter by country (case-insensitive)."),
    category: z.string().optional().describe("Filter by category (case-insensitive substring)."),
    limit: z.number().int().min(1).max(500).optional().default(20).describe("Max results (default 20)."),
  }),
  handler: async (input) => {
    let todayDate = input.today_date;
    let yesterdayDate = input.yesterday_date;

    if (!todayDate || !yesterdayDate) {
      const latest = getLatestTwoDates();
      if (!latest.today || !latest.yesterday) {
        return {
          error: "Not enough snapshots. Need at least 2 different dates. " +
            "Call `cod_drop_snapshot_today` on different days first.",
          available_dates: getSnapshotDates(),
        };
      }
      todayDate = todayDate ?? latest.today;
      yesterdayDate = yesterdayDate ?? latest.yesterday;
    }

    const todayCount = getSnapshotCount(todayDate);
    const yesterdayCount = getSnapshotCount(yesterdayDate);
    if (todayCount === 0 || yesterdayCount === 0) {
      return {
        error: `No snapshot data for one or both dates. today (${todayDate}): ${todayCount} products, yesterday (${yesterdayDate}): ${yesterdayCount} products.`,
        available_dates: getSnapshotDates(),
      };
    }

    let results = compareDays(todayDate, yesterdayDate);

    if (input.country) {
      results = results.filter((r) =>
        matchesCountry(r.country, r.country_name, input.country!),
      );
    }
    if (input.category) {
      const cat = input.category.toLowerCase();
      results = results.filter((r) => r.category.toLowerCase().includes(cat));
    }

    const limit = input.limit ?? 20;
    const top = results.slice(0, limit);

    return {
      comparison: { today: todayDate, yesterday: yesterdayDate },
      today_products: todayCount,
      yesterday_products: yesterdayCount,
      products_with_quantity_drop: results.length,
      top_best_sellers: top.map((r, i) => ({
        rank: i + 1,
        product_id: r.product_id,
        name: r.name,
        country: r.country,
        country_name: r.country_name,
        category: r.category,
        project_name: r.project_name,
        yesterday_quantity: r.yesterday_qty,
        today_quantity: r.today_qty,
        units_sold: r.qty_drop,
        image_url: r.image_url,
        image_preview_url: stableImageUrl(r.product_id, r.image_url),
        product_link: productLink(r.product_id),
      })),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Tool: list snapshot dates                                                 */
/* -------------------------------------------------------------------------- */

const snapshotDatesList = tool({
  name: "cod_drop_snapshot_dates",
  description:
    "List all stored snapshot dates (most recent first). " +
    "Use this to see what dates are available for comparison.",
  inputSchema: z.object({}),
  handler: async () => {
    const dates = getSnapshotDates();
    return {
      dates,
      count: dates.length,
      hint: dates.length < 2
        ? "Need at least 2 snapshot dates for best-seller comparison. Call cod_drop_snapshot_today daily."
        : `${dates.length} snapshots available. Latest: ${dates[0]}, oldest: ${dates[dates.length - 1]}.`,
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Tool: retrieve snapshot data                                              */
/* -------------------------------------------------------------------------- */

const snapshotData = tool({
  name: "cod_drop_snapshot_data",
  description:
    "Retrieve stored product snapshot data for a specific date. " +
    "Supports filtering and pagination. Useful to inspect what was captured on a given day.",
  inputSchema: z.object({
    date: z
      .string()
      .describe("Snapshot date (YYYY-MM-DD). Use cod_drop_snapshot_dates to list available dates."),
    country: z.string().optional().describe("Filter by country."),
    category: z.string().optional().describe("Filter by category."),
    in_stock: z.boolean().optional().describe("Filter by stock status."),
    search: z.string().optional().describe("Search by name (case-insensitive substring)."),
    sort: z
      .enum(["price_asc", "price_desc", "name_asc", "name_desc", "quantity_asc", "quantity_desc"])
      .optional()
      .describe("Sort order."),
    limit: z.number().int().min(1).max(2000).optional().default(50),
    offset: z.number().int().min(0).optional().default(0),
  }),
  handler: async (input) => {
    let snaps = getSnapshotsForDate(input.date);

    if (input.country) {
      snaps = snaps.filter((s) =>
        matchesCountry(s.country, s.country_name, input.country!),
      );
    }
    if (input.category) {
      const cat = input.category.toLowerCase();
      snaps = snaps.filter((s) => s.category.toLowerCase().includes(cat));
    }
    if (input.in_stock !== undefined) {
      snaps = snaps.filter((s) => Boolean(s.in_stock) === input.in_stock);
    }
    if (input.search) {
      const s = input.search.toLowerCase();
      snaps = snaps.filter((snap) => snap.name.toLowerCase().includes(s));
    }

    if (input.sort) {
      switch (input.sort) {
        case "price_asc":
          snaps.sort((a, b) => parseFloat(a.cost) - parseFloat(b.cost));
          break;
        case "price_desc":
          snaps.sort((a, b) => parseFloat(b.cost) - parseFloat(a.cost));
          break;
        case "name_asc":
          snaps.sort((a, b) => a.name.localeCompare(b.name));
          break;
        case "name_desc":
          snaps.sort((a, b) => b.name.localeCompare(a.name));
          break;
        case "quantity_asc":
          snaps.sort((a, b) => (a.quantity ?? 0) - (b.quantity ?? 0));
          break;
        case "quantity_desc":
          snaps.sort((a, b) => (b.quantity ?? 0) - (a.quantity ?? 0));
          break;
      }
    }

    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    const page = snaps.slice(offset, offset + limit);

    return {
      date: input.date,
      total: snaps.length,
      returned: page.length,
      offset,
      limit,
      products: page.map(snapshotProductResponse),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Export                                                                     */
/* -------------------------------------------------------------------------- */

export const tools: ReadonlyArray<ToolDef> = [
  fetchProducts,
  getProduct,
  getProductImages,
  snapshotToday,
  bestSellers,
  snapshotDatesList,
  snapshotData,
];
