import { describe, expect, it } from "vitest";
import { assertCpUrl, buildSearchUrl } from "../src/cplink.js";
import { purchaseLink } from "../src/tools/purchase.js";
import { searchJourneys } from "../src/tools/journeys.js";
import { fixture, makeCp, on, type Call } from "./helpers.js";

const c2 = fixture("journeys-lisboa-porto-c2");

describe("cp.pt search link", () => {
  it("builds the results URL the site reads (verified shape)", () => {
    const url = buildSearchUrl({ from: "94-30007", to: "94-2006", date: "2026-11-30", travelClass: 2, passengers: 1, lang: "pt" });
    expect(url).toBe(
      "https://www.cp.pt/pt/resultado-pesquisa?passageiros=1&selectedClass=2&startDate=2026-11-30&departureStation=94-30007&arrivalStation=94-2006",
    );
  });

  it("adds endDate for returns and honours class, passengers and language", () => {
    const url = new URL(buildSearchUrl({ from: "94-2006", to: "94-31039", date: "2026-11-30", returnDate: "2026-12-02", travelClass: 1, passengers: 2, lang: "en" }));
    expect(url.pathname).toBe("/en/resultado-pesquisa");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      passageiros: "2",
      selectedClass: "1",
      startDate: "2026-11-30",
      departureStation: "94-2006",
      arrivalStation: "94-31039",
      endDate: "2026-12-02",
    });
  });

  it.each([
    "http://www.cp.pt/pt/",
    "https://cp.pt/pt/",
    "https://www.cp.pt.evil.example/pt/",
    "https://user:pw@www.cp.pt/pt/",
    "javascript:alert(1)",
    "not a url",
  ])("refuses non-cp.pt link %s", (u) => {
    expect(() => assertCpUrl(u)).toThrow(expect.objectContaining({ code: "UNSAFE_LINK" }));
  });
});

describe("link_compra", () => {
  it("from an option id: same search, names the train to select, answered from cache", async () => {
    const { cp, calls } = makeCp([on("/journeys", c2, 200, "POST")]);
    const search = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30", passengers: 2 });
    const opt = search.options.find((o) => o.departure === "06:30")!;
    const before = calls.filter((c: Call) => c.url.includes("/journeys")).length;

    const out = await purchaseLink(cp, { option_id: opt.id });
    expect(calls.filter((c: Call) => c.url.includes("/journeys")).length).toBe(before); // same body -> cache hit
    expect(out.url).toBe(search.cp_url);
    expect(out.url).toContain("passageiros=2");
    expect(out.selected).toMatchObject({ direction: "outward", departure: "06:30", arrival: "09:43", trains: [521], services: ["IC"] });
    expect(out.selected!.prices_eur_per_passenger.regular).toBe(28.05);
    expect(out.instructions).toContain("06:30");
    expect(out.instructions).toContain("521");
    expect(out.instructions).toContain("2 passageiros");
    expect(out).not.toHaveProperty("warning");
  });

  it("warns when CP does not sell the option online", async () => {
    const notSaleable = { ...c2, outwardTrip: c2.outwardTrip.map((t: any) => ({ ...t, saleableOnline: false })) };
    const { cp } = makeCp([on("/journeys", notSaleable, 200, "POST")]);
    const search = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30" });
    const out = await purchaseLink(cp, { option_id: search.options[0].id, lang: "en" });
    expect(out.warning).toMatch(/ticket office/);
    expect(out.url).toMatch(/^https:\/\/www\.cp\.pt\/en\//);
  });

  it("rejects malformed option ids", async () => {
    const { cp } = makeCp([]);
    await expect(purchaseLink(cp, { option_id: "deadbeef.out-0" })).rejects.toMatchObject({ code: "INVALID_OPTION_ID" });
  });

  it("from stations and a date, without calling /journeys", async () => {
    const { cp, calls } = makeCp([]);
    const out = await purchaseLink(cp, { from: "Campanhã", to: "Oriente", date: "2026-11-30", return_date: "2026-12-02", travel_class: 1, passengers: 3, lang: "en" });
    expect(out.url).toBe(
      "https://www.cp.pt/en/resultado-pesquisa?passageiros=3&selectedClass=1&startDate=2026-11-30&departureStation=94-2006&arrivalStation=94-31039&endDate=2026-12-02",
    );
    expect(out.selected).toBeNull();
    expect(calls.some((c: Call) => c.url.includes("/journeys"))).toBe(false);
  });

  it("validates input like horarios does", async () => {
    const { cp } = makeCp([]);
    await expect(purchaseLink(cp, { from: "Lisboa", to: "Porto" })).rejects.toMatchObject({ code: "AMBIGUOUS_STATION" });
    await expect(purchaseLink(cp, { from: "porto", to: "oriente", date: "2027-06-01" })).rejects.toMatchObject({ code: "DATE_BEYOND_LIMIT" });
    await expect(purchaseLink(cp, { to: "oriente" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("horarios carries the same cp_url", async () => {
    const { cp } = makeCp([on("/journeys", c2, 200, "POST")]);
    const out = await searchJourneys(cp, { from: "lisboa sa", to: "porto", date: "2026-11-30", lang: "EN" });
    expect(out.cp_url).toMatch(/^https:\/\/www\.cp\.pt\/en\/resultado-pesquisa\?/);
  });
});
