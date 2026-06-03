/**
 * COD Drop marketplace API types, pagination engine, and the snapshot builder.
 *
 * Extracted here (out of tools.ts) so both the MCP tools and the standalone
 * daily scheduler can build snapshots without importing each other.
 */

import type { CodClient } from "./client.js";
import type { ProductSnapshot } from "./db.js";

/* -------------------------------------------------------------------------- */
/*  API response types                                                        */
/* -------------------------------------------------------------------------- */

export interface MarketplaceProduct {
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
  stocks?: {
    data: Array<{
      id: number;
      quantity: number;
      product_sku: string;
      project: {
        data: {
          id: number;
          name: string;
        };
      };
    }>;
  };
}

export interface DropProduct {
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

export interface ListResponse<T> {
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

export const PAGE_CONCURRENCY = 5;
export const MAX_PAGES = 300;

export async function paginateAll<T>(
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

  return {
    items,
    totalPages: knownTotalPages === Infinity ? pagesScanned : knownTotalPages,
    pagesScanned,
  };
}

/* -------------------------------------------------------------------------- */
/*  Snapshot builder                                                          */
/* -------------------------------------------------------------------------- */

export interface BuiltSnapshots {
  snapshots: ProductSnapshot[];
  marketplacePagesScanned: number;
  dropProductsScanned: number;
}

/**
 * Fetch ALL marketplace products and the seller's drop-products, cross-reference
 * them to enrich quantity/project data, and return the per-product snapshots for
 * the given date (not yet persisted).
 */
export async function buildSnapshots(
  client: CodClient,
  date: string,
): Promise<BuiltSnapshots> {
  const [marketplaceResult, dropResult] = await Promise.all([
    paginateAll<MarketplaceProduct>(client, "/seller/marketplace/products", {
      include: "stocks.project",
    }),
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
    const dropMatch =
      (p.sku ? dropBySku.get(p.sku) : undefined) ??
      dropByName.get(p.name.toLowerCase());
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
      quantity: p.stocks?.data?.[0]?.quantity ?? dropMatch?.quantity ?? null,
      project_name:
        p.stocks?.data?.[0]?.project?.data?.name ?? dropMatch?.project_name ?? null,
      snapshot_date: date,
    };
  });

  return {
    snapshots,
    marketplacePagesScanned: marketplaceResult.pagesScanned,
    dropProductsScanned: dropResult.items.length,
  };
}
