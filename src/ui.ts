/**
 * MCP Apps UI resources (in-chat views). The view scripts are bundled by esbuild into dist/ui/*.js
 * (see `npm run build:ui`) and inlined here, so the resource is one self-contained HTML document.
 */
import { existsSync, readFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { log } from "./log.js";

export const HORARIOS_UI = "ui://comboios/horarios.html";

/** `_meta` for a tool that renders a view (new key plus the legacy one for older hosts). */
export function uiMeta(resourceUri: string): Record<string, unknown> {
  return { ui: { resourceUri }, "ui/resourceUri": resourceUri };
}

const STYLE = `
:root { --fg:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7; --card:#fff; --bg:transparent; --g:#2b7837; --g2:#e7f3e9; --warn:#a15c00; }
:root[data-theme="dark"] { --fg:#f5f5f7; --muted:#a1a1a6; --line:#3a3a3c; --card:#1c1c1e; --g:#5cbf6c; --g2:#1f3324; --warn:#e0a040; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --fg:#f5f5f7; --muted:#a1a1a6; --line:#3a3a3c; --card:#1c1c1e; --g:#5cbf6c; --g2:#1f3324; --warn:#e0a040; } }
* { box-sizing: border-box; }
body { margin:0; padding:4px 2px; background:var(--bg); color:var(--fg); font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif; }
header .route { font-size:16px; font-weight:600; }
h2 { font-size:13px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin:14px 0 6px; }
.list { display:grid; gap:8px; }
.opt { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 12px; }
.times { font-size:16px; } .meta { color:var(--muted); font-size:13px; margin-top:2px; }
.svc { display:inline-block; padding:0 6px; border-radius:6px; background:var(--g2); color:var(--g); font-weight:600; font-size:12px; }
.row { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-top:8px; }
.price { font-weight:700; font-size:16px; } .was { text-decoration:line-through; color:var(--muted); margin-left:6px; font-size:12px; }
.tag { font-size:11px; color:var(--warn); margin-left:6px; }
details { margin-top:4px; font-size:12px; color:var(--muted); } summary { cursor:pointer; }
.legs { margin-top:4px; }
button.buy { border:0; border-radius:9px; background:var(--g); color:#fff; font:inherit; font-weight:600; padding:7px 14px; cursor:pointer; white-space:nowrap; }
button.buy:disabled { opacity:.6; }
.muted { color:var(--muted); } .err { color:#c0392b; } .note { border-left:3px solid var(--warn); padding:4px 8px; font-size:12px; }
footer { margin-top:12px; font-size:11px; }
`;

let cached: string | undefined;

export function horariosHtml(): string {
  if (cached) return cached;
  // dist/ui.js → dist/ui/horarios.js; when running from src (tests) → ../dist/ui/horarios.js
  const candidates = [new URL("./ui/horarios.js", import.meta.url), new URL("../dist/ui/horarios.js", import.meta.url)];
  const file = candidates.find((u) => existsSync(u));
  if (!file) throw new Error("dist/ui/horarios.js not found (run npm run build)");
  const js = readFileSync(file, "utf8");
  cached = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Horários</title><style>${STYLE}</style></head><body><div id="root"><p class="muted">A carregar…</p></div>
<script>${js.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  return cached;
}

/** Register the in-chat views. Skipped (with a warning) if the bundle was not built. */
export function registerUiResources(server: McpServer): boolean {
  let html: string;
  try {
    html = horariosHtml();
  } catch (err) {
    log.warn(`UI bundle missing, in-chat views disabled (${(err as Error).message})`);
    return false;
  }
  server.registerResource(
    "horarios-view",
    HORARIOS_UI,
    { title: "Horários", description: "Journey options with a buy button", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: HORARIOS_UI,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          // No network access and no external resources: everything is inline, data comes from the tool.
          _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } },
        },
      ],
    }),
  );
  return true;
}
