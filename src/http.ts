#!/usr/bin/env node
/**
 * COD Drop Products MCP server — HTTP / Streamable HTTP entrypoint.
 */

import fs from "node:fs";
import express from "express";
import type { Request, RequestHandler, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { buildMcpServer, readCodConfig } from "./build-server.js";
import { CodApiError, CodClient } from "./client.js";
import { getSnapshotsForDate, getSnapshotDates } from "./db.js";
import { CodMcpOAuthProvider } from "./oauth.js";
import { startDailySnapshotScheduler } from "./scheduler.js";
import { renderSnapshotsIndexHtml, snapshotsDir } from "./snapshot-files.js";

const log = (...args: unknown[]): void => {
  process.stderr.write(`[cod-drop-products-mcp:http] ${args.join(" ")}\n`);
};

function methodNotAllowed(res: Response): void {
  res.writeHead(405, { "content-type": "application/json" }).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
}

interface MarketplaceImageResponse {
  data?: {
    image_url?: string;
  };
}

function imageUrlFromSnapshots(productId: number): string | null {
  for (const date of getSnapshotDates()) {
    const product = getSnapshotsForDate(date).find((p) => p.product_id === productId);
    if (product?.image_url) return product.image_url;
  }
  return null;
}

async function proxyProductImage(
  client: CodClient,
  productId: number,
  res: Response,
): Promise<void> {
  let imageUrl = imageUrlFromSnapshots(productId);
  if (!imageUrl) {
    try {
      const product = await client.request<MarketplaceImageResponse>({
        path: `/seller/marketplace/products/${productId}`,
      });
      imageUrl = product.data?.image_url ?? null;
    } catch (err) {
      if (!(err instanceof CodApiError && err.status === 404)) throw err;
    }
  }

  if (!imageUrl) {
    res.status(404).send("Image not found");
    return;
  }

  const upstream = await fetch(imageUrl, { redirect: "follow" });
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status || 502).send("Unable to fetch image");
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "image/jpeg");
  const length = upstream.headers.get("content-length");
  if (length) res.setHeader("Content-Length", length);
  const body = Buffer.from(await upstream.arrayBuffer());
  res.end(body);
}

async function main(): Promise<void> {
  const cfg = readCodConfig();
  const adminToken = process.env.MCP_AUTH_TOKEN;
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  if (!adminToken) {
    log(
      "ERROR: MCP_AUTH_TOKEN is required. Generate one with:",
      "`openssl rand -base64 32` and set it as a server env var.",
    );
    process.exit(1);
  }

  const flyAppName = process.env.FLY_APP_NAME;
  const issuerUrl = process.env.MCP_PUBLIC_URL
    ? new URL(process.env.MCP_PUBLIC_URL)
    : flyAppName
      ? new URL(`https://${flyAppName}.fly.dev`)
      : new URL(`http://${host}:${port}`);
  const mcpResourceUrl = new URL("/mcp", issuerUrl);

  const oauth = new CodMcpOAuthProvider(adminToken);

  const app = express();
  // Use 1 (single proxy hop) instead of `true` to satisfy express-rate-limit
  // validation which rejects the permissive `true` setting.
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Public, no-auth snapshot artifacts: a listing page plus direct file access
  // for coddata{date}.json/.xlsx, coddataQuantitySold{date}.json/.xlsx, and the
  // latest.* aliases.
  const snapDir = snapshotsDir();
  fs.mkdirSync(snapDir, { recursive: true });
  const codClient = new CodClient({
    token: cfg.token,
    baseUrl: cfg.baseUrl,
    timeoutMs: cfg.timeoutMs,
  });

  app.get("/snapshots/images/:productId", async (req, res) => {
    const productId = Number.parseInt(req.params.productId, 10);
    if (!Number.isFinite(productId)) {
      res.status(400).send("Invalid product id");
      return;
    }
    try {
      await proxyProductImage(codClient, productId, res);
    } catch (err) {
      log("Image proxy error:", err instanceof Error ? err.message : String(err));
      res.status(502).send("Unable to fetch image");
    }
  });

  app.get(["/snapshots", "/snapshots/"], (_req, res) => {
    res.type("html").send(renderSnapshotsIndexHtml("/snapshots"));
  });
  app.use(
    "/snapshots",
    express.static(snapDir, {
      index: false,
      setHeaders: (res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
      },
    }),
  );

  app.get("/", (_req, res) => {
    res.json({
      service: "cod-drop-products-mcp",
      transport: "streamable-http",
      mcpEndpoint: mcpResourceUrl.toString(),
      oauthDiscovery: new URL(
        "/.well-known/oauth-authorization-server",
        issuerUrl,
      ).toString(),
      protectedResourceMetadata: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
      docs: "https://github.com/hamoza33/cod-drop-products-mcp",
    });
  });

  // Auto-register unknown clients before the SDK's auth router validates them.
  // This handles clients whose registrations were lost on machine restart.
  app.use(["/authorize", "/token"], (req, _res, next) => {
    const clientId = (req.query.client_id ?? req.body?.client_id) as string | undefined;
    const redirectUri = (req.query.redirect_uri ?? req.body?.redirect_uri) as string | undefined;
    if (clientId) {
      oauth.ensureClient(clientId, redirectUri ?? "");
    }
    next();
  });

  app.use(
    mcpAuthRouter({
      provider: oauth,
      issuerUrl,
      resourceServerUrl: mcpResourceUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "COD Drop Products MCP",
    }),
  );

  app.post("/oauth/approve", oauth.approveHandler);

  const oauthBearer = requireBearerAuth({
    verifier: oauth,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
  });

  const adminOrOauthBearer: RequestHandler = (req, res, next) => {
    const header = req.header("authorization") ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m && m[1] && oauth.isAdminToken(m[1].trim())) {
      const token = m[1].trim();
      const adminAuth: AuthInfo = {
        token,
        clientId: "admin",
        scopes: ["mcp:tools"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
      (req as Request & { auth?: AuthInfo }).auth = adminAuth;
      next();
      return;
    }
    oauthBearer(req, res, next);
  };

  app.post("/mcp", adminOrOauthBearer, async (req, res) => {
    const { server } = buildMcpServer(cfg);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", adminOrOauthBearer, (_req, res) => {
    methodNotAllowed(res);
  });
  app.delete("/mcp", adminOrOauthBearer, (_req, res) => {
    methodNotAllowed(res);
  });

  app.listen(port, host, () => {
    log(`Listening on ${host}:${port}`);
    log(`MCP endpoint: ${mcpResourceUrl}`);
    log(`Snapshots: ${new URL("/snapshots", issuerUrl).toString()}`);
    log(`Tools registered: ${buildMcpServer(cfg).toolCount}`);
  });

  startDailySnapshotScheduler((...args) => log("[cron]", ...args));
}

main().catch((err) => {
  log("FATAL:", err);
  process.exit(1);
});
