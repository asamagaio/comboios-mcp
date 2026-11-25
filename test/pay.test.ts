import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { cancelPurchase, changeSeats, compactSeatMap, confirmPurchase, openPayment, openToken, quote, sealToken, seatMap, startPurchase, validateStart } from "../src/pay.js";
import { fixture, makeCp, on, type Call } from "./helpers.js";

const c2 = fixture("journeys-lisboa-porto-c2");
const OPT = "2026-11-30_94-30007_94-2006_c2_p1_out521";
const BASE = "https://example.test";

beforeAll(() => {
  process.env.PAY_TOKEN_KEY = randomBytes(32).toString("base64");
});

const leg = (seats: { carriageNumber: number; seatNumber: number }[]) => ({
  trainNumber: 521, departureTime: "06:30", arrivalTime: "09:43",
  departureStation: { code: "94-30007", designation: "Lisboa Santa Apolonia" }, arrivalStation: { code: "94-2006", designation: "Porto Campanha" },
  seatData: seats.map((x) => ({ trainNumber: 521, ...x })),
});
const sale = { saleID: 777, reference: "CP-TEST", totalAmount: "€ 28,05", status: { code: "PENDING" }, clientData: { clientID: "guest-1" }, travelData: { outwardTrip: [leg([{ carriageNumber: 3, seatNumber: 53 }])] } };
const input = { option_id: OPT, passengers: [{ name: "Ana Silva" }], email: "ana@example.com", consent: true };
const writes = (calls: Call[]) => calls.filter((c) => c.url.includes("ticketing-api") && c.method !== "GET").map((c) => `${c.method} ${new URL(c.url).pathname.replace("/ticketing-api", "")}`);
const seatFixture = fixture("seatmap-ap131");

/** Stateful fake of CP's ticketing API for one sale (777). */
function saleRoutes(opts: { payment?: string | { status: number; body: unknown }; saleStatus?: string; failClient?: boolean; noSeats?: boolean } = {}) {
  let status = opts.saleStatus ?? "PENDING";
  let opened = false;
  let seats = opts.noSeats ? [] : [{ carriageNumber: 3, seatNumber: 53 }];
  const current = () => ({ ...sale, status: { code: status }, travelData: { outwardTrip: [leg(seats)], ticketData: [{ ticketID: status === "CONFIRMED" ? "3835-1" : null, status: { code: status } }] } });
  return [
    on("/journeys", c2, 200, "POST"),
    on(/ticketing-api\/sale$/, () => current(), 200, "POST"),
    on("/sale/777/passengers", {}, 200, "PUT"),
    on("/sale/777/client", opts.failClient ? { description: "bad email" } : {}, opts.failClient ? 400 : 200, "PUT"),
    (c: Call) => {
      if (!c.url.endsWith("/sale/777/payment") || c.method !== "PUT") return undefined;
      opened = true;
      return { body: { paymentID: 1, key: "pk_test", session: JSON.stringify({ id: "ps_1", payment_session_token: "x", payment_session_secret: "y" }) } };
    },
    (c: Call) => {
      if (!c.url.endsWith("/sale/777/payment") || c.method !== "GET") return undefined;
      const p = opts.payment ?? (opened ? "RETRY" : { status: 500, body: { description: "Payment not found" } });
      return typeof p === "string" ? { body: p } : p;
    },
    (c: Call) => {
      if (!c.url.endsWith("/sale/777/confirm") || c.method !== "PUT") return undefined;
      status = "CONFIRMED";
      return { body: { status: { code: "CONFIRMED" } } };
    },
    (c: Call) => (c.url.endsWith("/sales/777") && c.method === "GET" ? { body: current() } : undefined),
    (c: Call) => {
      if (!/train-seats\/777\/trains\/521$/.test(c.url)) return undefined;
      return seats.length ? { body: seatFixture } : { status: 500, body: { description: "Lista de lugares vazia: o comboio não tem reserva de lugar" } };
    },
    (c: Call) => {
      if (!c.url.endsWith("/train-seats/777") || c.method !== "PUT") return undefined;
      seats = c.body.requestedSeats.map((x: any) => ({ carriageNumber: x.carriageNumber, seatNumber: x.seatNumber }));
      return { body: current() };
    },
    on("/sale/777", {}, 200, "DELETE"),
  ];
}

describe("purchase token", () => {
  it("round-trips and rejects tampering and expiry", () => {
    const t = sealToken({ saleID: 1, clientID: "c", reference: "R" });
    expect(openToken(t)).toMatchObject({ saleID: 1, clientID: "c", reference: "R" });
    const flipped = t.slice(0, -2) + (t.at(-2) === "A" ? "B" : "A") + t.at(-1);
    expect(() => openToken(flipped)).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
    expect(() => openToken(t, Date.now() + 31 * 86_400_000)).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
    expect(() => openToken("short")).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
  });
});

describe("quote", () => {
  it("describes a one-way option without creating anything", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    const q = await quote(cp, OPT);
    expect(q).toMatchObject({ departure: "06:30", passengers: 1, price_eur_each: 28.05, legs: [{ train: 521 }] });
    expect(writes(calls)).toEqual([]);
  });
  it("treats the outward option of a return search as a one-way ticket", async () => {
    const { cp } = makeCp(saleRoutes());
    const q = await quote(cp, "2026-11-30_94-30007_94-2006_c2_p1_r2026-12-02_out521");
    expect(q.option_id).toBe(OPT);
  });
});

describe("validateStart", () => {
  it.each([
    [{ ...input, consent: false }, "Consent"],
    [{ ...input, email: "nope" }, "email"],
    [{ ...input, passengers: [] }, "name"],
    [{ ...input, passengers: [{ name: "Ana", idType: "CC" }] }, "number"],
    [{ ...input, passengers: [{ name: "Ana", idType: "XX", idNumber: "1" }] }, "document"],
  ])("rejects %#", (i, msg) => {
    expect(() => validateStart(i as any, 1)).toThrow(new RegExp(msg, "i"));
  });
});

describe("startPurchase", () => {
  it("creates the sale and sets details, but does not open payment yet", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    const out = await startPurchase(cp, input);
    expect(writes(calls)).toEqual(["POST /sale", "PUT /sale/777/passengers", "PUT /sale/777/client"]);
    expect(calls.find((c) => c.url.endsWith("/sale/777/client"))!.headers["x-cp-client-id"]).toBe("guest-1");
    // Like cp.pt: a passenger without an ID document is not listed (CP fails with SIV:SLE:01 otherwise).
    expect(calls.find((c) => c.url.endsWith("/sale/777/passengers"))!.body).toEqual({ salePassengers: [] });
    expect(calls.find((c) => c.url.endsWith("/sale/777/client"))!.body).toMatchObject({ clientName: "Ana Silva", clientEmail: "ana@example.com" });
    expect(out.trains).toEqual([{ train: 521, from: "Lisboa Santa Apolonia", to: "Porto Campanha", dep: "06:30", arr: "09:43", seats: [{ carriage: 3, seat: 53 }] }]);
    expect(out).not.toHaveProperty("checkout");
    expect(openToken(out.token)).toMatchObject({ saleID: 777, clientID: "guest-1", reference: "CP-TEST" });
  });

  it("lists a passenger with an ID document the way cp.pt does", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    await startPurchase(cp, { ...input, passengers: [{ name: "Ana Silva", idType: "CC", idNumber: "12345678" }] });
    expect(calls.find((c) => c.url.endsWith("/sale/777/passengers"))!.body).toEqual({
      salePassengers: [{ idtype: { code: "CC", designation: "Cartão de Cidadão" }, passengerID: "12345678", passengerName: "Ana Silva" }],
    });
  });

  it("validates before creating anything", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    await expect(startPurchase(cp, { ...input, consent: false })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(writes(calls)).toEqual([]);
  });

  it("releases the sale if CP rejects the details, and never retries writes", async () => {
    const { cp, calls } = makeCp(saleRoutes({ failClient: true }));
    await expect(startPurchase(cp, input)).rejects.toMatchObject({ httpStatus: 400 });
    expect(writes(calls)).toEqual(["POST /sale", "PUT /sale/777/passengers", "PUT /sale/777/client", "DELETE /sale/777"]);
  });
});

describe("openPayment", () => {
  const token = () => sealToken({ saleID: 777, clientID: "guest-1", reference: "CP-TEST" });

  it("opens CP's payment session with a short return URL", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    const out = await openPayment(cp, token(), BASE);
    expect(writes(calls)).toEqual(["PUT /sale/777/payment"]);
    const body = calls.find((c) => c.url.endsWith("/sale/777/payment") && c.method === "PUT")!.body;
    expect(body.inboundURL).toBe("https://example.test/comprar/retorno"); // CP truncates long inboundURLs (SQLServerException)
    expect(out.checkout).toMatchObject({ publicKey: "pk_test", environment: "production", paymentSession: { id: "ps_1" } });
  });

  it("refuses to open a second session (CP rejects duplicates)", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    await openPayment(cp, token(), BASE);
    await expect(openPayment(cp, token(), BASE)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(writes(calls)).toEqual(["PUT /sale/777/payment"]);
  });

  it("refuses when the sale is no longer pending", async () => {
    const { cp, calls } = makeCp(saleRoutes({ saleStatus: "CONFIRMED" }));
    await expect(openPayment(cp, token(), BASE)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(writes(calls)).toEqual([]);
  });

  it("releases the sale if CP cannot open the payment session", async () => {
    const { cp, calls } = makeCp([on("/sale/777/payment", { description: "String or binary data would be truncated" }, 500, "PUT"), ...saleRoutes()]);
    await expect(openPayment(cp, token(), BASE)).rejects.toMatchObject({ httpStatus: 500 });
    expect(writes(calls)).toEqual(["PUT /sale/777/payment", "DELETE /sale/777"]);
  });
});

describe("seats", () => {
  const token = () => sealToken({ saleID: 777, clientID: "guest-1", reference: "CP-TEST" });

  it("reduces CP's seat map to carriages, rows and seat cells", () => {
    const m = compactSeatMap(seatFixture);
    expect(m.train).toBe(131);
    expect(m.carriages.map((c) => c.number)).toEqual([3, 4, 5, 6]);
    const c3 = m.carriages[0];
    expect(c3).toMatchObject({ occupancy: 50, attributes: ["WC", "WIFI", "AC", "PLUGS", "BAR"] });
    const cells = c3.rows.flat();
    expect(cells.find((x: any) => x.kind === "seat" && x.seat === 53)).toMatchObject({ status: "mine", facing: "a" });
    expect(cells.find((x: any) => x.kind === "seat" && x.seat === 52)).toMatchObject({ status: "occupied" });
    expect(cells.find((x: any) => x.kind === "seat" && x.seat === 31)).toMatchObject({ status: "free", facing: "b" });
    expect(cells.some((x: any) => x.kind === "gap")).toBe(true);
    expect(c3.rows[2].every((x: any) => x.kind === "empty")).toBe(true); // the aisle
  });

  it("serves the map and maps 'no seat reservation' to a clear error", async () => {
    const { cp } = makeCp(saleRoutes());
    expect((await seatMap(cp, token(), 521)).carriages.length).toBe(4);
    const { cp: cp2 } = makeCp(saleRoutes({ noSeats: true }));
    await expect(seatMap(cp2, token(), 521)).rejects.toMatchObject({ code: "NO_SEAT_RESERVATION" });
  });

  it("changes the seat with the body cp.pt sends", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    const r = await changeSeats(cp, token(), 521, [{ carriage: 3, seat: 42 }]);
    expect(calls.find((c) => c.url.endsWith("/train-seats/777"))!.body).toEqual({
      originalSeats: [{ carriageNumber: 3, seatNumber: 53, trainNumber: 521 }],
      requestedSeats: [{ carriageNumber: 3, seatNumber: 42, trainNumber: 521 }],
    });
    expect(r.trains[0].seats).toEqual([{ carriage: 3, seat: 42 }]);
  });

  it("validates the number of seats and refuses after payment was opened", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    await expect(changeSeats(cp, token(), 521, [])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(changeSeats(cp, token(), 521, [{ carriage: 3, seat: 42 }, { carriage: 3, seat: 41 }])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await openPayment(cp, token(), BASE);
    await expect(changeSeats(cp, token(), 521, [{ carriage: 3, seat: 42 }])).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(writes(calls)).toEqual(["PUT /sale/777/payment"]);
  });
});

describe("confirmPurchase", () => {
  const token = () => sealToken({ saleID: 777, clientID: "guest-1", reference: "CP-TEST" });

  it("does not confirm while CP still reports RETRY (not paid)", async () => {
    const { cp, calls } = makeCp(saleRoutes({ payment: "RETRY" }));
    const r = await confirmPurchase(cp, token());
    expect(r).toMatchObject({ confirmed: false, waiting: true });
    expect(writes(calls)).toEqual([]);
  });

  it("confirms once after payment and returns the tickets", async () => {
    const { cp, calls } = makeCp(saleRoutes({ payment: "PROCEED" }));
    const r = await confirmPurchase(cp, token());
    expect(r).toMatchObject({ confirmed: true, status: "CONFIRMED", tickets: [{ ticketID: "3835-1" }] });
    expect(writes(calls)).toEqual(["PUT /sale/777/confirm"]);
    const again = await confirmPurchase(cp, token());
    expect(again).toMatchObject({ confirmed: true, already: true });
    expect(writes(calls)).toEqual(["PUT /sale/777/confirm"]);
  });

  it("flags needs_attention when confirm fails after payment", async () => {
    const routes = saleRoutes({ payment: "PROCEED" });
    const { cp } = makeCp([on("/sale/777/confirm", { description: "SIV error" }, 400, "PUT"), ...routes]);
    const r = await confirmPurchase(cp, token());
    expect(r).toMatchObject({ confirmed: false, needs_attention: true, reference: "CP-TEST" });
  });
});

describe("cancelPurchase", () => {
  const token = () => sealToken({ saleID: 777, clientID: "guest-1", reference: "CP-TEST" });

  it("cancels an unpaid sale", async () => {
    const { cp, calls } = makeCp(saleRoutes({ payment: "RETRY" }));
    await expect(cancelPurchase(cp, token())).resolves.toEqual({ cancelled: true });
    expect(writes(calls)).toEqual(["DELETE /sale/777"]);
  });

  it.each([
    ["payment in progress", { payment: "PROCEED" }],
    ["status unreadable", { payment: { status: 500, body: { description: "boom" } } }],
    ["already confirmed", { payment: "PROCEED", saleStatus: "CONFIRMED" }],
  ])("refuses when %s", async (_n, opts) => {
    const { cp, calls } = makeCp(saleRoutes(opts as any));
    await expect(cancelPurchase(cp, token())).rejects.toMatchObject({ code: "CANNOT_CANCEL" });
    expect(writes(calls)).toEqual([]);
  });

  it("allows cancel when no payment was ever started", async () => {
    const { cp } = makeCp(saleRoutes({ payment: { status: 500, body: { description: "Payment not found" } } }));
    await expect(cancelPurchase(cp, token())).resolves.toEqual({ cancelled: true });
  });
});

describe("pre-fill from the agent", () => {
  it("round-trips, expires after 2 h, and cannot be swapped with a sale token", async () => {
    const { cleanPrefill, sealPrefill, openPrefill } = await import("../src/pay.js");
    const p = cleanPrefill({ passengers: [" Ana Silva "], email: "ana@example.com" }, 1)!;
    const f = sealPrefill(p);
    expect(openPrefill(f)).toEqual({ passengers: ["Ana Silva"], email: "ana@example.com" });
    expect(() => openPrefill(f, Date.now() + 2 * 3600_000 + 1000)).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
    expect(() => openToken(f)).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
    expect(() => openPrefill(sealToken({ saleID: 1, clientID: "c", reference: "R" }))).toThrow(expect.objectContaining({ code: "INVALID_TOKEN" }));
  });

  it("validates what the agent supplies", async () => {
    const { cleanPrefill } = await import("../src/pay.js");
    expect(cleanPrefill({}, 1)).toBeNull();
    expect(() => cleanPrefill({ passengers: ["A B", "C D"] }, 1)).toThrow(/At most 1/);
    expect(() => cleanPrefill({ email: "nope" }, 1)).toThrow(/email/i);
    expect(() => cleanPrefill({ mobile: "call me" }, 1)).toThrow(/mobile/i);
  });

  it("comprar_bilhete puts details in the link only encrypted", async () => {
    process.env.PUBLIC_BASE_URL = "https://example.test";
    const { buyLink } = await import("../src/tools/buy.js");
    const { openPrefill } = await import("../src/pay.js");
    const { cp, calls } = makeCp(saleRoutes());
    const out = await buyLink(cp, { option_id: OPT, passenger_names: ["Ana Silva"], email: "ana@example.com", mobile: "+351 912345678" });
    expect(out.url).not.toMatch(/Ana|ana%40|example\.com|9123/);
    const f = new URL(out.url).searchParams.get("f");
    expect(openPrefill(f)).toEqual({ passengers: ["Ana Silva"], email: "ana@example.com", mobile: "+351 912345678" });
    expect(out.prefilled).toEqual({ passenger_names: 1, email: true, mobile: true });
    expect(writes(calls)).toEqual([]);

    const plain = await buyLink(cp, { option_id: OPT });
    expect(new URL(plain.url).searchParams.has("f")).toBe(false);
    expect(plain.prefilled).toBeNull();
  });
});

describe("return legs bought as one-way tickets", () => {
  it("asOneWay swaps a return leg and drops the return date", async () => {
    const { asOneWay, parseOptionId, encodeOptionId } = await import("../src/options.js");
    expect(encodeOptionId(asOneWay(parseOptionId("2026-11-30_94-30007_94-2006_c2_p2_r2026-12-02_ret4411+182")))).toBe(
      "2026-12-02_94-2006_94-30007_c2_p2_out4411+182",
    );
    expect(encodeOptionId(asOneWay(parseOptionId("2026-11-30_94-30007_94-2006_c2_p1_r2026-12-02_out521")))).toBe(
      "2026-11-30_94-30007_94-2006_c2_p1_out521",
    );
  });

  it("quote accepts a return option and searches the return direction", async () => {
    const { cp, calls } = makeCp(saleRoutes());
    const q = await quote(cp, "2026-11-28_94-2006_94-30007_c2_p1_r2026-11-30_ret521");
    expect(q.option_id).toBe("2026-11-30_94-30007_94-2006_c2_p1_out521");
    const body = calls.filter((c) => c.url.endsWith("/journeys")).at(-1)!.body;
    expect(body).toMatchObject({ departureStationCode: "94-30007", arrivalStationCode: "94-2006", travelDate: "2026-11-30", returnDate: null });
  });
});
