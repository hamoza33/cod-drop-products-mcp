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
  upsertSnapshots,
  compareDays,
  getSnapshotDates,
  getSnapshotsForDate,
  getSnapshotCount,
  getLatestTwoDates,
  type ProductSnapshot,
} from "./db.js";

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
/*  API response types                                                        */
/* -------------------------------------------------------------------------- */

interface MarketplaceProduct {
  id: number;
  name: string;
  sku: string;
  slug: string;
  description: string;
  image_url: string;
  path_image: string;
  price: string;
  url: string;
  currency: string;
  backup_price_currency: string;
  type: { label: string; code: number };
  is_pinned: boolean;
  country: string;
  country_name: string;
  inStock: boolean;
  recommended_selling_price: string;
  available_for_sourcing: boolean;
  available_for_drop: boolean;
  is_favorite: boolean;
  is_dropped: boolean;
}

interface DropProduct {
  id: number;
  name: string;
  sku: string;
  product_cost: string;
  notes: string | null;
  currency: string;
  backup_price_currency: string;
  image: string;
  up_sell_and_backup_prices: Array<{
    quantity: string;
    price: string;
    backup_price: string | null;
    currency: string | null;
  }>;
  is_low_quantity: boolean;
  is_enabled: boolean;
  created_at: string;
  project_name: string;
  quantity: number;
  country_name: string;
  country_iso_code: string;
  marketplace_status: { label: string; code: number };
}

interface ListResponse<T> {
  data: T[];
  meta?: {
    pagination?: {
      total?: number;
      count?: number;
      per_page?: number;
      current_page?: number;
      total_pages?: number;
    };
  };
}

/* -------------------------------------------------------------------------- */
/*  Pagination engine                                                         */
/* -------------------------------------------------------------------------- */

const PAGE_CONCURRENCY = 5;
const MAX_PAGES = 300;

async function paginateAll<T>(
  client: CodClient,
  apiPath: string,
  extraQuery: Record<string, string | number | boolean> = {},
  maxPages: number = MAX_PAGES,
): Promise<{ items: T[]; totalPages: number; pagesScanned: number }> {
  const items: T[] = [];
  let page = 1;
  let knownTotalPages = Infinity;
  let pagesScanned = 0;

  while (page <= maxPages && page <= knownTotalPages) {
    const batchSize = Math.min(
      PAGE_CONCURRENCY,
      maxPages - page + 1,
      knownTotalPages - page + 1,
    );
    const pageNums = Array.from({ length: batchSize }, (_, i) => page + i);

    const responses = await Promise.all(
      pageNums.map((p) =>
        client.request<ListResponse<T>>({
          path: apiPath,
          query: { ...extraQuery, page: p, per_page: 10 },
        }),
      ),
    );

    for (const resp of responses) {
      pagesScanned++;
      const batch = resp.data ?? [];
      if (batch.length === 0) {
        knownTotalPages = 0;
        break;
      }
      items.push(...batch);
      const meta = resp.meta?.pagination;
      if (meta?.total_pages !== undefined && meta.total_pages < knownTotalPages) {
        knownTotalPages = meta.total_pages;
      }
    }

    page += pageNums.length;
  }

  return { items, totalPages: knownTotalPages === Infinity ? pagesScanned : knownTotalPages, pagesScanned };
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
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
    const c = filters.country.toLowerCase();
    result = result.filter(
      (p) =>
        p.country.toLowerCase() === c ||
        p.country_name.toLowerCase() === c,
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
    const [{ items, totalPages, pagesScanned }, dropResult] = await Promise.all([
      paginateAll<MarketplaceProduct>(
        client,
        "/seller/marketplace/products",
        {},
        input.max_pages ?? MAX_PAGES,
      ),
      paginateAll<DropProduct>(client, "/seller/drop-products"),
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
        return {
          id: p.id,
          name: p.name,
          sku: p.sku || null,
          country: p.country,
          country_name: p.country_name,
          cost: p.price,
          currency: p.currency,
          recommended_selling_price: p.recommended_selling_price,
          category: p.type.label,
          in_stock: p.inStock,
          available_for_drop: p.available_for_drop,
          is_pinned: p.is_pinned,
          is_dropped: p.is_dropped,
          image_url: p.image_url,
          quantity: dropMatch?.quantity ?? null,
          project_name: dropMatch?.project_name ?? null,
        };
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
    });
    const p = resp.data;
    return {
      id: p.id,
      name: p.name,
      sku: p.sku || null,
      slug: p.slug,
      description: p.description,
      country: p.country,
      country_name: p.country_name,
      cost: p.price,
      currency: p.currency,
      recommended_selling_price: p.recommended_selling_price,
      category: p.type.label,
      in_stock: p.inStock,
      available_for_drop: p.available_for_drop,
      available_for_sourcing: p.available_for_sourcing,
      is_pinned: p.is_pinned,
      is_dropped: p.is_dropped,
      is_favorite: p.is_favorite,
      image_url: p.image_url,
      source_url: p.url,
    };
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
              path_image: resp.data.path_image,
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
        path_image: p.path_image,
      })),
    };
  },
});

/* -------------------------------------------------------------------------- */
/*  Tool: snapshot today — fetch all + store in DB                             */
/* -------------------------------------------------------------------------- */

const snapshotToday = tool({
  name: "cod_drop_snapshot_today",
  description:
    "Fetch ALL marketplace products from COD Drop and store a daily snapshot in the database. " +
    "Also fetches the seller's own drop-products (which have quantity and warehouse info) and " +
    "cross-references them with marketplace products to enrich with quantity and project data. " +
    "Call this once per day to build history for best-seller comparison. " +
    "Returns a summary of what was stored.",
  inputSchema: z.object({
    date: z
      .string()
      .optional()
      .describe("Override snapshot date (YYYY-MM-DD). Defaults to today UTC."),
  }),
  handler: async (input, client) => {
    const date = input.date ?? todayUTC();

    const [marketplaceResult, dropResult] = await Promise.all([
      paginateAll<MarketplaceProduct>(client, "/seller/marketplace/products"),
      paginateAll<DropProduct>(client, "/seller/drop-products"),
    ]);

    const dropBySku = new Map<string, DropProduct>();
    const dropByName = new Map<string, DropProduct>();
    for (const dp of dropResult.items) {
      if (dp.sku) {
        dropBySku.set(dp.sku, dp);
      }
      dropByName.set(dp.name.toLowerCase(), dp);
    }

    const snapshots: ProductSnapshot[] = marketplaceResult.items.map((p) => {
      const dropMatch = (p.sku ? dropBySku.get(p.sku) : undefined) ?? dropByName.get(p.name.toLowerCase());
      return {
        product_id: p.id,
        name: p.name,
        sku: p.sku || "",
        country: p.country,
        country_name: p.country_name,
        cost: p.price,
        currency: p.currency,
        recommended_selling_price: p.recommended_selling_price,
        category: p.type.label,
        in_stock: p.inStock,
        available_for_drop: p.available_for_drop,
        image_url: p.image_url,
        quantity: dropMatch?.quantity ?? null,
        project_name: dropMatch?.project_name ?? null,
        snapshot_date: date,
      };
    });

    upsertSnapshots(snapshots);

    const countries = new Set(snapshots.map((s) => s.country_name));
    const categories = new Set(snapshots.map((s) => s.category));
    const inStockCount = snapshots.filter((s) => s.in_stock).length;
    const withQuantity = snapshots.filter((s) => s.quantity !== null);

    return {
      snapshot_date: date,
      total_products_stored: snapshots.length,
      marketplace_pages_scanned: marketplaceResult.pagesScanned,
      drop_products_scanned: dropResult.items.length,
      products_with_quantity: withQuantity.length,
      in_stock_count: inStockCount,
      out_of_stock_count: snapshots.length - inStockCount,
      countries: [...countries].sort(),
      categories: [...categories].sort(),
      summary: `Stored ${snapshots.length} products for ${date}. ` +
        `${withQuantity.length} have quantity data from drop-products.`,
    };
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
      const c = input.country.toLowerCase();
      results = results.filter(
        (r) =>
          r.country.toLowerCase() === c ||
          r.country_name.toLowerCase() === c,
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
      const c = input.country.toLowerCase();
      snaps = snaps.filter(
        (s) =>
          s.country.toLowerCase() === c ||
          s.country_name.toLowerCase() === c,
      );
    }
    if (input.category) {
      const cat = input.category.toLowerCase();
      snaps = snaps.filter((s) => s.category.toLowerCase().includes(cat));
    }
    if (input.in_stock !== undefined) {
      snaps = snaps.filter((s) => s.in_stock === input.in_stock);
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
      products: page.map((s) => ({
        product_id: s.product_id,
        name: s.name,
        sku: s.sku || null,
        country: s.country,
        country_name: s.country_name,
        cost: s.cost,
        currency: s.currency,
        recommended_selling_price: s.recommended_selling_price,
        category: s.category,
        in_stock: s.in_stock,
        available_for_drop: s.available_for_drop,
        quantity: s.quantity,
        project_name: s.project_name,
        image_url: s.image_url,
      })),
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
