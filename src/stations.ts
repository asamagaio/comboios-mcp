import { createRequire } from "node:module";
import { CpError } from "./errors.js";

export interface Station {
  code: string;
  name: string;
  lat: number | null;
  lon: number | null;
}

export interface RankedStation extends Station {
  score: number;
}

export interface RawStation {
  code: string;
  designation: string;
  latitude?: string | number | null;
  longitude?: string | number | null;
}

const CODE_RE = /^94-\d+$/;
/** Below this score a fuzzy match is not trusted for resolution. */
const RESOLVE_MIN_SCORE = 0.6;
/** Below this score a candidate is dropped from search results. */
const SEARCH_MIN_SCORE = 0.4;
/** Top-2 scores closer than this (relative) make a fuzzy resolution ambiguous. */
const AMBIGUITY_MARGIN = 0.05;

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[-.'’,()/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function loadAliases(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const raw = require("./aliases.json") as Record<string, string>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("_")) out[normalize(k)] = v;
  return out;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class StationIndex {
  readonly byCode = new Map<string, Station>();
  private readonly entries: { station: Station; norm: string; tokens: string[] }[] = [];
  private readonly exact = new Map<string, Station>();

  constructor(raw: RawStation[], aliases: Record<string, string> = {}) {
    for (const r of raw) {
      if (!r?.code || !r?.designation) continue;
      const station: Station = { code: r.code, name: r.designation, lat: toNum(r.latitude), lon: toNum(r.longitude) };
      this.byCode.set(station.code, station);
      const norm = normalize(station.name);
      this.entries.push({ station, norm, tokens: norm.split(" ") });
      if (!this.exact.has(norm)) this.exact.set(norm, station);
    }
    for (const [alias, code] of Object.entries(aliases)) {
      const st = this.byCode.get(code);
      if (st) this.exact.set(normalize(alias), st);
    }
  }

  get size(): number {
    return this.byCode.size;
  }

  /** Ranked fuzzy search. Never throws for ambiguity. */
  search(query: string, limit = 5): RankedStation[] {
    const q = normalize(query);
    if (!q) return [];
    if (CODE_RE.test(query.trim())) {
      const st = this.byCode.get(query.trim());
      return st ? [{ ...st, score: 1 }] : [];
    }
    const exact = this.exact.get(q);
    const ranked = this.rank(q).filter((r) => r.score >= SEARCH_MIN_SCORE);
    if (exact) {
      const rest = ranked.filter((r) => r.code !== exact.code);
      return [{ ...exact, score: 1 }, ...rest].slice(0, limit);
    }
    return ranked.slice(0, limit);
  }

  /**
   * Resolve free text or a code to one station.
   * Order: code, exact designation/alias (no ambiguity check), fuzzy rank with ambiguity guard.
   */
  resolve(query: string): Station {
    const trimmed = query.trim();
    if (CODE_RE.test(trimmed)) {
      const st = this.byCode.get(trimmed);
      if (!st) throw new CpError("STATION_NOT_FOUND", `No station with code ${trimmed}`);
      return st;
    }
    const q = normalize(trimmed);
    if (!q) throw new CpError("STATION_NOT_FOUND", "Empty station name");
    const exact = this.exact.get(q);
    if (exact) return exact;

    const ranked = this.rank(q);
    const [top, second] = ranked;
    if (!top || top.score < RESOLVE_MIN_SCORE) {
      throw new CpError("STATION_NOT_FOUND", `No station matches "${query}"`, undefined, {
        suggestions: ranked.filter((r) => r.score >= SEARCH_MIN_SCORE).slice(0, 5).map(brief),
      });
    }
    if (second && (top.score - second.score) / top.score < AMBIGUITY_MARGIN) {
      const candidates = ranked.filter((r) => (top.score - r.score) / top.score < AMBIGUITY_MARGIN * 3).slice(0, 8);
      throw new CpError(
        "AMBIGUOUS_STATION",
        `"${query}" matches several stations; use one of the codes or a more specific name`,
        undefined,
        { candidates: candidates.map(brief) },
      );
    }
    return stripScore(top);
  }

  private rank(q: string): RankedStation[] {
    const qTokens = q.split(" ");
    const out: RankedStation[] = [];
    for (const e of this.entries) {
      const score = scoreMatch(q, qTokens, e.norm, e.tokens);
      if (score > 0) out.push({ ...e.station, score: round(score) });
    }
    return out.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  }
}

/**
 * Score tiers: prefix of the full name (0.9–0.99) > every query token is a prefix of a name token
 * (0.8–0.89) > edit-distance similarity (≤ 0.8).
 */
export function scoreMatch(q: string, qTokens: string[], d: string, dTokens: string[]): number {
  if (d === q) return 1;
  if (d.startsWith(q)) return 0.9 + 0.09 * (q.length / d.length);
  const subset = qTokens.every((qt) => dTokens.some((dt) => dt.startsWith(qt)));
  if (subset) return 0.8 + 0.09 * (q.replace(/ /g, "").length / d.replace(/ /g, "").length);
  let best = levRatio(q, d);
  const n = qTokens.length;
  for (let i = 0; i + n <= dTokens.length; i++) {
    best = Math.max(best, levRatio(q, dTokens.slice(i, i + n).join(" ")) * 0.98);
  }
  return best * 0.8;
}

export function levRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function stripScore(r: RankedStation): Station {
  const { score: _s, ...st } = r;
  return st;
}

function brief(r: RankedStation): { code: string; name: string; score: number } {
  return { code: r.code, name: r.name, score: r.score };
}
