/**
 * HTTP client for the COD Network seller API.
 * Docs: https://developer.cod.network/v2
 */

const DEFAULT_BASE_URL = "https://api.cod.network/v2";
const DEFAULT_TIMEOUT_MS = 30_000;
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const TRANSIENT_RETRY_BACKOFF_MS = [400, 1200];

export interface CodClientOptions {
  token: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface CodRequestOptions {
  method?: HttpMethod;
  path: string;
  query?: Record<string, string | number | boolean | string[] | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class CodApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "CodApiError";
  }
}

export class CodClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly token: string;

  constructor(opts: CodClientOptions) {
    if (!opts.token) {
      throw new Error(
        "CodClient: `token` is required. Get it from My profile -> API developer -> API Token.",
      );
    }
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T = unknown>(opts: CodRequestOptions): Promise<T> {
    let attempt = 0;
    const maxAttempts = TRANSIENT_RETRY_BACKOFF_MS.length + 1;
    let lastErr: unknown;
    while (attempt < maxAttempts) {
      try {
        return await this.rawRequest<T>(opts);
      } catch (err) {
        lastErr = err;
        if (
          err instanceof CodApiError &&
          (TRANSIENT_STATUSES.has(err.status) || err.status === 0) &&
          attempt < TRANSIENT_RETRY_BACKOFF_MS.length
        ) {
          const wait = TRANSIENT_RETRY_BACKOFF_MS[attempt] ?? 1000;
          await new Promise((resolve) => setTimeout(resolve, wait));
          attempt += 1;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new CodApiError("request: unreachable", 0);
  }

  private async rawRequest<T = unknown>(opts: CodRequestOptions): Promise<T> {
    const method = opts.method ?? "GET";
    const path = opts.path.startsWith("/") ? opts.path : `/${opts.path}`;
    const url = new URL(`${this.baseUrl}${path}`);

    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const v of value) url.searchParams.append(key, String(v));
        } else {
          url.searchParams.append(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "cod-drop-products-mcp/0.1.0",
      ...(opts.headers ?? {}),
    };
    headers.Authorization = `Bearer ${this.token}`;

    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timeout);
      if ((err as Error).name === "AbortError") {
        throw new CodApiError(
          `Request to ${method} ${url.pathname} timed out after ${this.timeoutMs}ms`,
          0,
        );
      }
      throw new CodApiError(
        `Network error calling ${method} ${url.pathname}: ${(err as Error).message}`,
        0,
      );
    }
    clearTimeout(timeout);

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        (isErrorBody(parsed) && parsed.message) ||
        `HTTP ${res.status} from ${method} ${url.pathname}`;
      const code = isErrorBody(parsed) ? parsed.code : undefined;
      throw new CodApiError(message, res.status, String(code ?? ""), parsed);
    }

    return parsed as T;
  }
}

interface ErrorBody {
  status?: string;
  message?: string;
  code?: string;
}

function isErrorBody(v: unknown): v is ErrorBody {
  return typeof v === "object" && v !== null && "message" in v;
}
