import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CpError } from "../errors.js";
import { log } from "../log.js";

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

export function fail(err: unknown): CallToolResult {
  const payload =
    err instanceof CpError
      ? err.toJSON()
      : { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) };
  if (!(err instanceof CpError)) log.error(`unexpected tool error: ${err instanceof Error ? err.stack : String(err)}`);
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: payload }) }] };
}

/** Wrap a tool handler so every failure becomes a structured MCP tool error. */
export function handler<A>(fn: (args: A) => Promise<unknown>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      return fail(err);
    }
  };
}

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** "HH:MM" or null. CP uses "00:00" at a first stop to mean "no arrival". */
export function hhmm(v: unknown): string | null {
  return typeof v === "string" && /^\d{2}:\d{2}/.test(v) ? v.slice(0, 5) : null;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function station(v: unknown): { code: string | null; name: string | null } {
  const o = (v ?? {}) as Record<string, unknown>;
  return { code: str(o.code), name: str(o.designation) };
}
