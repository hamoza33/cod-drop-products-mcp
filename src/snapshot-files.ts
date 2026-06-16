/**
 * Public snapshot artifacts written to disk and served at /snapshots.
 *
 * SQLite remains the source of truth for tool responses and comparisons; these
 * files are output-only for human/public consumption:
 *   - coddata{YYYY-MM-DD}.json / .xlsx              full daily snapshot
 *   - coddataQuantitySold{YYYY-MM-DD}.json / .xlsx  day-over-day diff
 *   - latest.json / latest.xlsx                     aliases of the newest snapshot
 */

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import sharp from "sharp";

import type { ProductSnapshot } from "./db.js";

const DATA_DIR = process.env.DATA_DIR ?? ".";

const LINK_FONT = { color: { argb: "FF0563C1" }, underline: true } as const;
const SECTION_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2F0D9" } } as const;
const SECTION_FONT = { bold: true, size: 13, color: { argb: "FF375623" } } as const;
const IMAGE_ROW_HEIGHT = 44;
const IMAGE_WIDTH = 44;
const IMAGE_HEIGHT = 44;
const IMAGE_FETCH_CONCURRENCY = 6;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const COUNTRY_COLORS = [
  "FFFFE699",
  "FFD9EAD3",
  "FFCFE2F3",
  "FFF4CCCC",
  "FFD9D2E9",
  "FFFFD966",
  "FFB6D7A8",
  "FFA4C2F4",
  "FFEA9999",
  "FFB4A7D6",
  "FFFFC000",
  "FF93C47D",
  "FF6FA8DC",
  "FFE06666",
  "FF8E7CC3",
] as const;

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] :
    hp < 2 ? [x, c, 0] :
    hp < 3 ? [0, c, x] :
    hp < 4 ? [0, x, c] :
    hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return [r1 + m, g1 + m, b1 + m].map((v) => Math.round(v * 255)) as [number, number, number];
}

function generatedCountryColor(index: number): string {
  if (index < COUNTRY_COLORS.length) return COUNTRY_COLORS[index];
  const hue = (index * 137.508) % 360;
  const [r, g, b] = hslToRgb(hue, 0.55, 0.82);
  return `FF${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function countryColorMap(countries: string[]): Map<string, string> {
  const unique = [...new Set(countries.filter(Boolean))].sort();
  return new Map(unique.map((country, index) => [country, generatedCountryColor(index)]));
}


/** Directory where public snapshot files live. */
export function snapshotsDir(): string {
  return process.env.SNAPSHOTS_DIR ?? path.join(DATA_DIR, "snapshots");
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Public seller page for a marketplace product. */
export function productLink(productId: number | string): string {
  return `https://seller.cod.network/cod-drop/${productId}/show`;
}

function setHyperlink(cell: ExcelJS.Cell, url: string | null | undefined): void {
  if (!url) return;
  cell.value = { text: url, hyperlink: url };
  cell.font = { ...LINK_FONT };
}

function publicBaseUrl(): string | null {
  const raw = process.env.MCP_PUBLIC_URL;
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function stableImageUrl(productId: number | string, fallbackUrl: string): string {
  const base = publicBaseUrl();
  if (!base) return fallbackUrl;
  return `${base}/snapshots/images/${encodeURIComponent(String(productId))}`;
}

function setImagePlaceholder(cell: ExcelJS.Cell, url: string | null | undefined): void {
  if (!url) return;
  cell.value = { text: "Image", hyperlink: url, tooltip: url };
  cell.font = { ...LINK_FONT, bold: true };
  cell.alignment = { horizontal: "center", vertical: "middle" };
}

function styleCountryCell(
  cell: ExcelJS.Cell,
  country: string,
  colors: Map<string, string>,
): void {
  if (!country) return;
  cell.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: colors.get(country) ?? generatedCountryColor(0) },
  };
  cell.font = { bold: true, color: { argb: "FF000000" } };
  cell.alignment = { horizontal: "center" };
}

function addSectionRow(ws: ExcelJS.Worksheet, title: string): void {
  const row = ws.addRow([title]);
  row.font = { ...SECTION_FONT };
  row.fill = { ...SECTION_FILL };
  ws.mergeCells(row.number, 1, row.number, ws.columnCount);
}


/* -------------------------------------------------------------------------- */
/*  Daily snapshot files                                                      */
/* -------------------------------------------------------------------------- */

interface FetchedThumbnail {
  base64: string;
}

async function fetchThumbnail(url: string): Promise<FetchedThumbnail | null> {
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) return null;
    const input = Buffer.from(await res.arrayBuffer());
    const thumbnail = await sharp(input, { limitInputPixels: 30_000_000 })
      .resize(IMAGE_WIDTH, IMAGE_HEIGHT, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 35, mozjpeg: true })
      .toBuffer();
    return { base64: thumbnail.toString("base64") };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchThumbnailsByUrl(urls: string[]): Promise<Map<string, FetchedThumbnail>> {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  const thumbnails = new Map<string, FetchedThumbnail>();
  let next = 0;

  async function worker(): Promise<void> {
    while (next < uniqueUrls.length) {
      const url = uniqueUrls[next++];
      const thumbnail = await fetchThumbnail(url);
      if (thumbnail) thumbnails.set(url, thumbnail);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(IMAGE_FETCH_CONCURRENCY, uniqueUrls.length) }, () =>
      worker(),
    ),
  );
  return thumbnails;
}

function addThumbnailToCell(
  wb: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  thumbnail: FetchedThumbnail | undefined,
  rowNumber: number,
  columnNumber: number,
): void {
  if (!thumbnail) return;
  const imageId = wb.addImage({ base64: thumbnail.base64, extension: "jpeg" });
  ws.addImage(imageId, {
    tl: { col: columnNumber - 1 + 0.15, row: rowNumber - 1 + 0.15 },
    ext: { width: IMAGE_WIDTH, height: IMAGE_HEIGHT },
    editAs: "oneCell",
  });
}

export interface SnapshotFileProduct {
  product_id: number;
  name: string;
  sku: string | null;
  country: string;
  country_name: string;
  cost: string;
  currency: string;
  recommended_selling_price: string;
  category: string;
  in_stock: boolean;
  available_for_drop: boolean;
  quantity: number | null;
  project_name: string | null;
  image_url: string;
  product_link: string;
}

export function toFileProduct(s: ProductSnapshot): SnapshotFileProduct {
  return {
    product_id: s.product_id,
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
    product_link: productLink(s.product_id),
  };
}

export async function writeSnapshotFiles(
  date: string,
  products: SnapshotFileProduct[],
): Promise<{ json: string; xlsx: string }> {
  const dir = snapshotsDir();
  ensureDir(dir);
  const jsonPath = path.join(dir, `coddata${date}.json`);
  const xlsxPath = path.join(dir, `coddata${date}.xlsx`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        snapshot_date: date,
        generated_at: new Date().toISOString(),
        count: products.length,
        products,
      },
      null,
      2,
    ),
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("products");
  const countryColors = countryColorMap(products.map((p) => p.country));
  const thumbnails = await fetchThumbnailsByUrl(products.map((p) => p.image_url));

  ws.columns = [
    { header: "product_id", key: "product_id", width: 12 },
    { header: "name", key: "name", width: 40 },
    { header: "country", key: "country", width: 10 },
    { header: "category", key: "category", width: 18 },
    { header: "cost", key: "cost", width: 10 },
    { header: "quantity", key: "quantity", width: 10 },
    { header: "image_url", key: "image_url", width: 40 },
    { header: "product_link", key: "product_link", width: 50 },
    { header: "image", key: "image", width: 10 },
    { header: "country_name", key: "country_name", width: 16 },
    { header: "currency", key: "currency", width: 10 },
    { header: "recommended_selling_price", key: "recommended_selling_price", width: 16 },
    { header: "in_stock", key: "in_stock", width: 10 },
    { header: "available_for_drop", key: "available_for_drop", width: 16 },
    { header: "project_name", key: "project_name", width: 20 },
  ];
  for (const p of products) {
    const row = ws.addRow({
      product_id: p.product_id,
      name: p.name,
      country: p.country,
      country_name: p.country_name,
      category: p.category,
      cost: p.cost,
      currency: p.currency,
      recommended_selling_price: p.recommended_selling_price,
      in_stock: p.in_stock,
      available_for_drop: p.available_for_drop,
      quantity: p.quantity ?? "",
      project_name: p.project_name ?? "",
    });
    setHyperlink(row.getCell("image_url"), p.image_url);
    setHyperlink(row.getCell("product_link"), p.product_link);
    const imageUrl = stableImageUrl(p.product_id, p.image_url);
    setImagePlaceholder(row.getCell("image"), imageUrl);
    addThumbnailToCell(wb, ws, thumbnails.get(p.image_url), row.number, 9);
    styleCountryCell(row.getCell("country"), p.country, countryColors);
    row.height = IMAGE_ROW_HEIGHT;
  }
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  await wb.xlsx.writeFile(xlsxPath);

  return { json: jsonPath, xlsx: xlsxPath };
}

/* -------------------------------------------------------------------------- */
/*  Quantity-sold (day-over-day diff) files                                   */
/* -------------------------------------------------------------------------- */

export type QuantitySoldValue = number | string;

export interface QuantitySoldRow {
  product_id: number;
  name: string;
  country: string;
  quantity_yesterday: number;
  quantity_today: number;
  quantity_sold: QuantitySoldValue;
  image_url: string;
  product_link: string;
}

function qsRow(
  s: ProductSnapshot,
  qy: number,
  qt: number,
  sold: QuantitySoldValue,
): QuantitySoldRow {
  return {
    product_id: s.product_id,
    name: s.name,
    country: s.country,
    quantity_yesterday: qy,
    quantity_today: qt,
    quantity_sold: sold,
    image_url: s.image_url,
    product_link: productLink(s.product_id),
  };
}

/**
 * Compare today's snapshot against the previous day's:
 *   - sold normally          -> quantity_sold = yesterday - today (number)
 *   - present today only      -> "New {today}"
 *   - present yesterday only  -> "Removed {yesterday}"
 *   - today higher than yest. -> "Restock {today - yesterday}"
 */
export function computeQuantitySold(
  today: ProductSnapshot[],
  yesterday: ProductSnapshot[],
): QuantitySoldRow[] {
  const yById = new Map<number, ProductSnapshot>();
  for (const y of yesterday) yById.set(y.product_id, y);
  const tIds = new Set<number>(today.map((t) => t.product_id));

  const rows: QuantitySoldRow[] = [];

  for (const t of today) {
    const qt = t.quantity ?? 0;
    const y = yById.get(t.product_id);
    if (!y) {
      rows.push(qsRow(t, 0, qt, `New ${qt}`));
      continue;
    }
    const qy = y.quantity ?? 0;
    const diff = qy - qt;
    let sold: QuantitySoldValue;
    if (diff > 0) sold = diff;
    else if (diff < 0) sold = `Restock ${qt - qy}`;
    else sold = 0;
    rows.push(qsRow(t, qy, qt, sold));
  }

  for (const y of yesterday) {
    if (tIds.has(y.product_id)) continue;
    const qy = y.quantity ?? 0;
    rows.push(qsRow(y, qy, 0, `Removed ${qy}`));
  }

  return rows;
}

function prefixedQuantity(value: QuantitySoldValue, prefix: string): number {
  if (typeof value !== "string") return 0;
  const match = new RegExp(`^${prefix}\\s+(\\d+)`).exec(value);
  return match ? Number(match[1]) : 0;
}

function soldQuantity(value: QuantitySoldValue): number {
  return typeof value === "number" && value > 0 ? value : 0;
}

function categorizeQuantityRows(rows: QuantitySoldRow[]): Array<[string, QuantitySoldRow[]]> {
  const newlyAdded = rows
    .filter((r) => typeof r.quantity_sold === "string" && r.quantity_sold.startsWith("New "))
    .sort((a, b) => prefixedQuantity(b.quantity_sold, "New") - prefixedQuantity(a.quantity_sold, "New"));
  const removed = rows
    .filter((r) => typeof r.quantity_sold === "string" && r.quantity_sold.startsWith("Removed "))
    .sort((a, b) => prefixedQuantity(b.quantity_sold, "Removed") - prefixedQuantity(a.quantity_sold, "Removed"));
  const sold = rows
    .filter((r) => soldQuantity(r.quantity_sold) > 0)
    .sort((a, b) => soldQuantity(b.quantity_sold) - soldQuantity(a.quantity_sold));
  return [
    ["Newly added items — sorted by current quantity", newlyAdded],
    ["Removed items", removed],
    ["Sold items — sorted by quantity sold", sold],
  ];
}


export async function writeQuantitySoldFiles(
  date: string,
  rows: QuantitySoldRow[],
): Promise<{ json: string; xlsx: string }> {
  const dir = snapshotsDir();
  ensureDir(dir);
  const jsonPath = path.join(dir, `coddataQuantitySold${date}.json`);
  const xlsxPath = path.join(dir, `coddataQuantitySold${date}.xlsx`);

  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        date,
        generated_at: new Date().toISOString(),
        count: rows.length,
        products: rows,
      },
      null,
      2,
    ),
  );

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("quantity_sold");
  const countryColors = countryColorMap(rows.map((r) => r.country));
  const thumbnails = await fetchThumbnailsByUrl(rows.map((r) => r.image_url));

  ws.columns = [
    { header: "product_id", key: "product_id", width: 12 },
    { header: "name", key: "name", width: 40 },
    { header: "country", key: "country", width: 10 },
    { header: "quantity_yesterday", key: "quantity_yesterday", width: 18 },
    { header: "quantity_today", key: "quantity_today", width: 16 },
    { header: "quantity_sold", key: "quantity_sold", width: 16 },
    { header: "image_url", key: "image_url", width: 40 },
    { header: "product_link", key: "product_link", width: 50 },
    { header: "image", key: "image", width: 10 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } };

  for (const [title, sectionRows] of categorizeQuantityRows(rows)) {
    addSectionRow(ws, `${title} (${sectionRows.length})`);
    for (const r of sectionRows) {
      const row = ws.addRow({
        product_id: r.product_id,
        name: r.name,
        country: r.country,
        quantity_yesterday: r.quantity_yesterday,
        quantity_today: r.quantity_today,
        quantity_sold: r.quantity_sold,
      });
      setHyperlink(row.getCell("image_url"), r.image_url);
      setHyperlink(row.getCell("product_link"), r.product_link);
      const imageUrl = stableImageUrl(r.product_id, r.image_url);
      setImagePlaceholder(row.getCell("image"), imageUrl);
      addThumbnailToCell(wb, ws, thumbnails.get(r.image_url), row.number, 9);
      styleCountryCell(row.getCell("country"), r.country, countryColors);
      row.height = IMAGE_ROW_HEIGHT;
    }
  }

  ws.views = [{ state: "frozen", ySplit: 1 }];
  await wb.xlsx.writeFile(xlsxPath);

  return { json: jsonPath, xlsx: xlsxPath };
}

/** Copy the given date's snapshot files to latest.json / latest.xlsx. */
export function updateLatestAliases(date: string): void {
  const dir = snapshotsDir();
  const pairs: Array<[string, string]> = [
    [`coddata${date}.json`, "latest.json"],
    [`coddata${date}.xlsx`, "latest.xlsx"],
  ];
  for (const [src, dst] of pairs) {
    const from = path.join(dir, src);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, dst));
  }
}

/* -------------------------------------------------------------------------- */
/*  Listing page                                                              */
/* -------------------------------------------------------------------------- */

export interface SnapshotFileEntry {
  filename: string;
  size: number;
  mtime: string;
}

export function listSnapshotFiles(): SnapshotFileEntry[] {
  const dir = snapshotsDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(json|xlsx)$/i.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return {
        filename: f,
        size: st.size,
        mtime: st.mtime.toISOString(),
      };
    });
}

function fileRank(name: string): number {
  if (/^coddataQuantitySold.*\.xlsx$/i.test(name)) return 0;
  if (/^coddataQuantitySold.*\.json$/i.test(name)) return 1;
  if (/^coddata.*\.xlsx$/i.test(name)) return 2;
  if (/^coddata.*\.json$/i.test(name)) return 3;
  return 4;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Render the public /snapshots index page (files grouped by date, newest first). */
export function renderSnapshotsIndexHtml(basePath = "/snapshots"): string {
  const files = listSnapshotFiles();
  const base = basePath.replace(/\/+$/, "");

  const latest = files
    .filter((f) => /^latest\.(json|xlsx)$/i.test(f.filename))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  const dated = files.filter((f) => !/^latest\./i.test(f.filename));

  const byDate = new Map<string, SnapshotFileEntry[]>();
  for (const f of dated) {
    const m = /(\d{4}-\d{2}-\d{2})/.exec(f.filename);
    const key = m ? m[1] : "other";
    const arr = byDate.get(key) ?? [];
    arr.push(f);
    byDate.set(key, arr);
  }
  const dates = [...byDate.keys()].sort((a, b) =>
    a < b ? 1 : a > b ? -1 : 0,
  );

  const link = (f: SnapshotFileEntry): string =>
    `<li><a href="${base}/${encodeURIComponent(f.filename)}">${esc(
      f.filename,
    )}</a> <span class="meta">${humanSize(f.size)}</span></li>`;

  const sections: string[] = [];

  if (latest.length > 0) {
    sections.push(
      `<section><h2>Latest</h2><ul>${latest.map(link).join("")}</ul></section>`,
    );
  }

  for (const d of dates) {
    const entries = (byDate.get(d) ?? []).sort(
      (a, b) =>
        fileRank(a.filename) - fileRank(b.filename) ||
        a.filename.localeCompare(b.filename),
    );
    sections.push(
      `<section><h2>${esc(d)}</h2><ul>${entries.map(link).join("")}</ul></section>`,
    );
  }

  const body =
    sections.length > 0
      ? sections.join("\n")
      : `<p class="empty">No snapshots yet. The daily job will populate this page.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>COD Drop snapshots</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
  h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
  .sub { color: #888; margin: 0 0 1.5rem; font-size: .9rem; }
  section { margin-bottom: 1.5rem; }
  h2 { font-size: 1rem; border-bottom: 1px solid #8884; padding-bottom: .25rem; margin: 0 0 .5rem; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: .15rem 0; }
  a { text-decoration: none; color: #0563c1; }
  a:hover { text-decoration: underline; }
  .meta { color: #888; font-size: .8rem; margin-left: .5rem; }
  .empty { color: #888; }
</style>
</head>
<body>
<h1>COD Drop snapshots</h1>
<p class="sub">Public daily product snapshots and quantity-sold reports. Newest first.</p>
${body}
</body>
</html>`;
}
