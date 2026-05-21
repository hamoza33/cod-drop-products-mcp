#!/usr/bin/env node
/**
 * COD Drop Products MCP server — stdio entrypoint.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer, readCodConfig } from "./build-server.js";

const log = (...args: unknown[]): void => {
  process.stderr.write(`[cod-drop-products-mcp] ${args.join(" ")}\n`);
};

async function main(): Promise<void> {
  const cfg = readCodConfig();
  const { server, toolCount } = buildMcpServer(cfg);

  log(`Starting stdio transport with ${toolCount} tools…`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("Connected.");
}

main().catch((err) => {
  process.stderr.write(`[cod-drop-products-mcp] FATAL: ${err}\n`);
  process.exit(1);
});
