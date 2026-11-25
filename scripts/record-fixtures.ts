/**
 * Records read-only CP responses into test/fixtures/. Responses are public timetable data and
 * contain no personal data or credentials. Usage: npm run record-fixtures -- [YYYY-MM-DD]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CpHttp, BROWSER_USER_AGENT } from "../src/http.js";
import { ALERTS_URL, IP_BASE } from "../src/cp.js";
import { lisbonNow, addDays } from "../src/time.js";

const dir = join(import.meta.dirname, "..", "test", "fixtures");
mkdirSync(dir, { recursive: true });
const http = new CpHttp();
const today = lisbonNow().date;
const date = process.argv[2] ?? addDays(today, 8);

const save = (name: string, data: unknown) => {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 1) + "\n");
  console.log(`saved ${name}.json`);
};

const journeyBody = (classes: number[], from = "94-30007", to = "94-2006") => ({
  departureStationCode: from,
  arrivalStationCode: to,
  travelDate: date,
  returnDate: null,
  classes,
  quantities: [{ quantity: 1, type: 1 }],
  configID: 200,
  lang: "PT",
  saleableOnly: false,
  searchType: 3,
  services: [],
  timeLimit: { startTime: "00:00", endTime: "23:59", limitType: 0 },
  returnTimeLimit: { startTime: "00:00", endTime: "23:59", limitType: 0 },
  username: "sivNetticket",
});

save("stations", await http.gateway("travel", "/stations"));
save("station-info-94-30007", await http.gateway("stations", "/stations/infos/94-30007"));
save("journeys-lisboa-porto-c2", await http.gateway("travel", "/journeys", { method: "POST", body: journeyBody([2]) }));
save("journeys-lisboa-porto-c12", await http.gateway("travel", "/journeys", { method: "POST", body: journeyBody([1, 2]) }));
// Cascais line: Urbano only, second class only.
save("journeys-cascais-c12", await http.gateway("travel", "/journeys", { method: "POST", body: journeyBody([1, 2], "94-69005", "94-69260") }));
save("board-campanha-arrivals", await http.gateway("travel", `/stations/94-2006/timetable/${today}`, { query: { view: "ARRIVALS", start: "08:00" } }));
save("train-521", await http.gateway("travel", `/trains/521/timetable/${date}`));
save("rules", await http.gateway("travel", "/rules"));
save("classes", await http.gateway("travel", "/codes/classes"));
const conf = await http.gateway<any>("ticketing", "/sale/configuration", { query: { configID: 200, lang: "pt" } });
save("sale-configuration", { configCodes: conf.configCodes });
const alerts = await http.plainJson<any>(ALERTS_URL);
save("alerts", { ...alerts, item: alerts.item.slice(0, 5) });
save("ip-train-521", await http.plainJson(`${IP_BASE}/horarios-ncombio/521/${today}`, { userAgent: BROWSER_USER_AGENT }));
