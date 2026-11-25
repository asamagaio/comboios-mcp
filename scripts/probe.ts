/**
 * Smoke test: call each read endpoint once and print [OK ] / [ERR] with the HTTP status.
 * Equivalent of the research probe.py. Usage: npm run probe -- [YYYY-MM-DD]
 */
import { CpHttp, BROWSER_USER_AGENT } from "../src/http.js";
import { ALERTS_URL, IP_BASE } from "../src/cp.js";
import { CpError } from "../src/errors.js";
import { addDays, lisbonNow } from "../src/time.js";

process.env.CP_LOG_SILENT = "1";
const http = new CpHttp();
const today = lisbonNow().date;
const date = process.argv[2] ?? addDays(today, 8);

const checks: [string, () => Promise<unknown>][] = [
  ["fe-config", () => http.config.refresh()],
  ["GET  T/stations", () => http.gateway("travel", "/stations")],
  ["GET  S/stations/infos/94-30007", () => http.gateway("stations", "/stations/infos/94-30007")],
  ["POST T/journeys", () => http.gateway("travel", "/journeys", {
    method: "POST",
    body: {
      departureStationCode: "94-30007", arrivalStationCode: "94-2006", travelDate: date, returnDate: null,
      classes: [2], quantities: [{ quantity: 1, type: 1 }], configID: 200, lang: "PT", saleableOnly: false,
      searchType: 3, services: [], timeLimit: { startTime: "00:00", endTime: "23:59", limitType: 0 },
      returnTimeLimit: { startTime: "00:00", endTime: "23:59", limitType: 0 }, username: "sivNetticket",
    },
  })],
  ["GET  T/stations/94-30007/timetable", () => http.gateway("travel", `/stations/94-30007/timetable/${today}`, { query: { view: "DEPARTURES", start: "00:00" } })],
  ["GET  T/trains/521/timetable", () => http.gateway("travel", `/trains/521/timetable/${date}`)],
  ["GET  T/trains", () => http.gateway("travel", "/trains")],
  ["GET  T/codes/classes", () => http.gateway("travel", "/codes/classes")],
  ["GET  T/rules", () => http.gateway("travel", "/rules")],
  ["GET  K/sale/configuration", () => http.gateway("ticketing", "/sale/configuration", { query: { configID: 200, lang: "pt" } })],
  ["GET  cp.pt alerts", () => http.plainJson(ALERTS_URL)],
  ["GET  IP horarios-ncombio (fallback)", () => http.plainJson(`${IP_BASE}/horarios-ncombio/521/${today}`, { userAgent: BROWSER_USER_AGENT })],
];

let failed = 0;
for (const [name, fn] of checks) {
  const t = Date.now();
  try {
    await fn();
    console.log(`[OK ] 200 ${name} (${Date.now() - t} ms)`);
  } catch (err) {
    failed++;
    const status = err instanceof CpError ? err.httpStatus ?? "---" : "---";
    console.log(`[ERR] ${status} ${name}: ${(err as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
