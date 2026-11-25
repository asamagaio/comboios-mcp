// Vercel Node function: the public MCP endpoint (rewritten from /mcp). Stateless Streamable HTTP.
import { handleMcp, readJson, sharedContext } from "../dist/remote.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const ctx = await sharedContext();
  // Vercel parses JSON bodies into req.body; fall back to reading the stream.
  const body = req.method === "POST" ? (req.body !== undefined ? req.body : await readJson(req)) : undefined;
  await handleMcp(ctx, req, res, body);
}
