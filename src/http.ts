import { ConfigStore, FE_CONFIG_URL, type FeConfig } from "./config.js";
import { RateLimiter, TtlCache } from "./cache.js";
import { CpError, upstreamMessage } from "./errors.js";
import { log } from "./log.js";

export const CP_USER_AGENT = "Mozilla/5.0 (compatible; comboios-mcp/0.1)";
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const TIMEOUT_MS = 20_000;
const RETRY_DELAYS_MS = [500, 1500];
const RETRY_STATUSES = new Set([502, 503, 504]);

export type Api = "travel" | "stations" | "ticketing";
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Extra headers, e.g. `x-cp-client-id` on ticketing calls. */
  headers?: Record<string, string>;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /** Retry on network errors and 502/503/504. Default true for reads. Never set for purchase writes. */
  retry?: boolean;
  /** Cache the parsed response for this long (ms). The key defaults to method + URL + body. */
  cacheTtlMs?: number;
  cacheKey?: string;
}

export interface CpHttpDeps {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
}

/** Pause after CP refuses us (429): 10 min, doubling on each refusal up to 1 h. */
const BREAKER_BASE_MS = 10 * 60 * 1000;
const BREAKER_MAX_MS = 60 * 60 * 1000;

export const CP_UNAVAILABLE_MESSAGE =
  "A CP não está a aceitar pedidos deste serviço neste momento. Tente mais tarde ou use cp.pt. " +
  "(CP is not accepting requests from this service right now; try again later or use cp.pt.)";

/**
 * Circuit breaker for CP's api-gateway. When CP answers 429, stop calling it for a while instead of
 * repeating the request for every user; after the pause one request probes again.
 */
export class CpBreaker {
  private openUntil = 0;
  private pauseMs = 0;
  private probing = false;

  constructor(private readonly now: () => number = Date.now) {}

  /** Throws while open. After the pause, lets exactly one request through as a probe. */
  check(): void {
    const t = this.now();
    if (this.pauseMs === 0) return;
    if (t < this.openUntil || this.probing) throw this.error();
    this.probing = true;
  }

  /** The probe failed for a reason other than a refusal (network, config): let the next request probe. */
  release(): void {
    this.probing = false;
  }

  success(): void {
    if (this.pauseMs) log.info("CP accepted requests again; resuming");
    this.pauseMs = 0;
    this.openUntil = 0;
    this.probing = false;
  }

  refused(): CpError {
    this.pauseMs = this.pauseMs ? Math.min(this.pauseMs * 2, BREAKER_MAX_MS) : BREAKER_BASE_MS;
    this.openUntil = this.now() + this.pauseMs;
    this.probing = false;
    log.warn(`CP refused requests (429); pausing calls for ${Math.round(this.pauseMs / 60000)} min`);
    return this.error();
  }

  get retryAfterSeconds(): number {
    return Math.max(0, Math.ceil((this.openUntil - this.now()) / 1000));
  }

  private error(): CpError {
    return new CpError("CP_UNAVAILABLE", CP_UNAVAILABLE_MESSAGE, 503, { retry_after_seconds: this.retryAfterSeconds });
  }
}

/** The single HTTP entry point: headers, timeout, retries, rate limiting, caching, 401 refresh, 429 breaker. */
export class CpHttp {
  readonly config: ConfigStore;
  readonly cache: TtlCache;
  readonly breaker: CpBreaker;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: RateLimiter;

  constructor(deps: CpHttpDeps = {}) {
    this.fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
    const now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = deps.limiter ?? new RateLimiter(1, 3, now, this.sleep);
    this.cache = new TtlCache(now);
    this.breaker = new CpBreaker(now);
    this.config = new ConfigStore(
      () => this.plainJson(FE_CONFIG_URL, { retry: true }),
      now,
    );
  }

  /** Call an api-gateway service with the CP connect headers. */
  async gateway<T = unknown>(api: Api, path: string, opts: RequestOptions = {}): Promise<T> {
    const run = () => this.gatewayUncached<T>(api, path, opts);
    if (!opts.cacheTtlMs) return run();
    const key = opts.cacheKey ?? `${api}:${opts.method ?? "GET"}:${path}:${JSON.stringify(opts.query ?? {})}:${JSON.stringify(opts.body ?? null)}`;
    return this.cache.getOrLoad(key, opts.cacheTtlMs, run);
  }

  private async gatewayUncached<T>(api: Api, path: string, opts: RequestOptions): Promise<T> {
    this.breaker.check();
    let loaded: Awaited<ReturnType<ConfigStore["get"]>>;
    try {
      loaded = await this.config.get();
    } catch (err) {
      this.breaker.release(); // not a CP refusal; free the probe slot if we held one
      throw err;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = buildUrl(baseUrl(loaded.config, api), path, opts.query);
      let res: Response;
      try {
        res = await this.send(url, {
          method: opts.method ?? "GET",
          headers: { ...gatewayHeaders(loaded.config, api, opts.body !== undefined), ...(opts.headers ?? {}) },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        }, opts.retry ?? true);
      } catch (err) {
        this.breaker.release(); // network trouble is not a refusal
        throw err;
      }
      if (res.status === 429) {
        await drain(res);
        throw this.breaker.refused();
      }
      this.breaker.success();
      if (res.status === 401) {
        await drain(res);
        if (attempt === 0) {
          log.warn("api-gateway returned 401; refreshing fe-config");
          loaded = await this.config.refresh(loaded.generation);
          continue;
        }
        throw new CpError("CREDENTIALS_REJECTED", "CP credentials rejected; site config may have changed", 401);
      }
      return parseResponse<T>(res, api);
    }
    throw new CpError("CREDENTIALS_REJECTED", "CP credentials rejected; site config may have changed", 401);
  }

  /** GET a non-gateway JSON URL (cp.pt content, Infraestruturas de Portugal). */
  async plainJson<T = unknown>(url: string, opts: { userAgent?: string; retry?: boolean; cacheTtlMs?: number } = {}): Promise<T> {
    const run = async () => {
      const res = await this.send(url, {
        method: "GET",
        headers: { Accept: "application/json", "User-Agent": opts.userAgent ?? CP_USER_AGENT },
      }, opts.retry ?? true);
      return parseResponse<T>(res, hostOf(url));
    };
    if (!opts.cacheTtlMs) return run();
    return this.cache.getOrLoad(`plain:${url}`, opts.cacheTtlMs, run);
  }

  private async send(url: string, init: RequestInit, retry: boolean): Promise<Response> {
    const attempts = retry ? RETRY_DELAYS_MS.length + 1 : 1;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(RETRY_DELAYS_MS[i - 1]);
      await this.limiter.acquire();
      try {
        const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (retry && RETRY_STATUSES.has(res.status) && i < attempts - 1) {
          log.warn(`${hostOf(url)} returned ${res.status}; retrying`);
          await drain(res);
          continue;
        }
        return res;
      } catch (err) {
        lastError = err;
        log.warn(`request to ${hostOf(url)} failed (${errName(err)})${retry && i < attempts - 1 ? "; retrying" : ""}`);
      }
    }
    if (isTimeout(lastError)) throw new CpError("UPSTREAM_TIMEOUT", `${hostOf(url)} did not answer within 20 s`);
    throw new CpError("UPSTREAM_UNREACHABLE", `Could not reach ${hostOf(url)}: ${errName(lastError)}`);
  }
}

function baseUrl(c: FeConfig, api: Api): string {
  return api === "travel" ? c.travelApiUrl : api === "stations" ? c.stationsApiUrl : c.ticketingApiUrl;
}

function gatewayHeaders(c: FeConfig, api: Api, hasBody: boolean): Record<string, string> {
  const key = api === "travel" ? c.travelApiKey : api === "stations" ? c.stationsApiKey : c.ticketingApiKey;
  const h: Record<string, string> = {
    "x-cp-connect-id": c.xcck,
    "x-cp-connect-secret": c.xccs,
    Accept: "application/json",
    "User-Agent": CP_USER_AGENT,
  };
  if (key) h["X-Api-Key"] = key;
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}

export function buildUrl(base: string, path: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(base.replace(/\/+$/, "") + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

async function parseResponse<T>(res: Response, source: string): Promise<T> {
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const msg = upstreamMessage(body) ?? `HTTP ${res.status}`;
    const code = res.status === 404 ? "NOT_FOUND" : res.status === 403 ? "FORBIDDEN" : "UPSTREAM_ERROR";
    throw new CpError(code, `${source}: ${msg}`, res.status, upstreamDetails(body));
  }
  if (body === undefined) throw new CpError("UPSTREAM_BAD_RESPONSE", `${source} returned a non-JSON response`, res.status);
  return body as T;
}

function upstreamDetails(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ["description", "message", "error", "code"]) if (b[k] !== undefined) out[`upstream_${k}`] = b[k];
  return Object.keys(out).length ? out : undefined;
}

async function drain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    /* ignore */
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "upstream";
  }
}

function errName(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    return cause?.code ?? cause?.message ?? err.message;
  }
  return String(err);
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}
