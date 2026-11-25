/** In-memory TTL cache with in-flight de-duplication. */
export class TtlCache {
  private store = new Map<string, { value: unknown; expires: number }>();
  private inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = Date.now) {}

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && hit.expires > this.now()) return hit.value as T;
    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;
    const p = (async () => {
      try {
        const value = await load();
        this.store.set(key, { value, expires: this.now() + ttlMs });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.store.clear();
  }
}

/** Global token bucket: `rate` tokens per second, up to `burst`. */
export class RateLimiter {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rate = 1,
    private readonly burst = 3,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Resolves when the caller may send one request. Calls are served in FIFO order. */
  acquire(): Promise<void> {
    const next = this.queue.then(() => this.take());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async take(): Promise<void> {
    for (;;) {
      const t = this.now();
      this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
      this.last = t;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil(((1 - this.tokens) / this.rate) * 1000));
    }
  }
}
