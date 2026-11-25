import { CpHttp, BROWSER_USER_AGENT } from "./http.js";
import { StationIndex, loadAliases, type RawStation } from "./stations.js";
import { CpError } from "./errors.js";
import { lisbonNow, daysBetween, isValidDate, type Clock, systemClock } from "./time.js";
import { log } from "./log.js";

const H = 60 * 60 * 1000;
export const TTL = {
  stations: 24 * H,
  catalog: 24 * H,
  alerts: 10 * 60 * 1000,
  journeys: 2 * 60 * 1000,
  live: 15 * 1000,
} as const;

/** Front-end constant the site sends as `username`; /rules publishes it as `wks_username`. */
export const DEFAULT_USERNAME = "sivNetticket";
export const CONFIG_ID = 200;
export const ALERTS_URL =
  "https://www.cp.pt/bei/getContentsList?path=PWA/Homepage/Avisos&itensPage=-1&order=priority:desc";
export const IP_BASE = "https://servicos.infraestruturasdeportugal.pt/negocios-e-servicos";

export interface Rules {
  calendarLimitDays: number;
  minTickets: number;
  maxTickets: number;
  username: string;
  raw: { key: string; value: string; remark?: string }[];
}

export interface ServiceCode {
  code: string;
  designation: string;
}

export interface TravelClass {
  code: number;
  pt?: string;
  en?: string;
}

/** Everything the tools need, behind caches. */
export class CpService {
  readonly http: CpHttp;
  readonly clock: Clock;
  private aliases = loadAliases();

  constructor(http: CpHttp = new CpHttp(), clock: Clock = systemClock) {
    this.http = http;
    this.clock = clock;
  }

  now() {
    return lisbonNow(this.clock);
  }

  // ---------- catalog ----------

  async stations(): Promise<StationIndex> {
    return this.http.cache.getOrLoad("stations-index", TTL.stations, async () => {
      const raw = await this.http.gateway<RawStation[]>("travel", "/stations");
      if (!Array.isArray(raw)) throw new CpError("UPSTREAM_BAD_RESPONSE", "/stations did not return a list");
      return new StationIndex(raw, this.aliases);
    });
  }

  async rules(): Promise<Rules> {
    return this.http.cache.getOrLoad("rules", TTL.catalog, async () => {
      const raw = await this.http.gateway<{ ruleKey: string; value: string; remark?: string }[]>("travel", "/rules");
      const map = new Map((Array.isArray(raw) ? raw : []).map((r) => [r.ruleKey, r.value]));
      const int = (k: string, d: number) => {
        const n = Number.parseInt(map.get(k) ?? "", 10);
        return Number.isFinite(n) ? n : d;
      };
      return {
        calendarLimitDays: int("calendar_limit", 60),
        minTickets: int("min_tickets_qty", 1),
        maxTickets: int("max_tickets_qty", 9),
        // Keep the site's exact casing for the default; /rules uses different casing for the same value.
        username: DEFAULT_USERNAME,
        raw: (Array.isArray(raw) ? raw : []).map((r) => ({ key: r.ruleKey, value: r.value, remark: r.remark })),
      };
    });
  }

  /** Rules, or safe defaults when /rules is unreachable (validation must not block every tool). */
  async rulesOrDefault(): Promise<Rules> {
    try {
      return await this.rules();
    } catch (err) {
      log.warn(`could not load /rules, using defaults (${(err as Error).message})`);
      return { calendarLimitDays: 60, minTickets: 1, maxTickets: 9, username: DEFAULT_USERNAME, raw: [] };
    }
  }

  async classes(): Promise<TravelClass[]> {
    return this.http.cache.getOrLoad("classes", TTL.catalog, async () => {
      const raw = await this.http.gateway<{ code: string; longDescription: string; lang: string }[]>("travel", "/codes/classes");
      const by = new Map<number, TravelClass>();
      for (const r of Array.isArray(raw) ? raw : []) {
        const code = Number(r.code);
        if (!Number.isFinite(code)) continue;
        const c = by.get(code) ?? { code };
        if (r.lang === "PT") c.pt = r.longDescription;
        else if (r.lang === "EN") c.en = r.longDescription;
        by.set(code, c);
      }
      return [...by.values()].sort((a, b) => a.code - b.code);
    });
  }

  /**
   * Service codes as used by /journeys and the live boards (AP, IC, IR, R, U, ...).
   * Source: ticketing-api `/sale/configuration` SERVICE codes. `/trains` uses numeric codes
   * ("1" = Alfa Pendular), which do not match what journeys return, so it is not usable here.
   */
  async serviceCodes(): Promise<ServiceCode[]> {
    return this.http.cache.getOrLoad("service-codes", TTL.catalog, async () => {
      const raw = await this.http.gateway<{ configCodes?: { code: string; designation: string; type: string; status?: boolean }[] }>(
        "ticketing",
        "/sale/configuration",
        { query: { configID: CONFIG_ID, lang: "pt" } },
      );
      const codes = (raw?.configCodes ?? [])
        .filter((c) => c.type === "SERVICE" && c.status !== false && c.code)
        .map((c) => ({ code: c.code, designation: c.designation }));
      if (!codes.length) throw new CpError("UPSTREAM_BAD_RESPONSE", "/sale/configuration returned no SERVICE codes");
      return codes;
    });
  }

  async serviceCodesOrNull(): Promise<ServiceCode[] | null> {
    try {
      return await this.serviceCodes();
    } catch (err) {
      log.warn(`could not load service codes (${(err as Error).message})`);
      return null;
    }
  }

  // ---------- validation ----------

  /**
   * Validate a YYYY-MM-DD date against today (Lisbon) and calendar_limit.
   * `minOffset` lets live tools look at yesterday (-1).
   */
  async validateDate(date: string | undefined, opts: { minOffset?: number; field?: string } = {}): Promise<string> {
    const field = opts.field ?? "date";
    const today = this.now().date;
    const d = date ?? today;
    if (!isValidDate(d)) throw new CpError("INVALID_INPUT", `${field} must be a valid YYYY-MM-DD date`);
    const offset = daysBetween(today, d);
    const min = opts.minOffset ?? 0;
    if (offset < min) {
      throw new CpError("INVALID_INPUT", `${field} ${d} is in the past (today in Lisbon is ${today})`);
    }
    const { calendarLimitDays } = await this.rulesOrDefault();
    if (offset > calendarLimitDays) {
      throw new CpError("DATE_BEYOND_LIMIT", `${field} ${d} is more than ${calendarLimitDays} days ahead; CP only sells/publishes up to that limit`);
    }
    return d;
  }

  // ---------- endpoints ----------

  stationInfo(code: string): Promise<any> {
    return this.http.gateway("stations", `/stations/infos/${encodeURIComponent(code)}`, { cacheTtlMs: TTL.catalog });
  }

  journeys(body: Record<string, unknown>): Promise<any> {
    return this.http.gateway("travel", "/journeys", { method: "POST", body, cacheTtlMs: TTL.journeys });
  }

  stationTimetable(code: string, date: string, view: "DEPARTURES" | "ARRIVALS", start: string): Promise<any> {
    return this.http.gateway("travel", `/stations/${encodeURIComponent(code)}/timetable/${date}`, {
      query: { view, start },
      cacheTtlMs: TTL.live,
    });
  }

  trainTimetable(trainNumber: number, date: string): Promise<any> {
    return this.http.gateway("travel", `/trains/${trainNumber}/timetable/${date}`, { cacheTtlMs: TTL.live });
  }

  alerts(): Promise<any> {
    return this.http.plainJson(ALERTS_URL, { cacheTtlMs: TTL.alerts });
  }

  /** Infraestruturas de Portugal train timetable (fallback). Needs a browser UA or it returns 403. */
  ipTrain(trainNumber: number, date: string): Promise<any> {
    return this.http.plainJson(`${IP_BASE}/horarios-ncombio/${trainNumber}/${date}`, {
      userAgent: BROWSER_USER_AGENT,
      cacheTtlMs: TTL.live,
    });
  }
}
