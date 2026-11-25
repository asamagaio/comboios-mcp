import { describe, expect, it } from "vitest";
import { CpHttp } from "../src/http.js";
import { RateLimiter } from "../src/cache.js";
import { FAKE_CONFIG, fakeFetch, on, type Route } from "./helpers.js";

const instant = async () => {};

function makeHttp(routes: Route[]) {
  const { fn, calls } = fakeFetch(routes);
  const http = new CpHttp({ fetch: fn, sleep: instant, limiter: new RateLimiter(1e6, 1e6, Date.now, instant) });
  return { http, calls };
}

describe("credential refresh", () => {
  it("N concurrent 401s trigger exactly one fe-config fetch", async () => {
    let configFetches = 0;
    const { http, calls } = makeHttp([
      on("fe-config.json", () => {
        configFetches++;
        return { ...FAKE_CONFIG, xccs: configFetches === 1 ? "old-secret" : "new-secret" };
      }),
      (c) => {
        if (!c.url.includes("/travel-api/stations")) return undefined;
        const fresh = c.headers["x-cp-connect-secret"] === "new-secret";
        return fresh ? { body: [] } : { status: 401, body: { moreInformation: "Invalid client id or secret." } };
      },
    ]);
    await http.config.get();
    expect(configFetches).toBe(1);
    const results = await Promise.all(Array.from({ length: 8 }, () => http.gateway("travel", "/stations")));
    expect(results.every((r) => Array.isArray(r))).toBe(true);
    expect(configFetches).toBe(2);
    expect(calls.filter((c) => c.url.includes("fe-config")).length).toBe(2);
  });

  it("fails clearly when refresh still yields 401", async () => {
    const { http } = makeHttp([
      on("fe-config.json", FAKE_CONFIG),
      on("/travel-api/stations", { moreInformation: "Invalid client id or secret." }, 401),
    ]);
    await expect(http.gateway("travel", "/stations")).rejects.toMatchObject({
      code: "CREDENTIALS_REJECTED",
      message: "CP credentials rejected; site config may have changed",
    });
  });

  it("sends the connect headers and API key on gateway calls", async () => {
    const { http, calls } = makeHttp([on("fe-config.json", FAKE_CONFIG), on("/stations-api/", {})]);
    await http.gateway("stations", "/stations/infos/94-30007");
    const h = calls.at(-1)!.headers;
    expect(h).toMatchObject({ "x-cp-connect-id": "test-id", "x-cp-connect-secret": "test-secret", "X-Api-Key": "sk", Accept: "application/json" });
  });
});

describe("retries", () => {
  it("retries 503 on reads up to twice", async () => {
    let n = 0;
    const { http } = makeHttp([
      on("fe-config.json", FAKE_CONFIG),
      ((c) => (c.url.includes("/rules") ? (++n < 3 ? { status: 503, body: {} } : { body: [] }) : undefined)) as Route,
    ]);
    await expect(http.gateway("travel", "/rules")).resolves.toEqual([]);
    expect(n).toBe(3);
  });

  it("gives up after 2 retries", async () => {
    const { http, calls } = makeHttp([on("fe-config.json", FAKE_CONFIG), on("/rules", {}, 502)]);
    await expect(http.gateway("travel", "/rules")).rejects.toMatchObject({ code: "UPSTREAM_ERROR", httpStatus: 502 });
    expect(calls.filter((c) => c.url.includes("/rules")).length).toBe(3);
  });

  it("does not retry when retry is false (purchase writes)", async () => {
    const { http, calls } = makeHttp([on("fe-config.json", FAKE_CONFIG), on("/sale", {}, 503)]);
    await expect(http.gateway("ticketing", "/sale", { method: "POST", body: {}, retry: false })).rejects.toMatchObject({ httpStatus: 503 });
    expect(calls.filter((c) => c.url.endsWith("/sale")).length).toBe(1);
  });

  it("retries network errors such as an abrupt TLS close", async () => {
    let n = 0;
    const fetchImpl = async (url: string) => {
      if (url.includes("fe-config")) return new Response(JSON.stringify(FAKE_CONFIG));
      if (++n === 1) throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return new Response("[]");
    };
    const http = new CpHttp({ fetch: fetchImpl, sleep: instant, limiter: new RateLimiter(1e6, 1e6, Date.now, instant) });
    await expect(http.gateway("travel", "/rules")).resolves.toEqual([]);
    expect(n).toBe(2);
  });

  it("surfaces upstream description fields", async () => {
    const { http } = makeHttp([on("fe-config.json", FAKE_CONFIG), on("/sale", { description: "SIV:SLE:15", error: "x" }, 400)]);
    await expect(http.gateway("ticketing", "/sale", { method: "POST", body: {}, retry: false })).rejects.toMatchObject({
      httpStatus: 400,
      details: { upstream_description: "SIV:SLE:15" },
    });
  });
});

describe("caching and rate limiting", () => {
  it("caches by key and de-duplicates concurrent loads", async () => {
    const { http, calls } = makeHttp([on("fe-config.json", FAKE_CONFIG), on("/rules", [])]);
    await Promise.all([1, 2, 3].map(() => http.gateway("travel", "/rules", { cacheTtlMs: 60_000 })));
    await http.gateway("travel", "/rules", { cacheTtlMs: 60_000 });
    expect(calls.filter((c) => c.url.includes("/rules")).length).toBe(1);
  });

  it("token bucket allows a burst of 3 then waits ~1 s per request", async () => {
    let t = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter(1, 3, () => t, async (ms) => {
      waits.push(ms);
      t += ms;
    });
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(waits).toEqual([1000, 1000]);
  });
});
