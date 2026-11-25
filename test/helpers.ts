import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CpHttp } from "../src/http.js";
import { CpService } from "../src/cp.js";
import { RateLimiter } from "../src/cache.js";

process.env.CP_LOG_SILENT = "1";

export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${name}.json`), "utf8"));
}

export const FAKE_CONFIG = {
  xcck: "test-id",
  xccs: "test-secret",
  travelApiUrl: "https://gw.test/travel-api",
  travelApiKey: "tk",
  stationsApiUrl: "https://gw.test/stations-api",
  stationsApiKey: "sk",
  ticketingApiUrl: "https://gw.test/ticketing-api",
  ticketingApiKey: "kk",
};

export interface Call {
  url: string;
  method: string;
  body?: any;
  headers: Record<string, string>;
}

export type Route = (call: Call) => { status?: number; body: unknown } | undefined;

/** Fake fetch: first matching route wins; unmatched URLs return 404. */
export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    for (const r of routes) {
      const out = r(call);
      if (out) return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
    }
    return new Response(JSON.stringify({ httpCode: "404", moreInformation: "No resources match requested URI" }), { status: 404 });
  };
  return { fn, calls };
}

export const on =
  (pattern: RegExp | string, body: unknown | ((c: Call) => unknown), status = 200, method?: string): Route =>
  (c) => {
    const hit = typeof pattern === "string" ? c.url.includes(pattern) : pattern.test(c.url);
    if (!hit || (method && c.method !== method)) return undefined;
    return { status, body: typeof body === "function" ? (body as (c: Call) => unknown)(c) : body };
  };

/** Routes for the static catalog every tool may touch. */
export function baseRoutes(): Route[] {
  return [
    on("fe-config.json", FAKE_CONFIG),
    on(/travel-api\/stations$/, fixture("stations")),
    on(/travel-api\/rules$/, fixture("rules")),
    on(/travel-api\/codes\/classes$/, fixture("classes")),
    on("/sale/configuration?", fixture("sale-configuration")),
  ];
}

/** A Date for a given Lisbon wall-clock time (Lisbon is UTC+0 in November). */
export function lisbon(date: string, time: string): Date {
  return new Date(`${date}T${time}:00Z`);
}

export function makeCp(routes: Route[], now: Date = lisbon("2026-11-22", "12:00")) {
  const { fn, calls } = fakeFetch([...routes, ...baseRoutes()]);
  const instant = async () => {};
  const http = new CpHttp({ fetch: fn, sleep: instant, limiter: new RateLimiter(1e6, 1e6, Date.now, instant) });
  const cp = new CpService(http, () => now);
  return { cp, http, calls };
}
