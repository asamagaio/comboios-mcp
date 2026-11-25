/**
 * Logging goes to stderr only: stdout is the MCP stdio channel.
 * Never pass credentials, request bodies of purchase calls, or personal data to these functions.
 */
const level = (process.env.CP_LOG_LEVEL ?? "info").toLowerCase();
const order = { debug: 0, info: 1, warn: 2, error: 3 } as const;
const threshold = order[level as keyof typeof order] ?? 1;

function write(l: keyof typeof order, msg: string): void {
  if (order[l] < threshold || process.env.CP_LOG_SILENT === "1") return;
  process.stderr.write(`[comboios-mcp] ${l.toUpperCase()} ${msg}\n`);
}

export const log = {
  debug: (m: string) => write("debug", m),
  info: (m: string) => write("info", m),
  warn: (m: string) => write("warn", m),
  error: (m: string) => write("error", m),
};
