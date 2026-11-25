import { CpError } from "./errors.js";

/**
 * Self-contained journey option ids, so any server instance can resolve them (no shared state):
 *
 *   2026-11-30_94-30007_94-2006_c2_p1_out521
 *   2026-11-30_94-30007_94-2006_c2_p2_r2026-12-02_ret4411+182
 *
 * date, origin code, destination code, class, passengers, optional return date, then the direction
 * and the train numbers of every leg. Resolving re-runs the same search and matches the trains.
 */
export interface OptionRef {
  date: string;
  from: string;
  to: string;
  travelClass: number;
  passengers: number;
  returnDate: string | null;
  direction: "out" | "ret";
  trains: number[];
}

const RE =
  /^(\d{4}-\d{2}-\d{2})_(94-\d+)_(94-\d+)_c([12])_p(\d)(?:_r(\d{4}-\d{2}-\d{2}))?_(out|ret)(\d+(?:\+\d+)*)$/;

export function encodeOptionId(r: OptionRef): string {
  return [
    r.date,
    r.from,
    r.to,
    `c${r.travelClass}`,
    `p${r.passengers}`,
    ...(r.returnDate ? [`r${r.returnDate}`] : []),
    `${r.direction}${r.trains.join("+")}`,
  ].join("_");
}

export function parseOptionId(id: string): OptionRef {
  const m = RE.exec(id.trim());
  if (!m) {
    throw new CpError("INVALID_OPTION_ID", "option_id is not valid; copy it exactly from horarios (e.g. 2026-11-30_94-30007_94-2006_c2_p1_out521)");
  }
  return {
    date: m[1],
    from: m[2],
    to: m[3],
    travelClass: Number(m[4]),
    passengers: Number(m[5]),
    returnDate: m[6] ?? null,
    direction: m[7] as "out" | "ret",
    trains: m[8].split("+").map(Number),
  };
}

export function tripTrains(trip: any): number[] {
  return (Array.isArray(trip?.travelSections) ? trip.travelSections : []).map((s: any) => Number(s?.trainNumber));
}

/**
 * The same journey as a one-way purchase: a return leg becomes date = return date with origin and
 * destination swapped; an outward leg simply drops the return date. CP sells each direction separately.
 */
export function asOneWay(r: OptionRef): OptionRef {
  if (r.direction === "ret") {
    if (!r.returnDate) throw new CpError("INVALID_OPTION_ID", "Return option without a return date");
    return { ...r, date: r.returnDate, from: r.to, to: r.from, returnDate: null, direction: "out" };
  }
  return { ...r, returnDate: null };
}
