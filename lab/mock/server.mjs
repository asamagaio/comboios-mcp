/**
 * Local mock of /api/pay for working on the purchase page UI without CP: serves public/ and answers
 * quote, start, seats, seat, pay, cancel from fixtures. No sale is created anywhere.
 *   npm run build && node lab/mock/server.mjs   → http://localhost:8791/comprar?o=demo
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { compactSeatMap } from "../../dist/pay.js";
import { horariosHtml } from "../../dist/ui.js";

const ROOT = new URL("../../public/", import.meta.url).pathname;
const seatRaw = JSON.parse(readFileSync(new URL("../../test/fixtures/seatmap-ap131.json", import.meta.url), "utf8"));
let seats = [{ carriage: 3, seat: 53 }];
const trains = () => [{ train: 131, from: "Lisboa Santa Apolonia", to: "Porto Campanha", dep: "07:00", arr: "09:48", seats }];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const json = (code, body) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/pay") {
    let body = ""; for await (const c of req) body += c; body = body ? JSON.parse(body) : {};
    const a = url.searchParams.get("a");
    if (a === "quote") return json(200, { option_id: "demo", from: "Lisboa Santa Apolonia", to: "Porto Campanha", date: "2026-12-04", departure: "07:00", arrival: "09:48", duration: "02h48", travel_class: 2, passengers: 1, legs: [{ train: 131, service: "Alfa Pendular", from: "Lisboa Santa Apolonia", to: "Porto Campanha", dep: "07:00", arr: "09:48" }], price_eur_each: 35.7 });
    if (a === "start") return json(200, { token: "mock-token-".padEnd(48, "x"), reference: "CP-MOCK", total: "€ 35,70", expires_in_min: 15, trains: trains() });
    if (a === "seats") {
      const m = compactSeatMap(seatRaw);
      for (const c of m.carriages) for (const r of c.rows) for (const p of r) if (p.kind === "seat") p.status = seats.some((s) => s.carriage === c.number && s.seat === p.seat) ? "mine" : p.status === "mine" ? "free" : p.status;
      return json(200, m);
    }
    if (a === "seat") { seats = body.seats; return json(200, { trains: trains(), total: "€ 35,70" }); }
    if (a === "pay") return json(502, { error: "Mock: payment is not available locally" });
    if (a === "cancel") return json(200, { cancelled: true });
    return json(404, { error: "unknown" });
  }
  // MCP Apps view harness: /ui-host loads the horarios view in an iframe and plays the host side.
  if (url.pathname === "/ui-host") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(readFileSync(new URL("./host.html", import.meta.url))); }
  if (url.pathname === "/ui-view") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(horariosHtml()); }
  if (url.pathname === "/ui-sample") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(readFileSync(new URL("./horarios-result.json", import.meta.url))); }
  const path = url.pathname === "/comprar" || url.pathname === "/comprar/retorno" ? "comprar.html" : url.pathname.slice(1) || "index.html";
  const file = join(ROOT, path);
  if (!existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(8791, "127.0.0.1", () => process.stderr.write("mock on http://localhost:8791/comprar?o=demo\n"));
