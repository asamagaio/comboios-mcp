import { describe, expect, it } from "vitest";
import {
  resolveOption,
  PriceStrategy,
  dayOffsets,
  outwardTimeLimit,
  pricesForClass,
  returnTimeLimit,
  searchFares,
  searchJourneys,
} from "../src/tools/journeys.js";
import { fixture, lisbon, makeCp, on, type Call } from "./helpers.js";

const c2 = fixture("journeys-lisboa-porto-c2");
const c12 = fixture("journeys-lisboa-porto-c12");
const cascais = fixture("journeys-cascais-c12");

/** Keep only one class in every option's basePrices. */
function onlyClass(res: any, cls: number) {
  return { ...res, outwardTrip: res.outwardTrip.map((t: any) => ({ ...t, basePrices: t.basePrices.filter((p: any) => p.travelClass === cls) })) };
}

const journeysPosts = (calls: Call[]) => calls.filter((c) => c.url.endsWith("/journeys"));

describe("journey request building", () => {
  it("whole day for a future date without a window", () => {
    expect(outwardTimeLimit(false, "12:00")).toEqual({ startTime: "00:00", endTime: "23:59", limitType: 0 });
  });
  it("departure window (limitType 2) when after/before are given", () => {
    expect(outwardTimeLimit(false, "12:00", "18:00", "21:00")).toEqual({ startTime: "18:00", endTime: "21:00", limitType: 2 });
  });
  it("today starts at the current time unless `after` is later", () => {
    expect(outwardTimeLimit(true, "12:34")).toEqual({ startTime: "12:34", endTime: "23:59", limitType: 2 });
    expect(outwardTimeLimit(true, "12:34", "08:00")).toMatchObject({ startTime: "12:34" });
    expect(outwardTimeLimit(true, "12:34", "15:00")).toMatchObject({ startTime: "15:00" });
  });
  it("return today = now + 15 min, capped at 23:59", () => {
    expect(returnTimeLimit(true, 12 * 60)).toEqual({ startTime: "12:15", endTime: "23:59", limitType: 2 });
    expect(returnTimeLimit(true, 23 * 60 + 55).startTime).toBe("23:59");
  });

  it("sends the exact body shape the site uses", async () => {
    const { cp, calls } = makeCp([on("/journeys", c2, 200, "POST")]);
    await searchJourneys(cp, { from: "Santa Apolónia", to: "Campanhã", date: "2026-11-30" });
    const body = journeysPosts(calls)[0].body;
    expect(body).toEqual({
      departureStationCode: "94-30007",
      arrivalStationCode: "94-2006",
      travelDate: "2026-11-30",
      returnDate: null,
      classes: [2],
      quantities: [{ quantity: 1, type: 1 }],
      configID: 200,
      lang: "PT",
      saleableOnly: false,
      searchType: 3,
      services: [],
      timeLimit: { startTime: "00:00", endTime: "23:59", limitType: 0 },
      returnTimeLimit: { startTime: "00:00", endTime: "23:59", limitType: 0 },
      username: "sivNetticket",
    });
    expect(journeysPosts(calls)[0].headers["x-cp-connect-id"]).toBe("test-id");
  });
});

describe("journey response mapping", () => {
  it("maps prices: regular (type 1) and non-refundable promo (type 4) in EUR", () => {
    expect(pricesForClass([
      { travelClass: 2, priceType: 1, centsValue: 2805 },
      { travelClass: 2, priceType: 4, centsValue: 1700 },
      { travelClass: 2, priceType: 100, centsValue: 2805 },
      { travelClass: 1, priceType: 1, centsValue: 4990 },
    ], 2)).toEqual({ regular: 28.05, promo_non_refundable: 17 });
  });

  it("detects midnight crossings without computing duration", () => {
    expect(dayOffsets(["22:30", "01:43"])).toEqual([0, 1]);
    expect(dayOffsets(["19:45", "21:00", "21:20", "00:55"])).toEqual([0, 0, 0, 1]);
    expect(dayOffsets(["06:30", "09:43"])).toEqual([0, 0]);
  });

  it("maps options from a real response", async () => {
    const { cp } = makeCp([on("/journeys", c2, 200, "POST")]);
    const out = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30" });
    expect(out.options.length).toBe(c2.outwardTrip.length);
    const ic = out.options.find((o) => o.departure === "06:30")!;
    expect(ic).toMatchObject({ arrival: "09:43", arrives_next_day: false, duration: "03h13", services: ["IC"], transfers: 0 });
    expect(ic.prices_eur.regular).toBe(28.05);
    expect(ic.legs[0]).toMatchObject({ train: 521, service: "IC", dep: "06:30", arr: "09:43" });

    const multi = out.options.find((o) => o.services.join("|") === "R|AP")!;
    expect(multi.legs.length).toBe(2);
    expect(multi.transfers).toBe(1);
    expect(multi.legs.map((l) => l.service)).toEqual(["R", "AP"]);

    const late = out.options.find((o) => o.departure === "22:30")!;
    expect(late.arrives_next_day).toBe(true);
    expect(late.duration).toBe(c2.outwardTrip.find((t: any) => t.departureTime === "22:30").duration);
  });

  it("gives every option a self-contained id that resolves to the same trip", async () => {
    const { cp } = makeCp([on("/journeys", c2, 200, "POST")]);
    const out = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30" });
    const ic = out.options.find((o) => o.departure === "06:30")!;
    expect(ic.id).toBe("2026-11-30_94-30007_94-2006_c2_p1_out521");
    const multi = out.options.find((o) => o.legs.length === 2)!;
    expect(multi.id).toMatch(/_out\d+\+\d+$/);
    const got = await resolveOption(cp, multi.id);
    expect(got.trip.departureTime).toBe(multi.departure);
    expect(got.search.from.code).toBe("94-30007");
    expect(got.direction).toBe("out");
  });

  it("rejects malformed ids and trains that are no longer offered", async () => {
    const { cp } = makeCp([on("/journeys", c2, 200, "POST")]);
    await expect(resolveOption(cp, "deadbeef.out-0")).rejects.toMatchObject({ code: "INVALID_OPTION_ID" });
    await expect(resolveOption(cp, "2026-11-30_94-30007_94-2006_c2_p1_out99999")).rejects.toMatchObject({ code: "OPTION_NOT_FOUND" });
  });

  it("filters by service (every leg) and direct_only on the client", async () => {
    const { cp } = makeCp([on("/journeys", c2, 200, "POST")]);
    const ap = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30", services: ["ap"] });
    expect(ap.options.length).toBeGreaterThan(0);
    expect(ap.options.every((o) => o.services.every((s) => s === "AP"))).toBe(true);
    const direct = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30", direct_only: true });
    expect(direct.options.every((o) => o.transfers === 0)).toBe(true);
  });

  it("rejects unknown service codes and lists valid ones", async () => {
    const { cp } = makeCp([on("/journeys", c2, 200, "POST")]);
    await expect(searchJourneys(cp, { from: "lisboa sa", to: "porto", services: ["TGV"] })).rejects.toMatchObject({
      code: "UNKNOWN_SERVICE",
      details: { valid_codes: expect.arrayContaining([{ code: "AP", name: "Alfa Pendular" }]) },
    });
  });

  it("validates dates against calendar_limit and the past", async () => {
    const { cp } = makeCp([]);
    await expect(searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2027-03-01" })).rejects.toMatchObject({ code: "DATE_BEYOND_LIMIT" });
    await expect(searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-21" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("uses today's rule when no date is given", async () => {
    const { cp, calls } = makeCp([on("/journeys", { outwardTrip: [], returnTrip: [], messages: [] }, 200, "POST")], lisbon("2026-11-22", "21:07"));
    const out = await searchJourneys(cp, { from: "lisboa sa", to: "porto" });
    expect(out.options).toEqual([]);
    expect(journeysPosts(calls)[0].body.timeLimit).toEqual({ startTime: "21:07", endTime: "23:59", limitType: 2 });
    expect(journeysPosts(calls)[0].body.travelDate).toBe("2026-11-22");
  });

  it("returns empty options plus messages when CP has no trips", async () => {
    const { cp } = makeCp([on("/journeys", { outwardTrip: [], returnTrip: [], messages: [{ type: "WARNING", text: "<p>Greve&nbsp;geral</p>" }] }, 200, "POST")]);
    const out = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30" });
    expect(out.options).toEqual([]);
    expect(out.messages).toEqual([{ type: "WARNING", text: "Greve geral" }]);
  });
});

describe("precos class strategy", () => {
  it("uses one call when classes:[1,2] returns both classes, and remembers it", async () => {
    const { cp, calls } = makeCp([on("/journeys", c12, 200, "POST")]);
    const strategy = new PriceStrategy();
    const out = await searchFares(cp, strategy, { from: "lisboa sa", to: "porto", date: "2026-11-30" });
    expect(journeysPosts(calls).length).toBe(1);
    expect(journeysPosts(calls)[0].body.classes).toEqual([1, 2]);
    expect(strategy.value).toBe("combined");
    const ap = out.options.find((o) => o.services.join() === "AP")!;
    expect(ap.prices_eur["1"].regular).toBeGreaterThan(ap.prices_eur["2"].regular!);
  });

  it("falls back to one call per class when the combined call returns only one class", async () => {
    const route = on("/journeys", (c: Call) => {
      const cls = c.body.classes;
      if (cls.length === 2) return onlyClass(c12, 2); // simulate an API that ignores the second class
      return onlyClass(c12, cls[0]);
    }, 200, "POST");
    const { cp, calls } = makeCp([route]);
    const strategy = new PriceStrategy();
    const out = await searchFares(cp, strategy, { from: "lisboa sa", to: "porto", date: "2026-11-30" });
    expect(journeysPosts(calls).map((c) => c.body.classes)).toEqual([[1, 2], [1], [2]]);
    expect(strategy.value).toBe("split");
    expect(out.options.some((o) => o.prices_eur["1"] && o.prices_eur["2"])).toBe(true);

    calls.length = 0;
    await searchFares(cp, strategy, { from: "lisboa sa", to: "porto", date: "2026-12-01" });
    expect(journeysPosts(calls).map((c) => c.body.classes)).toEqual([[1], [2]]);
  });

  it("does not split again once combined is known, for 2nd-class-only routes", async () => {
    const { cp, calls } = makeCp([on("/journeys", (c: Call) => (c.body.arrivalStationCode === "94-69260" ? cascais : c12), 200, "POST")]);
    const strategy = new PriceStrategy();
    await searchFares(cp, strategy, { from: "lisboa sa", to: "porto", date: "2026-11-30" });
    calls.length = 0;
    const out = await searchFares(cp, strategy, { from: "Cais do Sodré", to: "Cascais", date: "2026-11-30" });
    expect(journeysPosts(calls).length).toBe(1);
    expect(out.options[0].prices_eur).toEqual({ "2": { regular: 2.55 } });
  });

  it("filters by train number", async () => {
    const { cp } = makeCp([on("/journeys", c12, 200, "POST")]);
    const out = await searchFares(cp, new PriceStrategy(), { from: "lisboa sa", to: "porto", date: "2026-11-30", train_number: 521 });
    expect(out.options.length).toBe(1);
    expect(out.options[0].trains).toContain(521);
  });
});
