import { describe, expect, it } from "vitest";
import { stationBoard } from "../src/tools/board.js";
import { trainStatus, nodeIdToCode } from "../src/tools/train.js";
import { lisbon, makeCp, on, fixture, type Call } from "./helpers.js";

const boardRow = (n: number, t: string, extra: Record<string, unknown> = {}) => ({
  trainNumber: n,
  trainService: { code: "IC", designation: "Intercidades" },
  trainOrigin: { code: "94-30007", designation: "Lisboa Santa Apolonia" },
  trainDestination: { code: "94-2006", designation: "Porto Campanha" },
  arrivalTime: null,
  departureTime: t,
  platform: "3",
  delay: null,
  occupancy: null,
  supression: null,
  ETA: null,
  ETD: null,
  ...extra,
});

describe("partidas_chegadas", () => {
  it("maps a real arrivals board, keeping null delays as null", async () => {
    const { cp, calls } = makeCp([on("/timetable/", fixture("board-campanha-arrivals"))]);
    const out = await stationBoard(cp, { station: "Campanhã", view: "arrivals", from_time: "08:00", limit: 50 });
    expect(out.rows.length).toBe(50);
    expect(calls.find((c) => c.url.includes("/timetable/"))!.url).toContain("view=ARRIVALS&start=08%3A00");
    const nullDelay = out.rows.find((r) => r.delay_min === null)!;
    expect(nullDelay).toBeDefined();
    expect(nullDelay.cancelled).toBe(false);
    expect(out.rows[0]).toMatchObject({ date: "2026-11-22", scheduled: expect.stringMatching(/^\d{2}:\d{2}$/) });
  });

  it("uses departure fields for departures and ETD as expected time", async () => {
    const { cp } = makeCp([on("/timetable/", { stationStops: [boardRow(521, "10:00", { delay: 5, ETD: "10:05" })], messages: [] })]);
    const out = await stationBoard(cp, { station: "94-30007", from_time: "09:00" });
    expect(out.rows[0]).toMatchObject({ train: 521, scheduled: "10:00", expected: "10:05", delay_min: 5, platform: "3" });
  });

  it("defaults from_time to now (Lisbon) for today", async () => {
    const { cp, calls } = makeCp([on("/timetable/", { stationStops: [], messages: [] })], lisbon("2026-11-22", "14:42"));
    await stationBoard(cp, { station: "94-30007" });
    expect(calls.find((c) => c.url.includes("/timetable/"))!.url).toContain("start=14%3A42");
  });

  it("appends the next day's first trains near midnight", async () => {
    const route = on("/timetable/", (c: Call) =>
      c.url.includes("/2026-11-22?")
        ? { stationStops: [boardRow(1, "23:30")], messages: [] }
        : { stationStops: [boardRow(2, "00:15"), boardRow(3, "05:50")], messages: [] },
    );
    const { cp, calls } = makeCp([route], lisbon("2026-11-22", "23:10"));
    const out = await stationBoard(cp, { station: "94-30007", limit: 3 });
    expect(out.rows.map((r) => [r.train, r.date])).toEqual([[1, "2026-11-22"], [2, "2026-11-23"], [3, "2026-11-23"]]);
    expect(calls.filter((c) => c.url.includes("/timetable/2026-11-23?")).length).toBe(1);
    expect(calls.find((c) => c.url.includes("/timetable/2026-11-23?"))!.url).toContain("start=00%3A00");
  });

  it("does not fetch the next day during the day", async () => {
    const { cp, calls } = makeCp([on("/timetable/", { stationStops: [boardRow(1, "15:00")], messages: [] })], lisbon("2026-11-22", "14:00"));
    await stationBoard(cp, { station: "94-30007" });
    expect(calls.filter((c) => c.url.includes("/timetable/")).length).toBe(1);
  });

  it("flags rows with a non-null supression as cancelled and keeps the raw value", async () => {
    const { cp } = makeCp([on("/timetable/", { stationStops: [boardRow(9, "16:00", { supression: "TOTAL" })], messages: [] })]);
    const out = await stationBoard(cp, { station: "94-30007", from_time: "15:00" });
    expect(out.rows[0]).toMatchObject({ cancelled: true, suppression_raw: "TOTAL" });
  });
});

describe("estado_comboio", () => {
  it("maps a real train timetable", async () => {
    const { cp } = makeCp([on("/trains/521/timetable/", fixture("train-521"))]);
    const out: any = await trainStatus(cp, { train_number: 521, date: "2026-11-30" });
    expect(out).toMatchObject({ source: "cp", train: 521, service: "IC", date: "2026-11-30" });
    expect(out.stops[0]).toMatchObject({ station: { code: "94-30007" }, scheduled_arr: null, scheduled_dep: "06:30" });
    expect(out.stops.at(-1)).toMatchObject({ station: { code: "94-2006" }, scheduled_arr: "09:43", scheduled_dep: null });
  });

  it("treats a first-stop arrival of 00:00 as no arrival", async () => {
    const raw = { ...fixture("train-521") };
    raw.trainStops = raw.trainStops.map((s: any, i: number) => (i === 0 ? { ...s, arrival: "00:00" } : s));
    const { cp } = makeCp([on("/trains/521/timetable/", raw)]);
    const out: any = await trainStatus(cp, { train_number: 521, date: "2026-11-30" });
    expect(out.stops[0].scheduled_arr).toBeNull();
  });

  it("falls back to Infraestruturas de Portugal when CP fails, with a browser UA", async () => {
    const { cp, calls } = makeCp([
      on("/trains/723/timetable/", { httpCode: "500" }, 500),
      on("horarios-ncombio/723/", fixture("ip-train-723")),
    ]);
    const out: any = await trainStatus(cp, { train_number: 723, date: "2026-11-22" });
    expect(out.source).toBe("infraestruturas_de_portugal");
    expect(out.delay_min).toBe(17);
    expect(out.stops[0]).toMatchObject({ station: { code: "94-30007" }, scheduled: "19:30", passed: true });
    expect(out.stops.at(-1)).toMatchObject({ station: { code: "94-29157" }, expected: "23:44", passed: false });
    expect(calls.find((c) => c.url.includes("infraestruturas"))!.headers["User-Agent"]).toContain("Chrome");
  });

  it("falls back to Infraestruturas de Portugal while CP refuses requests (429)", async () => {
    const { cp } = makeCp([
      on(/travel-api\/(stations|trains)/, { httpMessage: "Access Denied" }, 429),
      on("horarios-ncombio/723/", fixture("ip-train-723")),
    ]);
    const out: any = await trainStatus(cp, { train_number: 723, date: "2026-11-22" });
    expect(out.source).toBe("infraestruturas_de_portugal");
    expect(out.stops.length).toBeGreaterThan(5);
  });

  it("surfaces the CP error when the fallback has no data either", async () => {
    const { cp } = makeCp([
      on("/trains/1/timetable/", { moreInformation: "boom" }, 500),
      on("horarios-ncombio/1/", fixture("ip-train-not-running")),
    ]);
    await expect(trainStatus(cp, { train_number: 1, date: "2026-11-22" })).rejects.toMatchObject({ code: "UPSTREAM_ERROR", httpStatus: 500 });
  });

  it("just after midnight, returns yesterday's run when it is still in transit", async () => {
    const notStarted = { ...fixture("train-521"), status: null };
    const running = { ...fixture("train-521"), status: "IN_TRANSIT", delay: 12 };
    const { cp, calls } = makeCp(
      [on("/trains/521/timetable/", (c: Call) => (c.url.endsWith("/2026-11-23") ? notStarted : running))],
      lisbon("2026-11-23", "00:40"),
    );
    const out: any = await trainStatus(cp, { train_number: 521 });
    expect(out).toMatchObject({ date: "2026-11-22", status: "IN_TRANSIT", delay_min: 12 });
    expect(calls.filter((c) => c.url.includes("/trains/521/")).map((c) => c.url.slice(-10))).toEqual(["2026-11-23", "2026-11-22"]);
  });

  it("does not look at yesterday when a date is given or it is daytime", async () => {
    const { cp, calls } = makeCp([on("/trains/521/timetable/", { ...fixture("train-521"), status: null })], lisbon("2026-11-23", "10:00"));
    await trainStatus(cp, { train_number: 521 });
    expect(calls.filter((c) => c.url.includes("/trains/521/")).length).toBe(1);
  });

  it("converts IP node ids to CP codes", () => {
    expect(nodeIdToCode(9402006)).toBe("94-2006");
    expect(nodeIdToCode(9430007)).toBe("94-30007");
    expect(nodeIdToCode("abc")).toBeNull();
  });
});
