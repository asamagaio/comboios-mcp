import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService, ServiceCode } from "../cp.js";
import { CpError } from "../errors.js";
import { htmlToText } from "../html.js";
import { fromMinutes, isValidTime, toMinutes } from "../time.js";
import { handler, hhmm, num, READ_ONLY, station, str } from "./common.js";
import type { Station } from "../stations.js";
import { buildSearchUrl } from "../cplink.js";
import { encodeOptionId, parseOptionId, tripTrains } from "../options.js";
import { buyUrl, paymentsEnabled } from "../public.js";
import { HORARIOS_UI, uiMeta } from "../ui.js";

/** priceType 1 = regular fare, 4 = promo (non-refundable). 100/104 mirror them; meaning unverified. */
const PRICE_REGULAR = 1;
const PRICE_PROMO = 4;

export interface JourneyArgs {
  from: string;
  to: string;
  date?: string;
  return_date?: string;
  after?: string;
  before?: string;
  travel_class?: number;
  passengers?: number;
  services?: string[];
  direct_only?: boolean;
  lang?: "PT" | "EN";
}

// ---------- option ids (stateless; see src/options.ts) ----------

export interface ResolvedOption {
  search: { from: Station; to: Station; date: string; returnDate: string | null; travelClass: number; passengers: number };
  trip: any;
  direction: "out" | "ret";
}

/** Re-run the search an option id came from (usually a cache hit) and find the trip by its trains. */
export async function resolveOption(cp: CpService, optionId: string): Promise<ResolvedOption> {
  const ref = parseOptionId(optionId);
  const p = await prepareSearch(cp, {
    from: ref.from,
    to: ref.to,
    date: ref.date,
    return_date: ref.returnDate ?? undefined,
    passengers: ref.passengers,
  });
  const res = await cp.journeys(
    buildJourneyBody({
      from: p.from.code,
      to: p.to.code,
      date: p.date,
      returnDate: p.returnDate,
      classes: [ref.travelClass],
      passengers: p.passengers,
      lang: "PT",
      timeLimit: p.timeLimit,
      returnTimeLimit: p.returnTimeLimit,
      username: p.username,
    }),
  );
  const list: any[] = (ref.direction === "out" ? res?.outwardTrip : res?.returnTrip) ?? [];
  const want = ref.trains.join("+");
  const trip = list.find((t) => tripTrains(t).join("+") === want);
  if (!trip) {
    throw new CpError("OPTION_NOT_FOUND", "That journey is no longer offered (it may have departed or sold out); run horarios again");
  }
  return {
    search: { from: p.from, to: p.to, date: p.date, returnDate: p.returnDate, travelClass: ref.travelClass, passengers: p.passengers },
    trip,
    direction: ref.direction,
  };
}

// ---------- request building ----------

export interface TimeLimit {
  startTime: string;
  endTime: string;
  limitType: number;
}

/**
 * limitType observed live: 0 = whole day (window ignored), 2 = departure within window,
 * 1 = filters by arrival. The site sends 2 with the current time when the date is today.
 */
export function outwardTimeLimit(isToday: boolean, nowHHMM: string, after?: string, before?: string): TimeLimit {
  if (isToday) {
    const start = after && toMinutes(after) > toMinutes(nowHHMM) ? after : nowHHMM;
    return { startTime: start, endTime: before ?? "23:59", limitType: 2 };
  }
  if (after || before) return { startTime: after ?? "00:00", endTime: before ?? "23:59", limitType: 2 };
  return { startTime: "00:00", endTime: "23:59", limitType: 0 };
}

export function returnTimeLimit(isToday: boolean, nowMinutes: number): TimeLimit {
  if (!isToday) return { startTime: "00:00", endTime: "23:59", limitType: 0 };
  const start = Math.min(nowMinutes + 15, 23 * 60 + 59);
  return { startTime: fromMinutes(start), endTime: "23:59", limitType: 2 };
}

export function buildJourneyBody(p: {
  from: string;
  to: string;
  date: string;
  returnDate: string | null;
  classes: number[];
  passengers: number;
  lang: "PT" | "EN";
  timeLimit: TimeLimit;
  returnTimeLimit: TimeLimit;
  username: string;
}): Record<string, unknown> {
  return {
    departureStationCode: p.from,
    arrivalStationCode: p.to,
    travelDate: p.date,
    returnDate: p.returnDate,
    classes: p.classes,
    quantities: [{ quantity: p.passengers, type: 1 }],
    configID: 200,
    lang: p.lang,
    saleableOnly: false,
    searchType: 3,
    services: [],
    timeLimit: p.timeLimit,
    returnTimeLimit: p.returnTimeLimit,
    username: p.username,
  };
}

// ---------- response mapping ----------

const cents = (v: unknown) => {
  const n = num(v);
  return n === null ? undefined : Math.round(n) / 100;
};

export function pricesForClass(basePrices: any[], travelClass: number): { regular?: number; promo_non_refundable?: number } {
  const out: { regular?: number; promo_non_refundable?: number } = {};
  for (const p of Array.isArray(basePrices) ? basePrices : []) {
    if (Number(p?.travelClass) !== travelClass) continue;
    if (Number(p.priceType) === PRICE_REGULAR && out.regular === undefined) out.regular = cents(p.centsValue);
    if (Number(p.priceType) === PRICE_PROMO && out.promo_non_refundable === undefined) out.promo_non_refundable = cents(p.centsValue);
  }
  return out;
}

export function classesPresent(trips: any[]): Set<number> {
  const s = new Set<number>();
  for (const t of trips ?? []) for (const p of t?.basePrices ?? []) if (num(p?.travelClass) !== null) s.add(Number(p.travelClass));
  return s;
}

/**
 * Times are HH:MM without dates. Walk the sequence dep, arr, dep, arr...; each time that goes
 * backwards means a midnight crossing. Never used for duration (upstream `duration` is authoritative).
 */
export function dayOffsets(times: (string | null)[]): number[] {
  let day = 0;
  let prev: number | null = null;
  return times.map((t) => {
    if (t === null) return day;
    const m = toMinutes(t);
    if (prev !== null && m < prev) day += 1;
    prev = m;
    return day;
  });
}

export function mapLeg(s: any, dayOffsetArr = 0) {
  return {
    train: num(s?.trainNumber),
    service: str(s?.serviceCode?.code),
    service_name: str(s?.serviceCode?.designation),
    from: station(s?.departureStation).name,
    from_code: station(s?.departureStation).code,
    to: station(s?.arrivalStation).name,
    to_code: station(s?.arrivalStation).code,
    dep: hhmm(s?.departureTime),
    arr: hhmm(s?.arrivalTime),
    ...(dayOffsetArr > 0 ? { arr_day_offset: dayOffsetArr } : {}),
    platform: str(s?.departurePlatform),
    arrival_platform: str(s?.arrivalPlatform),
    delay_min: num(s?.delay),
    stops: Array.isArray(s?.trainStops) ? s.trainStops.length : null,
  };
}

export function mapTrip(t: any, id: string, travelClass: number, passengers: number) {
  const sections: any[] = Array.isArray(t?.travelSections) ? t.travelSections : [];
  const dep = hhmm(t?.departureTime);
  const arr = hhmm(t?.arrivalTime);
  const seq: (string | null)[] = sections.length
    ? sections.flatMap((s) => [hhmm(s?.departureTime), hhmm(s?.arrivalTime)])
    : [dep, arr];
  const offsets = dayOffsets(seq);
  const finalOffset = offsets[offsets.length - 1] ?? 0;
  const prices = pricesForClass(t?.basePrices, travelClass);
  const total: { regular?: number; promo_non_refundable?: number } = {};
  if (prices.regular !== undefined) total.regular = round2(prices.regular * passengers);
  if (prices.promo_non_refundable !== undefined) total.promo_non_refundable = round2(prices.promo_non_refundable * passengers);
  return {
    id,
    departure: dep,
    arrival: arr,
    arrives_next_day: finalOffset > 0 || (dep !== null && arr !== null && toMinutes(arr) < toMinutes(dep)),
    duration: str(t?.duration),
    services: typeof t?.services === "string" ? t.services.split("|").filter(Boolean) : [],
    transfers: num(t?.transferCount) ?? Math.max(0, sections.length - 1),
    saleable_online: t?.saleableOnline === true,
    ...(t?.delay != null ? { delay_min: num(t.delay) } : {}),
    ...(t?.occupancy != null ? { occupancy: t.occupancy } : {}),
    prices_eur: prices,
    ...(passengers > 1 ? { total_eur: total } : {}),
    raw_prices: (Array.isArray(t?.basePrices) ? t.basePrices : []).map((p: any) => ({
      travel_class: num(p?.travelClass),
      price_type: num(p?.priceType),
      eur: cents(p?.centsValue) ?? null,
      constraints: Array.isArray(p?.constraints) ? p.constraints.map((c: any) => c?.code).filter(Boolean) : [],
    })),
    legs: sections.map((s, i) => mapLeg(s, offsets[i * 2 + 1] ?? 0)),
  };
}

export function mapMessages(messages: unknown): { type: string | null; text: string }[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m: any) => ({ type: str(m?.type), text: htmlToText(m?.text ?? m?.message ?? "") }))
    .filter((m) => m.text);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------- shared validation ----------

export async function validateServices(cp: CpService, services: string[] | undefined): Promise<Set<string> | null> {
  if (!services?.length) return null;
  const wanted = services.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const known = await cp.serviceCodesOrNull();
  if (known) {
    const valid = new Set(known.map((k) => k.code.toUpperCase()));
    const bad = wanted.filter((w) => !valid.has(w));
    if (bad.length) {
      throw new CpError("UNKNOWN_SERVICE", `Unknown service code(s): ${bad.join(", ")}`, undefined, {
        valid_codes: known.map((k) => ({ code: k.code, name: k.designation })),
      });
    }
  }
  return new Set(wanted);
}

export interface PreparedSearch {
  from: Station;
  to: Station;
  date: string;
  returnDate: string | null;
  passengers: number;
  isToday: boolean;
  timeLimit: TimeLimit;
  returnTimeLimit: TimeLimit;
  username: string;
  lang: "PT" | "EN";
}

export async function prepareSearch(cp: CpService, a: JourneyArgs): Promise<PreparedSearch> {
  for (const [k, v] of [["after", a.after], ["before", a.before]] as const) {
    if (v !== undefined && !isValidTime(v)) throw new CpError("INVALID_INPUT", `${k} must be HH:MM`);
  }
  if (a.after && a.before && toMinutes(a.after) > toMinutes(a.before)) {
    throw new CpError("INVALID_INPUT", "after must be earlier than before");
  }
  const [index, rules] = await Promise.all([cp.stations(), cp.rulesOrDefault()]);
  const from = index.resolve(a.from);
  const to = index.resolve(a.to);
  if (from.code === to.code) throw new CpError("INVALID_INPUT", "from and to resolve to the same station");
  const date = await cp.validateDate(a.date);
  let returnDate: string | null = null;
  if (a.return_date) {
    returnDate = await cp.validateDate(a.return_date, { field: "return_date" });
    if (returnDate < date) throw new CpError("INVALID_INPUT", "return_date must be on or after date");
  }
  const passengers = a.passengers ?? 1;
  if (passengers < rules.minTickets || passengers > rules.maxTickets) {
    throw new CpError("INVALID_INPUT", `passengers must be between ${rules.minTickets} and ${rules.maxTickets}`);
  }
  const now = cp.now();
  const isToday = date === now.date;
  return {
    from,
    to,
    date,
    returnDate,
    passengers,
    isToday,
    timeLimit: outwardTimeLimit(isToday, now.time, a.after, a.before),
    returnTimeLimit: returnTimeLimit(returnDate === now.date, now.minutes),
    username: rules.username,
    lang: a.lang ?? "PT",
  };
}

/** Client-side filters: services (every leg must use an allowed service), direct_only, time window. */
export function filterTrips(trips: any[], f: { services: Set<string> | null; directOnly: boolean; after?: string; before?: string }) {
  return trips
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => {
      if (f.directOnly && Number(t?.transferCount ?? 0) > 0) return false;
      if (f.services) {
        const legs = typeof t?.services === "string" ? t.services.split("|").filter(Boolean) : [];
        if (!legs.length || !legs.every((s: string) => f.services!.has(s.toUpperCase()))) return false;
      }
      const dep = hhmm(t?.departureTime);
      if (dep && f.after && toMinutes(dep) < toMinutes(f.after)) return false;
      if (dep && f.before && toMinutes(dep) > toMinutes(f.before)) return false;
      return true;
    });
}

// ---------- horarios ----------

export async function searchJourneys(cp: CpService, a: JourneyArgs) {
  const services = await validateServices(cp, a.services);
  const p = await prepareSearch(cp, a);
  const travelClass = a.travel_class ?? 2;
  const res = await cp.journeys(
    buildJourneyBody({
      from: p.from.code,
      to: p.to.code,
      date: p.date,
      returnDate: p.returnDate,
      classes: [travelClass],
      passengers: p.passengers,
      lang: p.lang,
      timeLimit: p.timeLimit,
      returnTimeLimit: p.returnTimeLimit,
      username: p.username,
    }),
  );
  const outward: any[] = Array.isArray(res?.outwardTrip) ? res.outwardTrip : [];
  const returnTrip: any[] = Array.isArray(res?.returnTrip) ? res.returnTrip : [];
  const idFor = (t: any, direction: "out" | "ret") =>
    encodeOptionId({
      date: p.date,
      from: p.from.code,
      to: p.to.code,
      travelClass,
      passengers: p.passengers,
      returnDate: p.returnDate,
      direction,
      trains: tripTrains(t),
    });
  const filters = { services, directOnly: a.direct_only ?? false };
  const outFiltered = filterTrips(outward, { ...filters, after: p.isToday ? undefined : a.after, before: a.before });
  const retFiltered = filterTrips(returnTrip, filters);
  const payments = paymentsEnabled();
  const withBuy = (o: ReturnType<typeof mapTrip>) => (payments && o.saleable_online ? { ...o, buy_url: buyUrl(o.id) } : o);
  return {
    from: { code: p.from.code, name: str(res?.departureStation?.designation) ?? p.from.name },
    to: { code: p.to.code, name: str(res?.arrivalStation?.designation) ?? p.to.name },
    date: p.date,
    ...(p.returnDate ? { return_date: p.returnDate } : {}),
    travel_class: travelClass,
    passengers: p.passengers,
    ...(payments
      ? {
          buy_note:
            "To buy, give the user the buy_url of the chosen option (our payment page, where they can also pick their seat on trains with seat reservation). For a return trip, each direction is a separate ticket: give the outward and the return option's buy_url. Seat availability is only visible on that page, after the purchase starts.",
        }
      : {
          cp_url: buildSearchUrl({
            from: p.from.code,
            to: p.to.code,
            date: p.date,
            returnDate: p.returnDate,
            travelClass,
            passengers: p.passengers,
            lang: p.lang === "EN" ? "en" : "pt",
          }),
        }),
    prices_note: "prices_eur are per passenger; total_eur is shown when passengers > 1",
    options: outFiltered.map(({ t }) => withBuy(mapTrip(t, idFor(t, "out"), travelClass, p.passengers))),
    ...(p.returnDate
      ? { return_options: retFiltered.map(({ t }) => withBuy(mapTrip(t, idFor(t, "ret"), travelClass, p.passengers))) }
      : {}),
    messages: mapMessages(res?.messages),
  };
}

// ---------- precos ----------

export type ClassStrategy = "combined" | "split";

export class PriceStrategy {
  value: ClassStrategy | undefined;
}

export async function searchFares(
  cp: CpService,
  strategy: PriceStrategy,
  a: JourneyArgs & { train_number?: number },
) {
  const services = await validateServices(cp, a.services);
  const p = await prepareSearch(cp, a);
  const body = (classes: number[]) =>
    buildJourneyBody({
      from: p.from.code,
      to: p.to.code,
      date: p.date,
      returnDate: null,
      classes,
      passengers: p.passengers,
      lang: p.lang,
      timeLimit: p.timeLimit,
      returnTimeLimit: p.returnTimeLimit,
      username: p.username,
    });

  const wanted = a.travel_class ? [a.travel_class] : [1, 2];
  // Merge per-class responses keyed by departure time + train numbers.
  const merged = new Map<string, { trip: any; prices: Record<string, ReturnType<typeof pricesForClass>> }>();
  let messages: unknown = [];
  const absorb = (trips: any[], classes: number[]) => {
    for (const t of trips) {
      const key = tripKey(t);
      const entry = merged.get(key) ?? { trip: t, prices: {} };
      for (const c of classes) {
        const pr = pricesForClass(t?.basePrices, c);
        if (pr.regular !== undefined || pr.promo_non_refundable !== undefined) entry.prices[String(c)] = pr;
      }
      merged.set(key, entry);
    }
  };

  if (wanted.length === 1) {
    const res = await cp.journeys(body(wanted));
    absorb(res?.outwardTrip ?? [], wanted);
    messages = res?.messages;
  } else if (strategy.value !== "split") {
    const res = await cp.journeys(body([1, 2]));
    const trips = res?.outwardTrip ?? [];
    messages = res?.messages;
    const present = classesPresent(trips);
    if (present.has(1) && present.has(2)) {
      strategy.value = "combined";
      absorb(trips, [1, 2]);
    } else if (strategy.value === "combined") {
      // Known to work: a single class means the route only has that class (e.g. Urbano).
      absorb(trips, [1, 2]);
    } else {
      // Unknown yet: fall back to one call per class (max 2).
      const [r1, r2] = [await cp.journeys(body([1])), await cp.journeys(body([2]))];
      if (classesPresent(r1?.outwardTrip ?? []).has(1)) strategy.value = "split";
      absorb(r2?.outwardTrip ?? [], [2]);
      absorb(r1?.outwardTrip ?? [], [1]);
      messages = r2?.messages ?? messages;
    }
  } else {
    const [r1, r2] = [await cp.journeys(body([1])), await cp.journeys(body([2]))];
    absorb(r2?.outwardTrip ?? [], [2]);
    absorb(r1?.outwardTrip ?? [], [1]);
    messages = r2?.messages;
  }

  let rows = filterTrips(
    [...merged.values()].map((e) => ({ ...e.trip, __prices: e.prices })),
    { services, directOnly: a.direct_only ?? false, after: p.isToday ? undefined : a.after, before: a.before },
  ).map(({ t }) => t);
  if (a.train_number !== undefined) {
    rows = rows.filter((t: any) => (t.travelSections ?? []).some((s: any) => Number(s?.trainNumber) === a.train_number));
  }
  rows.sort((x: any, y: any) => toMinutes(hhmm(x.departureTime) ?? "00:00") - toMinutes(hhmm(y.departureTime) ?? "00:00"));

  return {
    from: { code: p.from.code, name: p.from.name },
    to: { code: p.to.code, name: p.to.name },
    date: p.date,
    passengers: p.passengers,
    prices_note: "EUR per passenger, by travel class (1 = 1st/Conforto, 2 = 2nd/Turística). Missing class = not offered.",
    options: rows.map((t: any) => ({
      departure: hhmm(t.departureTime),
      arrival: hhmm(t.arrivalTime),
      duration: str(t.duration),
      services: typeof t.services === "string" ? t.services.split("|").filter(Boolean) : [],
      trains: (t.travelSections ?? []).map((s: any) => num(s?.trainNumber)),
      saleable_online: t.saleableOnline === true,
      prices_eur: t.__prices,
    })),
    messages: mapMessages(messages),
  };
}

function tripKey(t: any): string {
  const trains = (t?.travelSections ?? []).map((s: any) => s?.trainNumber).join("+");
  return `${t?.departureTime}|${t?.arrivalTime}|${trains}`;
}

// ---------- registration ----------

export function serviceDescription(codes: ServiceCode[] | null): string {
  if (!codes) return "Valid codes could not be loaded at startup; they are checked against CP at call time.";
  return `Valid codes: ${codes.map((c) => `${c.code} (${c.designation})`).join(", ")}.`;
}

const dateField = (d: string) => z.iso.date().optional().describe(d);
const timeField = (d: string) => z.string().regex(/^\d{2}:\d{2}$/).optional().describe(d);

export function journeyShape(codes: ServiceCode[] | null) {
  return {
    from: z.string().min(1).describe("Origin station: name (fuzzy, accents optional) or CP code like 94-30007"),
    to: z.string().min(1).describe("Destination station: name or CP code"),
    date: dateField("Travel date YYYY-MM-DD (Europe/Lisbon). Default: today"),
    return_date: dateField("Optional return date YYYY-MM-DD"),
    after: timeField("Earliest departure HH:MM"),
    before: timeField("Latest departure HH:MM"),
    passengers: z.number().int().min(1).max(9).default(1).describe("Number of adults"),
    services: z
      .array(z.string())
      .optional()
      .describe(`Keep only journeys whose every leg uses one of these service codes. ${serviceDescription(codes)}`),
    direct_only: z.boolean().default(false).describe("Only journeys without transfers"),
    lang: z.enum(["PT", "EN"]).default("PT").describe("Language for names and messages"),
  };
}

export function registerJourneyTools(server: McpServer, cp: CpService, codes: ServiceCode[] | null, withUi = false) {
  const strategy = new PriceStrategy();
  server.registerTool(
    "horarios",
    {
      title: "Search journeys (timetable + fares)",
      description:
        "Search CP train journeys between two stations on a date, with times, transfers, legs and fares (EUR per passenger). " +
        "Times are HH:MM local; arrives_next_day marks journeys that cross midnight; duration comes from CP. " +
        (paymentsEnabled()
          ? "Options sold online include buy_url, a link to buy that ticket on our payment page; to help the user buy, use it or comprar_bilhete with the option id."
          : "cp_url opens the same search on cp.pt. Each option has an id to pass to link_compra; copy it exactly."),
      inputSchema: {
        ...journeyShape(codes),
        travel_class: z.union([z.literal(1), z.literal(2)]).default(2).describe("1 = 1st/Conforto, 2 = 2nd/Turística"),
      },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    handler((args: JourneyArgs) => searchJourneys(cp, args)),
  );

  // In-chat view (MCP Apps). Hosts draw a tool's view on every call, so the view lives on its own tool
  // and the agent decides when showing it makes sense; horarios stays plain data.
  if (withUi) {
    server.registerTool(
      "mostrar_horarios",
      {
        title: "Show journey options (interactive)",
        description:
          "Same search as horarios, but also shows the options to the user as interactive cards in the chat, each with a buy button. " +
          "Use it only when the user wants to see and compare trains to pick one, or wants to buy. " +
          "Do NOT use it for quick factual questions (next train, a price, a single time), for checks you make for yourself, or when you will " +
          "answer in one sentence; use horarios for those. Do not call both for the same search.",
        inputSchema: {
          ...journeyShape(codes),
          travel_class: z.union([z.literal(1), z.literal(2)]).default(2).describe("1 = 1st/Conforto, 2 = 2nd/Turística"),
        },
        annotations: { ...READ_ONLY, idempotentHint: false },
        _meta: uiMeta(HORARIOS_UI),
      },
      handler((args: JourneyArgs) => searchJourneys(cp, args)),
    );
  }

  server.registerTool(
    "precos",
    {
      title: "Fares by class",
      description:
        "Fares only (EUR per passenger) for each journey option, for 1st and 2nd class. Optionally restrict to one train number or one class.",
      inputSchema: {
        ...journeyShape(codes),
        travel_class: z.union([z.literal(1), z.literal(2)]).optional().describe("Only this class (default: both)"),
        train_number: z.number().int().positive().optional().describe("Only options that include this train"),
      },
      annotations: READ_ONLY,
    },
    handler((args: JourneyArgs & { train_number?: number }) => searchFares(cp, strategy, args)),
  );
}

