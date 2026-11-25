// Public payment API (stage B). Actions: quote, start, status, confirm, cancel (POST JSON), ticket (GET).
import { sharedContext, sendJson, readJson } from "../dist/remote.js";
import { cancelPurchase, changeSeats, confirmPurchase, openPayment, openPrefill, paymentsEnabled, seatMap, publicBaseUrl, purchaseStatus, quote, startPurchase, ticketPdf } from "../dist/pay.js";

export const config = { maxDuration: 30 };
const NO_STORE = { "Cache-Control": "no-store" };

function errorOut(res, e) {
  const status = e?.httpStatus && e.httpStatus >= 400 && e.httpStatus < 500 ? e.httpStatus : e?.code === "INVALID_INPUT" || e?.code === "INVALID_TOKEN" ? 400 : 502;
  sendJson(res, status, { error: e?.message ?? "Error", code: e?.code ?? "ERROR" }, NO_STORE);
}

export default async function handler(req, res) {
  if (!paymentsEnabled()) return sendJson(res, 503, { error: "Payments are disabled", code: "DISABLED" }, NO_STORE);
  const url = new URL(req.url, "http://x");
  const action = url.searchParams.get("a");
  try {
    const { cp } = await sharedContext();
    if (req.method === "GET" && action === "ticket") {
      const pdf = await ticketPdf(cp, url.searchParams.get("t"), url.searchParams.get("id") ?? "");
      res.writeHead(pdf.status, { "Content-Type": pdf.type, "Content-Disposition": `inline; filename="bilhete-${url.searchParams.get("id")}.pdf"`, ...NO_STORE });
      return res.end(pdf.body);
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" }, { Allow: "POST", ...NO_STORE });
    const body = req.body !== undefined ? req.body : await readJson(req);
    let out;
    if (action === "quote") {
      const { _search, _trip, ...q } = await quote(cp, String(body?.option_id ?? ""));
      out = q;
    } else if (action === "prefill") out = openPrefill(body?.f);
    else if (action === "start") out = await startPurchase(cp, body);
    else if (action === "seats") out = await seatMap(cp, body?.t, Number(body?.train));
    else if (action === "seat") out = await changeSeats(cp, body?.t, Number(body?.train), body?.seats);
    else if (action === "pay") out = await openPayment(cp, body?.t, publicBaseUrl());
    else if (action === "status") out = await purchaseStatus(cp, body?.t);
    else if (action === "confirm") out = await confirmPurchase(cp, body?.t);
    else if (action === "cancel") out = await cancelPurchase(cp, body?.t);
    else return sendJson(res, 404, { error: "Unknown action" }, NO_STORE);
    sendJson(res, 200, out, NO_STORE);
  } catch (e) {
    errorOut(res, e);
  }
}
