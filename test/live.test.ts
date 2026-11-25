/**
 * Live contract tests against CP. Opt-in: CP_LIVE=1 npm run test:live
 * Each read tool runs once; the shared CpHttp rate limiter keeps it at ≤ 1 req/s sustained.
 */
import { describe, expect, it } from "vitest";
import { CpService } from "../src/cp.js";
import { searchStations, stationInfo } from "../src/tools/stations.js";
import { PriceStrategy, searchFares, searchJourneys } from "../src/tools/journeys.js";
import { stationBoard } from "../src/tools/board.js";
import { trainStatus } from "../src/tools/train.js";
import { listAlerts } from "../src/tools/alerts.js";
import { classesAndRules } from "../src/tools/catalog.js";
import { addDays, lisbonNow } from "../src/time.js";

process.env.CP_LOG_SILENT = "1";
const live = process.env.CP_LIVE === "1";
const cp = new CpService();
const date = addDays(lisbonNow().date, 8);

describe.skipIf(!live)("live CP contract", () => {
  it("procurar_estacao", async () => {
    const r = await searchStations(cp, { query: "Campanhã" });
    expect(r.results[0].code).toBe("94-2006");
  });

  it("info_estacao", async () => {
    const r = await stationInfo(cp, { station: "Santa Apolónia" });
    expect(r.name).toBe("Lisboa Santa Apolónia");
    expect(r.services.length).toBeGreaterThan(0);
  });

  it("horarios", async () => {
    const r = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date });
    expect(r.options.length).toBeGreaterThan(5);
    expect(r.options.some((o) => o.prices_eur.regular !== undefined)).toBe(true);
  });

  it("precos (both classes)", async () => {
    const strategy = new PriceStrategy();
    const r = await searchFares(cp, strategy, { from: "lisboa sa", to: "porto", date });
    expect(r.options.some((o) => o.prices_eur["1"] && o.prices_eur["2"])).toBe(true);
    expect(strategy.value).toBe("combined");
  });

  it("partidas_chegadas", async () => {
    const r = await stationBoard(cp, { station: "Porto Campanhã", view: "arrivals", from_time: "00:00", date });
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("estado_comboio", async () => {
    const r = await trainStatus(cp, { train_number: 521, date });
    expect(r.stops.length).toBeGreaterThan(2);
  });

  it("perturbacoes", async () => {
    const r = await listAlerts(cp, { include_expired: true });
    expect(r.alerts.length).toBeGreaterThan(0);
    expect(r.alerts.every((a) => a.title)).toBe(true);
  });

  it("classes_e_regras", async () => {
    const r = await classesAndRules(cp);
    expect(r.calendar_limit_days).toBeGreaterThan(0);
    expect(r.service_codes?.map((s) => s.code)).toContain("AP");
  });
});
