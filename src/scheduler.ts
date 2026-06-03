/**
 * In-process daily scheduler that runs cod_drop_snapshot_today automatically at
 * a fixed UTC time, with retry + logging. Runs as part of the long-lived HTTP
 * server (systemd keeps it alive), so no external crontab is required.
 *
 * Env:
 *   SNAPSHOT_CRON_UTC       "HH:MM" UTC time to run daily (default "01:00")
 *   SNAPSHOT_CRON_DISABLED  set to "1" to disable the scheduler
 *   SNAPSHOT_CRON_ATTEMPTS  retry attempts on failure (default 3)
 */

import { CodClient } from "./client.js";
import { readCodConfig } from "./build-server.js";
import { runSnapshot, type Logger } from "./snapshot.js";

const RETRY_BASE_MS = 30_000;

function parseUtcHHMM(s: string): { h: number; m: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return { h: 1, m: 0 };
  const h = Math.min(23, Math.max(0, Number.parseInt(m[1]!, 10)));
  const min = Math.min(59, Math.max(0, Number.parseInt(m[2]!, 10)));
  return { h, m: min };
}

function msUntilNext(h: number, m: number): number {
  const now = new Date();
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      h,
      m,
      0,
      0,
    ),
  );
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function runWithRetry(log: Logger, attempts: number): Promise<void> {
  let cfg;
  try {
    cfg = readCodConfig();
  } catch (err) {
    log(`Cannot read config; aborting daily snapshot: ${String(err)}`);
    return;
  }
  const client = new CodClient({
    token: cfg.token,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
  });

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await runSnapshot(client, undefined, log);
      log(`Daily snapshot succeeded: ${res.summary}`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Daily snapshot attempt ${i}/${attempts} failed: ${msg}`);
      if (i < attempts) {
        const wait = RETRY_BASE_MS * i;
        log(`Retrying in ${Math.round(wait / 1000)}s…`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  log(`Daily snapshot FAILED after ${attempts} attempts.`);
}

/** Start the daily snapshot scheduler. No-op if disabled via env. */
export function startDailySnapshotScheduler(log: Logger): void {
  if (process.env.SNAPSHOT_CRON_DISABLED === "1") {
    log("Daily snapshot scheduler disabled (SNAPSHOT_CRON_DISABLED=1).");
    return;
  }

  const { h, m } = parseUtcHHMM(process.env.SNAPSHOT_CRON_UTC ?? "01:00");
  const attempts = (() => {
    const n = Number.parseInt(process.env.SNAPSHOT_CRON_ATTEMPTS ?? "3", 10);
    return Number.isFinite(n) && n > 0 ? n : 3;
  })();
  const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;

  const schedule = (): void => {
    const delay = msUntilNext(h, m);
    log(
      `Next daily snapshot in ${(delay / 3_600_000).toFixed(2)}h ` +
        `(at ${hhmm} UTC).`,
    );
    setTimeout(() => {
      void runWithRetry(log, attempts).finally(schedule);
    }, delay);
  };

  log(`Daily snapshot scheduler started (runs ${hhmm} UTC, ${attempts} attempts).`);
  schedule();
}
