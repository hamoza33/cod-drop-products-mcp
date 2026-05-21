#!/usr/bin/env node
/**
 * COD Drop Products MCP server — HTTP / Streamable HTTP entrypoint.
 */

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
import { CodMcpOAuthProvider } from "./oauth.js";

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
  app.set("trust proxy", true);
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: false, limit: "256kb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

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
    log(`Tools registered: ${buildMcpServer(cfg).toolCount}`);
  });
}

main().catch((err) => {
  log("FATAL:", err);
  process.exit(1);
});
