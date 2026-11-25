/**
 * Payment lab: buy a CP ticket from a local page using CP's own Checkout.com payment session.
 *
 * EXPERIMENT. Not part of the MCP server. Runs on 127.0.0.1 only. The user types their own details
 * into the page; card / MB WAY / PayPal data goes straight into Checkout.com's form (an iframe) and
 * never reaches this process. Nothing personal is logged. Writes to CP are never retried.
 *
 *   node lab/checkout/server.mjs         (after `npm run build`)
 *   open http://localhost:8790/
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { CpHttp } from "../../dist/http.js";

process.env.CP_LOG_SILENT = "1";
const PORT = Number(process.env.LAB_PORT ?? 8790);
const ORIGIN = `http://localhost:${PORT}`;
const http = new CpHttp();
const W = { retry: false };

/**
 * One sale at a time. Its ids (no personal data) are kept in a 0600 file so a restart does not lose
 * the guest client id, which CP requires for confirm, status and ticket PDFs.
 */
const STATE_FILE = new URL("./.lab-state.json", import.meta.url);
let sale = loadState(); // { saleID, clientID, reference, createdAt, confirmed, lastStatus, detailsSet }
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return null; }
}
function saveState() {
  if (sale) writeFileSync(STATE_FILE, JSON.stringify(sale), { mode: 0o600 });
  else rmSync(STATE_FILE, { force: true });
}

const log = (m) => process.stderr.write(`[lab] ${m}\n`);
const errJson = (e) => ({ error: e?.message ?? String(e), code: e?.code, http: e?.httpStatus, ...(e?.details ?? {}) });
const H = () => ({ headers: { "x-cp-client-id": String(sale.clientID) } });
const PAID = ["COMPLETED", "PAID", "CONFIRMED", "SUCCESS"];
const isPaid = (code) => PAID.some((p) => String(code ?? "").toUpperCase().includes(p));

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : {};
}
function send(res, status, data, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
}

async function paymentStatus() {
  try {
    const r = await http.gateway("ticketing", `/sale/${sale.saleID}/payment`, H());
    return typeof r === "string" ? r : r;
  } catch (e) {
    return { error: e.message, http: e.httpStatus };
  }
}

async function saleSummary() {
  const s = await http.gateway("ticketing", `/sales/${sale.saleID}`, H());
  sale.lastStatus = s.status?.code;
  return {
    saleID: s.saleID,
    reference: s.reference,
    status: s.status,
    totalAmount: s.totalAmount,
    trip: (s.travelData?.outwardTrip ?? []).map((t) => ({ train: t.trainNumber, dep: t.departureTime, arr: t.arrivalTime, from: t.departureStation?.designation, to: t.arrivalStation?.designation })),
    tickets: (s.travelData?.ticketData ?? []).map((t) => ({ ticketID: t.ticketID ?? null, status: t.status?.code ?? null })),
    detailsSaved: Boolean(sale.detailsSet),
    clientDataFields: Object.keys(s.clientData ?? {}),
    minutesLeft: sale.createdAt ? Math.max(0, 15 - Math.floor((Date.now() - sale.createdAt) / 60000)) : null,
  };
}

const routes = {
  "GET /": async (_req, res) => send(res, 200, PAGE, "text/html; charset=utf-8"),
  "GET /return": async (_req, res) => send(res, 200, RETURN_PAGE, "text/html; charset=utf-8"),

  "GET /api/state": async (_req, res) => send(res, 200, sale ? { sale: await saleSummary(), confirmed: sale.confirmed } : { sale: null }),

  "POST /api/sale": async (req, res) => {
    if (sale && !sale.confirmed && !["CANCELLED", "EXPIRED"].includes(sale.lastStatus)) return send(res, 409, { error: "There is already an open sale; cancel it first" });
    const b = await body(req);
    const created = await http.gateway("ticketing", "/sale", { method: "POST", ...W, body: {
      quantity: 1, travelDate: b.date, travelClass: { code: String(b.travelClass ?? 2) },
      outwardTrip: b.legs.map((l) => ({ trainNumber: l.train, departureStation: { code: l.from }, arrivalStation: { code: l.to }, serviceCode: { code: l.service, designation: l.serviceName } })),
      seatOptions: null, lang: "PT" } });
    sale = { saleID: created.saleID, clientID: created.clientData?.clientID, reference: created.reference, createdAt: Date.now(), confirmed: false, lastStatus: created.status?.code };
    saveState();
    log(`sale created ${created.saleID} (${created.totalAmount})`);
    send(res, 200, { sale: await saleSummary() });
  },

  "POST /api/details": async (req, res) => {
    if (!sale) return send(res, 400, { error: "No sale" });
    const b = await body(req); // typed by the user in the page; not logged
    if (!b.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email ?? "")) return send(res, 400, { error: "Name and a valid email are required" });
    const passenger = { passengerName: b.name };
    if (b.idType && b.idNumber) Object.assign(passenger, { idtype: { code: b.idType }, passengerID: b.idNumber });
    await http.gateway("ticketing", `/sale/${sale.saleID}/passengers`, { method: "PUT", ...W, ...H(), body: { salePassengers: [passenger] } });
    await http.gateway("ticketing", `/sale/${sale.saleID}/client`, { method: "PUT", ...W, ...H(), body: { clientEmail: b.email, clientID: sale.clientID, clientMobile: b.mobile || null, clientName: b.name } });
    sale.detailsSet = true;
    saveState();
    log("passenger and client details set");
    send(res, 200, { sale: await saleSummary() });
  },

  "POST /api/payment": async (_req, res) => {
    if (!sale) return send(res, 400, { error: "No sale" });
    if (!sale.detailsSet) return send(res, 400, { error: "Save your details (name and email) before opening the payment form" });
    const p = await http.gateway("ticketing", `/sale/${sale.saleID}/payment`, { method: "PUT", ...W, ...H(), body: {
      systemID: "CHECKOUT", inboundURL: `${ORIGIN}/return`, useGWProxy: false, createToken: false, removeToken: false, channel: "BO" } });
    log(`payment session opened (paymentID ${p.paymentID})`);
    send(res, 200, { publicKey: p.key, paymentSession: JSON.parse(p.session), environment: "production" });
  },

  /** After Checkout.com: read payment status, then confirm once (as cp.pt's payment-processing page does). */
  "POST /api/confirm": async (_req, res) => {
    if (!sale) return send(res, 400, { error: "No sale" });
    if (sale.confirmed) return send(res, 200, { alreadyConfirmed: true, sale: await saleSummary() });
    const before = await paymentStatus();
    let confirm;
    try {
      confirm = await http.gateway("ticketing", `/sale/${sale.saleID}/confirm`, { method: "PUT", ...W, ...H() });
    } catch (e) {
      log(`confirm failed: ${e.message}`);
      return send(res, 502, { error: "Confirm failed. Do not pay again. If you were charged, contact CP with the reference below.", paymentStatus: before, confirmError: errJson(e), saleID: sale.saleID, reference: sale.reference });
    }
    const code = confirm?.status?.code;
    sale.confirmed = isPaid(code);
    saveState();
    log(`confirm -> ${code}`);
    send(res, 200, { confirmed: sale.confirmed, confirmStatus: confirm?.status, paymentStatus: before, sale: await saleSummary() });
  },

  /** Cancel only if no payment was made (spec §8.5 guard). */
  "POST /api/cancel": async (_req, res) => {
    if (!sale) return send(res, 400, { error: "No sale" });
    const ps = await paymentStatus();
    const s = await saleSummary();
    const psText = JSON.stringify(ps).toUpperCase();
    // A failed status read blocks the cancel, except "not found" (no payment was ever started).
    const readFailed = ps && typeof ps === "object" && ps.error && !/not found/i.test(ps.error);
    if (readFailed || isPaid(s.status?.code) || /CAPTUR|AUTHORI|PAID|PENDING_CONF/.test(psText)) {
      return send(res, 409, { error: "Payment may have happened; not cancelling. Check status / contact CP.", paymentStatus: ps, sale: s });
    }
    await http.gateway("ticketing", `/sale/${sale.saleID}`, { method: "DELETE", ...W, ...H() });
    log(`sale ${sale.saleID} cancelled`);
    sale = null;
    saveState();
    send(res, 200, { cancelled: true, paymentStatus: ps });
  },

  "GET /api/payment-status": async (_req, res) => send(res, 200, sale ? { paymentStatus: await paymentStatus(), sale: await saleSummary() } : { sale: null }),
};

createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) return await routes[key](req, res);
    const m = /^\/api\/ticket\/([0-9A-Za-z-]+)$/.exec(url.pathname);
    if (req.method === "GET" && m && sale) {
      // Ticket PDFs: GET /e-ticket/{saleID}/{reference}/{ticketID}
      const cfg = (await http.config.get()).config;
      const r = await fetch(`${cfg.ticketingApiUrl}/e-ticket/${sale.saleID}/${encodeURIComponent(sale.reference)}/${encodeURIComponent(m[1])}`, {
        headers: { "X-Api-Key": cfg.ticketingApiKey, "x-cp-connect-id": cfg.xcck, "x-cp-connect-secret": cfg.xccs, "x-cp-client-id": String(sale.clientID), Accept: "application/pdf" },
      });
      res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/pdf" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    log(`${key} failed: ${e.message}`);
    send(res, 500, errJson(e));
  }
}).listen(PORT, "127.0.0.1", () => log(`listening on ${ORIGIN}/`));

// ---------------------------------------------------------------- pages

const STYLE = `<style>
body{font:15px/1.5 system-ui,-apple-system,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:20px} h2{font-size:16px;margin-top:28px} .box{border:1px solid #ddd;border-radius:10px;padding:14px;margin:10px 0}
label{display:block;margin:8px 0 2px;font-weight:500} input,select{width:100%;padding:8px;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
button{padding:9px 14px;border-radius:8px;border:1px solid #2b7837;background:#2b7837;color:#fff;cursor:pointer;margin:8px 8px 0 0} button.secondary{background:#fff;color:#2b7837}
pre{background:#f5f5f7;padding:10px;border-radius:8px;white-space:pre-wrap;font-size:12px} .warn{color:#a15c00} .muted{color:#666;font-size:13px}
</style>`;

const PAGE = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment lab (local test)</title>${STYLE}</head><body>
<h1>Payment lab: CP ticket via Checkout.com (local test)</h1>
<p class="warn">Local experiment. The payment is real and charged by CP. Card/MB WAY details are entered in Checkout.com's form, not on this page.</p>

<h2>1. Trip</h2>
<div class="box">
  <div class="muted">Lisboa Santa Apolónia → Lisboa Oriente · 2026-11-30 10:45 · Regional 4413 · 2ª classe · €1.60</div>
  <button id="create">Create sale (holds for 15 min)</button>
</div>

<h2>2. Your details</h2>
<div class="box">
  <label>Name</label><input id="name" autocomplete="name">
  <label>Email (tickets are sent here)</label><input id="email" type="email" autocomplete="email">
  <label>Mobile (optional)</label><input id="mobile" autocomplete="tel">
  <label>ID document (optional)</label>
  <select id="idType"><option value="">—</option><option value="CC">Cartão de Cidadão</option><option value="PASS">Passaporte</option><option value="BI">BI</option><option value="AR">Autorização de Residência</option></select>
  <input id="idNumber" placeholder="Document number">
  <button id="details">Save details</button>
</div>

<h2>3. Payment</h2>
<div class="box">
  <button id="pay">Open payment form</button>
  <div id="flow" style="margin-top:12px"></div>
</div>

<h2>State</h2>
<button class="secondary" id="refresh">Refresh</button><button class="secondary" id="cancel">Cancel sale</button>
<pre id="out">No sale yet.</pre>

<script>
const out = document.getElementById('out');
const show = (x) => out.textContent = typeof x === 'string' ? x : JSON.stringify(x, null, 2);
async function api(path, data) {
  const r = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const j = await r.json(); show(j); if (!r.ok) throw new Error(j.error || r.status); return j;
}
document.getElementById('create').onclick = () => api('/api/sale', { date: '2026-11-30', travelClass: 2, legs: [{ train: 4413, from: '94-30007', to: '94-31039', service: 'R', serviceName: 'Regional' }] });
const val = (id) => document.getElementById(id).value.trim();
document.getElementById('details').onclick = () => api('/api/details', { name: val('name'), email: val('email'), mobile: val('mobile'), idType: val('idType'), idNumber: val('idNumber') });
document.getElementById('refresh').onclick = () => api('/api/payment-status');
document.getElementById('cancel').onclick = () => api('/api/cancel', {});
document.getElementById('pay').onclick = async () => {
  const s = await api('/api/payment', {});
  await new Promise((ok, ko) => { const el = document.createElement('script'); el.src = 'https://checkout-web-components.checkout.com/index.js'; el.onload = ok; el.onerror = () => ko(new Error('Could not load Checkout.com script')); document.body.appendChild(el); });
  try {
    const cko = await window.CheckoutWebComponents({
      paymentSession: s.paymentSession, publicKey: s.publicKey, environment: s.environment,
      onReady: () => show('Checkout.com form ready.'),
      onPaymentCompleted: async (_c, r) => { show({ paymentCompleted: r && r.id ? r.id : true }); location.href = '/return?status=succeeded'; },
      onError: (_c, e) => show({ checkoutError: String(e && (e.message || e.type || e)) }),
    });
    cko.create('flow').mount('#flow');
  } catch (e) { show({ checkoutInitError: String(e && (e.message || e)) }); }
};
window.addEventListener('error', (e) => show({ pageError: String(e.message) }));
window.addEventListener('unhandledrejection', (e) => show({ error: String(e.reason && (e.reason.message || e.reason)) }));
api('/api/state');
</script></body></html>`;

const RETURN_PAGE = `<!doctype html><html lang="pt"><head><meta charset="utf-8"><title>Payment lab: result</title>${STYLE}</head><body>
<h1>Payment result</h1><p class="muted" id="q"></p><pre id="out">Confirming with CP…</pre><div id="tickets"></div>
<p><a href="/">Back</a></p>
<script>
const p = new URLSearchParams(location.search); document.getElementById('q').textContent = 'Return parameters: ' + [...p.keys()].join(', ');
fetch('/api/confirm', { method: 'POST' }).then(r => r.json()).then(j => {
  document.getElementById('out').textContent = JSON.stringify(j, null, 2);
  const t = (j.sale && j.sale.tickets) || [];
  document.getElementById('tickets').innerHTML = t.filter(x => x.ticketID).map(x => '<p><a href="/api/ticket/' + x.ticketID + '" target="_blank">Ticket ' + x.ticketID + ' (PDF)</a></p>').join('');
});
</script></body></html>`;
