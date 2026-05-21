/**
 * SQLite-backed daily snapshot store for COD Drop marketplace products.
 *
 * Each day's snapshot records every product's key fields so we can compare
 * quantities across days to find best-selling products.
 */

import Database from "better-sqlite3";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? ".";

export interface ProductSnapshot {
  product_id: number;
  name: string;
  sku: string;
  country: string;
  country_name: string;
  cost: string;
  currency: string;
  recommended_selling_price: string;
  category: string;
  in_stock: boolean;
  available_for_drop: boolean;
  image_url: string;
  quantity: number | null;
  project_name: string | null;
  snapshot_date: string;
}

export interface BestSeller {
  product_id: number;
  name: string;
  country: string;
  country_name: string;
  category: string;
  project_name: string | null;
  yesterday_qty: number;
  today_qty: number;
  qty_drop: number;
  image_url: string;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  const dbPath = path.join(DATA_DIR, "cod-drop-snapshots.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS product_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id      INTEGER NOT NULL,
      name            TEXT NOT NULL,
      sku             TEXT NOT NULL DEFAULT '',
      country         TEXT NOT NULL DEFAULT '',
      country_name    TEXT NOT NULL DEFAULT '',
      cost            TEXT NOT NULL DEFAULT '0',
      currency        TEXT NOT NULL DEFAULT 'USD',
      recommended_selling_price TEXT NOT NULL DEFAULT '',
      category        TEXT NOT NULL DEFAULT '',
      in_stock        INTEGER NOT NULL DEFAULT 1,
      available_for_drop INTEGER NOT NULL DEFAULT 1,
      image_url       TEXT NOT NULL DEFAULT '',
      quantity        INTEGER,
      project_name    TEXT,
      snapshot_date   TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_id, snapshot_date)
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON product_snapshots(snapshot_date);
    CREATE INDEX IF NOT EXISTS idx_snapshots_product ON product_snapshots(product_id);
  `);
  return _db;
}

export function upsertSnapshot(snap: ProductSnapshot): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO product_snapshots
      (product_id, name, sku, country, country_name, cost, currency,
       recommended_selling_price, category, in_stock, available_for_drop,
       image_url, quantity, project_name, snapshot_date)
    VALUES
      (@product_id, @name, @sku, @country, @country_name, @cost, @currency,
       @recommended_selling_price, @category, @in_stock, @available_for_drop,
       @image_url, @quantity, @project_name, @snapshot_date)
    ON CONFLICT(product_id, snapshot_date) DO UPDATE SET
      name = excluded.name,
      sku = excluded.sku,
      country = excluded.country,
      country_name = excluded.country_name,
      cost = excluded.cost,
      currency = excluded.currency,
      recommended_selling_price = excluded.recommended_selling_price,
      category = excluded.category,
      in_stock = excluded.in_stock,
      available_for_drop = excluded.available_for_drop,
      image_url = excluded.image_url,
      quantity = excluded.quantity,
      project_name = excluded.project_name
  `).run({
    ...snap,
    in_stock: snap.in_stock ? 1 : 0,
    available_for_drop: snap.available_for_drop ? 1 : 0,
  });
}

export function upsertSnapshots(snaps: ProductSnapshot[]): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO product_snapshots
      (product_id, name, sku, country, country_name, cost, currency,
       recommended_selling_price, category, in_stock, available_for_drop,
       image_url, quantity, project_name, snapshot_date)
    VALUES
      (@product_id, @name, @sku, @country, @country_name, @cost, @currency,
       @recommended_selling_price, @category, @in_stock, @available_for_drop,
       @image_url, @quantity, @project_name, @snapshot_date)
    ON CONFLICT(product_id, snapshot_date) DO UPDATE SET
      name = excluded.name,
      sku = excluded.sku,
      country = excluded.country,
      country_name = excluded.country_name,
      cost = excluded.cost,
      currency = excluded.currency,
      recommended_selling_price = excluded.recommended_selling_price,
      category = excluded.category,
      in_stock = excluded.in_stock,
      available_for_drop = excluded.available_for_drop,
      image_url = excluded.image_url,
      quantity = excluded.quantity,
      project_name = excluded.project_name
  `);
  const insertMany = db.transaction((items: ProductSnapshot[]) => {
    for (const snap of items) {
      stmt.run({
        ...snap,
        in_stock: snap.in_stock ? 1 : 0,
        available_for_drop: snap.available_for_drop ? 1 : 0,
      });
    }
  });
  insertMany(snaps);
}

export function getSnapshotDates(): string[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT DISTINCT snapshot_date FROM product_snapshots ORDER BY snapshot_date DESC")
    .all() as Array<{ snapshot_date: string }>;
  return rows.map((r) => r.snapshot_date);
}

export function getSnapshotsForDate(date: string): ProductSnapshot[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM product_snapshots WHERE snapshot_date = ? ORDER BY product_id")
    .all(date) as ProductSnapshot[];
}

export function getSnapshotCount(date: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM product_snapshots WHERE snapshot_date = ?")
    .get(date) as { cnt: number };
  return row.cnt;
}

export function compareDays(
  todayDate: string,
  yesterdayDate: string,
): BestSeller[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT
        t.product_id,
        t.name,
        t.country,
        t.country_name,
        t.category,
        t.project_name,
        t.image_url,
        y.quantity AS yesterday_qty,
        t.quantity AS today_qty,
        (COALESCE(y.quantity, 0) - COALESCE(t.quantity, 0)) AS qty_drop
      FROM product_snapshots t
      INNER JOIN product_snapshots y
        ON t.product_id = y.product_id
        AND y.snapshot_date = @yesterdayDate
      WHERE t.snapshot_date = @todayDate
        AND COALESCE(y.quantity, 0) > COALESCE(t.quantity, 0)
      ORDER BY qty_drop DESC
    `)
    .all({ todayDate, yesterdayDate }) as BestSeller[];
  return rows;
}

export function getLatestTwoDates(): { today: string | null; yesterday: string | null } {
  const dates = getSnapshotDates();
  return {
    today: dates[0] ?? null,
    yesterday: dates[1] ?? null,
  };
}
