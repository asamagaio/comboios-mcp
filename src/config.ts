import { CpError } from "./errors.js";
import { log } from "./log.js";

export const FE_CONFIG_URL = "https://www.cp.pt/fe-config.json";
const REFRESH_MS = 6 * 60 * 60 * 1000;

/** Public front-end values published by cp.pt. Never log these. */
export interface FeConfig {
  xcck: string;
  xccs: string;
  travelApiUrl: string;
  travelApiKey?: string;
  stationsApiUrl: string;
  stationsApiKey?: string;
  ticketingApiUrl: string;
  ticketingApiKey?: string;
  kcBasePath?: string;
  kcRealm?: string;
  kcClientId?: string;
}

const REQUIRED: (keyof FeConfig)[] = ["xcck", "xccs", "travelApiUrl", "stationsApiUrl", "ticketingApiUrl"];

export interface LoadedConfig {
  config: FeConfig;
  /** Increments on every successful load; lets callers tell whether a refresh already happened. */
  generation: number;
}

export type RawFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Loads fe-config.json, caches it for 6 h and refreshes on demand.
 * Refresh is single-flight: concurrent callers share one in-flight request.
 */
export class ConfigStore {
  private current?: LoadedConfig;
  private loadedAt = 0;
  private inflight?: Promise<LoadedConfig>;
  private generation = 0;

  constructor(
    private readonly fetchConfig: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<LoadedConfig> {
    if (this.current && this.now() - this.loadedAt < REFRESH_MS) return this.current;
    return this.refresh();
  }

  /**
   * Force a reload. If `staleGeneration` is given and a newer config is already loaded,
   * returns it without fetching (another caller refreshed in the meantime).
   */
  refresh(staleGeneration?: number): Promise<LoadedConfig> {
    if (staleGeneration !== undefined && this.current && this.current.generation > staleGeneration) {
      return Promise.resolve(this.current);
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const raw = await this.fetchConfig();
        const config = validate(raw);
        this.generation += 1;
        this.current = { config, generation: this.generation };
        this.loadedAt = this.now();
        log.info(`fe-config loaded (generation ${this.generation})`);
        return this.current;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

function validate(raw: unknown): FeConfig {
  if (!raw || typeof raw !== "object") {
    throw new CpError("CONFIG_INVALID", "cp.pt fe-config.json did not return an object");
  }
  const r = raw as Record<string, unknown>;
  const missing = REQUIRED.filter((k) => typeof r[k] !== "string" || !r[k]);
  if (missing.length) {
    // Key names are fine to report; values are not.
    throw new CpError("CONFIG_INVALID", `cp.pt fe-config.json is missing keys: ${missing.join(", ")}`);
  }
  return r as unknown as FeConfig;
}
