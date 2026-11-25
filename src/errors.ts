/** Error surfaced to the MCP client as a tool error. */
export class CpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CpError";
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      message: this.message,
      ...(this.details ?? {}),
    };
  }
}

/** Pull a human-readable message out of an upstream error body, if any. */
export function upstreamMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  for (const k of ["description", "message", "moreInformation", "error", "httpMessage"]) {
    if (typeof b[k] === "string" && b[k]) return b[k] as string;
  }
  return undefined;
}
