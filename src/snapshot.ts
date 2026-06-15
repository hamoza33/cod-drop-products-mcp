/**
 * Snapshot orchestration: fetch + persist + write public files + generate the
 * day-over-day quantity-sold report. Shared by the MCP tool and the daily cron.
 */

import type { CodClient } from "./client.js";
import { buildSnapshots } from "./marketplace.js";
import {
  getSnapshotDates,
  getSnapshotsForDate,
  upsertSnapshots,
} from "./db.js";
import {
  computeQuantitySold,
  toFileProduct,
  updateLatestAliases,
  writeQuantitySoldFiles,
  writeSnapshotFiles,
} from "./snapshot-files.js";

export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

export type Logger = (...args: unknown[]) => void;
const noop: Logger = () => {};

export interface SnapshotResult {
  snapshot_date: string;
  total_products_stored: number;
  marketplace_pages_scanned: number;
  drop_products_scanned: number;
  products_with_quantity: number;
  in_stock_count: number;
  out_of_stock_count: number;
  countries: string[];
  categories: string[];
  quantity_sold_compared_to: string | null;
  quantity_sold_rows: number;
  files: {
    snapshot_json: string;
    snapshot_xlsx: string;
    quantity_sold_json: string | null;
    quantity_sold_xlsx: string | null;
  };
  summary: string;
}

// Serialize snapshot runs so a manual tool call and the cron never overlap.
let chain: Promise<unknown> = Promise.resolve();

export function runSnapshot(
  client: CodClient,
  date?: string,
  log: Logger = noop,
): Promise<SnapshotResult> {
  const run = chain.then(() => doRunSnapshot(client, date ?? todayUTC(), log));
  chain = run.catch(() => {});
  return run;
}

async function doRunSnapshot(
  client: CodClient,
  date: string,
  log: Logger,
): Promise<SnapshotResult> {
  log(`Building snapshot for ${date}…`);
  const { snapshots, marketplacePagesScanned, dropProductsScanned } =
    await buildSnapshots(client, date);

  upsertSnapshots(snapshots);
  log(`Stored ${snapshots.length} products for ${date}.`);

  // Full daily snapshot files (JSON + Excel).
  const fileProducts = snapshots
    .map(toFileProduct)
    .sort((a, b) => a.product_id - b.product_id);
  const snapFiles = await writeSnapshotFiles(date, fileProducts);

  // Quantity-sold diff vs the most recent earlier snapshot date.
  const prevDate = getSnapshotDates().find((d) => d < date) ?? null;
  let qsFiles: { json: string; xlsx: string } | null = null;
  let qsRows = 0;
  if (prevDate) {
    const todayRows = getSnapshotsForDate(date);
    const prevRows = getSnapshotsForDate(prevDate);
    const qs = computeQuantitySold(todayRows, prevRows).sort(
      (a, b) => a.product_id - b.product_id,
    );
    qsRows = qs.length;
    qsFiles = await writeQuantitySoldFiles(date, qs);
    log(`Wrote quantity-sold report (${qs.length} rows) vs ${prevDate}.`);
  } else {
    log(`No earlier snapshot than ${date}; skipping quantity-sold report.`);
  }

  updateLatestAliases(date);

  const countries = new Set(snapshots.map((s) => s.country_name));
  const categories = new Set(snapshots.map((s) => s.category));
  const inStockCount = snapshots.filter((s) => s.in_stock).length;
  const withQuantity = snapshots.filter((s) => s.quantity !== null);

  return {
    snapshot_date: date,
    total_products_stored: snapshots.length,
    marketplace_pages_scanned: marketplacePagesScanned,
    drop_products_scanned: dropProductsScanned,
    products_with_quantity: withQuantity.length,
    in_stock_count: inStockCount,
    out_of_stock_count: snapshots.length - inStockCount,
    countries: [...countries].sort(),
    categories: [...categories].sort(),
    quantity_sold_compared_to: prevDate,
    quantity_sold_rows: qsRows,
    files: {
      snapshot_json: snapFiles.json,
      snapshot_xlsx: snapFiles.xlsx,
      quantity_sold_json: qsFiles?.json ?? null,
      quantity_sold_xlsx: qsFiles?.xlsx ?? null,
    },
    summary:
      `Stored ${snapshots.length} products for ${date} ` +
      `(${withQuantity.length} with quantity). ` +
      (prevDate
        ? `Quantity-sold report generated vs ${prevDate} (${qsRows} rows).`
        : `No previous snapshot to diff against yet.`),
  };
}
