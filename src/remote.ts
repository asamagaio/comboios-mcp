import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CpService } from "./cp.js";
import { createServer, type ServerContext } from "./server.js";
import { log } from "./log.js";

/** Load the service-code list before tools are listed, so their descriptions can name valid codes. */
export async function bootstrap(timeoutMs = 8000): Promise<ServerContext> {
  const cp = new CpService();
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const serviceCodes = await Promise.race([cp.serviceCodesOrNull(), timeout]);
  if (!serviceCodes) log.warn("service codes not loaded at startup; tool descriptions will not list them");
  return { cp, serviceCodes };
}

let shared: Promise<ServerContext> | undefined;
/** One context per process (serverless instance), so caches survive across requests on that instance. */
export function sharedContext(): Promise<ServerContext> {
  shared ??= bootstrap(5000).catch((err) => {
    shared = undefined;
    throw err;
  });
  return shared;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

/**
 * Handle one MCP request over Streamable HTTP, statelessly: a fresh server + transport per request,
 * JSON responses, no session ids. Caches live in the shared CpService.
 */
export async function handleMcp(ctx: ServerContext, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  if (req.method !== "POST") {
    return sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)" }, id: null }, { Allow: "POST" });
  }
  const server = createServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log.error(`mcp request failed: ${(err as Error).message}`);
    if (!res.headersSent) sendJson(res, 500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}
