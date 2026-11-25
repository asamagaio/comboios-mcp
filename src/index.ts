#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, type ServerContext } from "./server.js";
import { bootstrap, handleMcp, readJson, sendJson } from "./remote.js";
import { log } from "./log.js";

interface Args {
  http: boolean;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { http: false, port: 8787, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--http") a.http = true;
    else if (v === "--port") a.port = Number(argv[++i]);
    else if (v === "--host") a.host = argv[++i];
    else if (v === "--help" || v === "-h") {
      process.stderr.write("Usage: comboios-mcp [--http [--port 8787] [--host 127.0.0.1]]\n  HTTP mode requires CP_MCP_TOKEN.\n");
      process.exit(0);
    }
  }
  if (!Number.isInteger(a.port) || a.port <= 0) throw new Error("--port must be a positive integer");
  return a;
}

function bearerOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function runHttp(ctx: ServerContext, args: Args): Promise<void> {
  const token = process.env.CP_MCP_TOKEN;
  if (!token || token.length < 16) {
    throw new Error("HTTP mode requires CP_MCP_TOKEN (at least 16 characters)");
  }
  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/healthz") return sendJson(res, 200, { ok: true });
      if (url.pathname !== "/mcp") return sendJson(res, 404, { error: "not found" });
      if (!bearerOk(req, token)) {
        res.setHeader("WWW-Authenticate", "Bearer");
        return sendJson(res, 401, { error: "unauthorized" });
      }
      await handleMcp(ctx, req, res, req.method === "POST" ? await readJson(req) : undefined);
    } catch (err) {
      log.error(`http request failed: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Bad request" }, id: null });
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(args.port, args.host, resolve));
  log.info(`listening on http://${args.host}:${args.port}/mcp`);
  if (args.host !== "127.0.0.1" && args.host !== "localhost" && args.host !== "::1") {
    log.warn(`bound to ${args.host}: the server is reachable from other machines (bearer token still required)`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const ctx = await bootstrap();
  if (args.http) {
    await runHttp(ctx, args);
  } else {
    const server = createServer(ctx);
    await server.connect(new StdioServerTransport());
    log.info("ready on stdio");
  }
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
