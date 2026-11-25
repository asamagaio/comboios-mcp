/**
 * Public payment flow (stage B): buy a CP ticket on our page, paid through CP's own Checkout.com
 * payment session. See docs/payment-lab.md for how the flow was verified.
 *
 * Safeguards:
 * - Nothing is reserved until the person submits their details and consent (POST /api/pay/start).
 * - Personal data is forwarded to CP and never stored or logged here.
 * - The sale's ids travel in an AES-256-GCM token (no server-side state).
 * - Writes to CP are never retried. Confirm is skipped while CP reports the payment as RETRY.
 * - Cancel is refused when there is any sign of a payment, or the status cannot be read.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { CpService } from "./cp.js";
import { CpError } from "./errors.js";
import { resolveOption } from "./tools/journeys.js";
import { asOneWay, encodeOptionId, parseOptionId, tripTrains } from "./options.js";
import { log } from "./log.js";

const W = { retry: false } as const;
/** Sale hold on CP's side is 15 min; tokens stay valid longer so tickets can be downloaded later. */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PAID = ["COMPLETED", "PAID", "CONFIRMED", "SUCCESS"];
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$/;
export const isPaidStatus = (code: unknown) => PAID.some((p) => String(code ?? "").toUpperCase().includes(p));

export { paymentsEnabled, publicBaseUrl } from "./public.js";

// ---------------------------------------------------------------- token

export interface SaleToken {
  saleID: number;
  clientID: string;
  reference: string;
  exp: number;
}

function tokenKey(): Buffer {
  const raw = process.env.PAY_TOKEN_KEY;
  if (!raw) throw new CpError("CONFIG_INVALID", "PAY_TOKEN_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new CpError("CONFIG_INVALID", "PAY_TOKEN_KEY must be 32 bytes, base64");
  return key;
}

type TokenKind = "sale" | "prefill";
const TTL: Record<TokenKind, number> = { sale: TOKEN_TTL_MS, prefill: 2 * 60 * 60 * 1000 };

/** AES-256-GCM; the kind is authenticated data, so one kind of token cannot be opened as another. */
function seal(kind: TokenKind, payload: object, now = Date.now()): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", tokenKey(), iv);
  c.setAAD(Buffer.from(kind));
  const body = Buffer.concat([c.update(JSON.stringify({ ...payload, exp: now + TTL[kind] }), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

function unseal<T extends { exp: number }>(kind: TokenKind, token: unknown, now: number): T {
  if (typeof token !== "string" || token.length < 40 || token.length > 4000) throw new Error("shape");
  const buf = Buffer.from(token, "base64url");
  const d = createDecipheriv("aes-256-gcm", tokenKey(), buf.subarray(0, 12));
  d.setAAD(Buffer.from(kind));
  d.setAuthTag(buf.subarray(12, 28));
  const t = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8")) as T;
  if (!(t.exp >= now)) throw new Error("expired");
  return t;
}

export function sealToken(t: Omit<SaleToken, "exp">, now = Date.now()): string {
  return seal("sale", t, now);
}

export function openToken(token: unknown, now = Date.now()): SaleToken {
  try {
    const t = unseal<SaleToken>("sale", token, now);
    if (!t.saleID || !t.clientID) throw new Error("incomplete");
    return t;
  } catch {
    throw new CpError("INVALID_TOKEN", "Invalid or expired purchase token");
  }
}

// ---------------------------------------------------------------- pre-fill (details supplied by the agent)

export interface Prefill {
  passengers: string[];
  email?: string;
  mobile?: string;
}

/** Validate what the agent supplies. The ID document is deliberately not accepted here. */
export function cleanPrefill(p: Partial<Prefill>, maxPassengers: number): Prefill | null {
  const passengers = (p.passengers ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);
  const email = p.email?.trim() || undefined;
  const mobile = p.mobile?.trim() || undefined;
  if (!passengers.length && !email && !mobile) return null;
  if (passengers.length > maxPassengers) throw new CpError("INVALID_INPUT", `At most ${maxPassengers} passenger name(s) for this option`);
  if (passengers.some((n) => n.length < 2 || n.length > 100)) throw new CpError("INVALID_INPUT", "Passenger names must be 2–100 characters");
  if (email && !EMAIL.test(email)) throw new CpError("INVALID_INPUT", "Invalid email");
  if (mobile && !/^\+?[0-9 ]{6,20}$/.test(mobile)) throw new CpError("INVALID_INPUT", "Invalid mobile number");
  return { passengers, ...(email ? { email } : {}), ...(mobile ? { mobile } : {}) };
}

export function sealPrefill(p: Prefill, now = Date.now()): string {
  return seal("prefill", p, now);
}

export function openPrefill(token: unknown, now = Date.now()): Prefill {
  try {
    const { exp: _e, ...p } = unseal<Prefill & { exp: number }>("prefill", token, now);
    return p;
  } catch {
    throw new CpError("INVALID_TOKEN", "The pre-filled details have expired; please type them");
  }
}

// ---------------------------------------------------------------- quote

export async function quote(cp: CpService, optionIdIn: string) {
  // Each direction is bought as its own one-way ticket; return legs are converted.
  const optionId = encodeOptionId(asOneWay(parseOptionId(optionIdIn)));
  const { search, trip } = await resolveOption(cp, optionId);
  if (trip?.saleableOnline !== true) throw new CpError("NOT_SALEABLE_ONLINE", "CP does not sell this journey online");
  const sections: any[] = Array.isArray(trip?.travelSections) ? trip.travelSections : [];
  const price = (Array.isArray(trip?.basePrices) ? trip.basePrices : []).find(
    (p: any) => Number(p?.travelClass) === search.travelClass && Number(p?.priceType) === 1,
  );
  return {
    option_id: optionId,
    from: search.from.name,
    to: search.to.name,
    date: search.date,
    departure: trip.departureTime,
    arrival: trip.arrivalTime,
    duration: trip.duration,
    travel_class: search.travelClass,
    passengers: search.passengers,
    legs: sections.map((s) => ({
      train: Number(s?.trainNumber),
      service: s?.serviceCode?.designation ?? s?.serviceCode?.code ?? null,
      from: s?.departureStation?.designation,
      to: s?.arrivalStation?.designation,
      dep: s?.departureTime,
      arr: s?.arrivalTime,
    })),
    price_eur_each: price ? Number(price.centsValue) / 100 : null,
    _search: search,
    _trip: trip,
  };
}

// ---------------------------------------------------------------- start

export interface StartInput {
  option_id: string;
  passengers: { name: string; idType?: string; idNumber?: string }[];
  email: string;
  mobile?: string;
  consent: boolean;
}

/** CP's ID_TYPE codes and designations (GET K/sale/configuration). */
const ID_TYPES: Record<string, string> = {
  CC: "Cartão de Cidadão",
  PASS: "Passaporte",
  BI: "Bilhete de Identidade",
  CCOND: "Carta de Condução",
  AR: "Autorização de residência",
};

export function validateStart(i: StartInput, expectedPassengers: number): void {
  if (i?.consent !== true) throw new CpError("INVALID_INPUT", "Consent is required");
  if (!EMAIL.test(String(i.email ?? "").trim())) throw new CpError("INVALID_INPUT", "A valid email is required (tickets are sent there)");
  if (!Array.isArray(i.passengers) || i.passengers.length !== expectedPassengers) {
    throw new CpError("INVALID_INPUT", `Give a name for each of the ${expectedPassengers} passenger(s)`);
  }
  for (const p of i.passengers) {
    const name = String(p?.name ?? "").trim();
    if (name.length < 2 || name.length > 100) throw new CpError("INVALID_INPUT", "Each passenger needs a name");
    if (p.idType && !(p.idType in ID_TYPES)) throw new CpError("INVALID_INPUT", "Unknown ID document type");
    if (p.idType && !String(p.idNumber ?? "").trim()) throw new CpError("INVALID_INPUT", "ID document number missing");
  }
  if (i.mobile && !/^\+?[0-9 ]{6,20}$/.test(i.mobile)) throw new CpError("INVALID_INPUT", "Invalid mobile number");
}

/** Create the sale, set passengers and client, open CP's Checkout.com payment session. */
export async function startPurchase(cp: CpService, input: StartInput) {
  const q = await quote(cp, input.option_id);
  validateStart(input, q.passengers);
  const { _search: search, _trip: trip } = q;
  const http = cp.http;

  const sale = await http.gateway<any>("ticketing", "/sale", {
    method: "POST",
    ...W,
    body: {
      quantity: search.passengers,
      travelDate: search.date,
      travelClass: { code: String(search.travelClass) },
      outwardTrip: (trip.travelSections ?? []).map((s: any) => ({
        trainNumber: s.trainNumber,
        departureStation: { code: s.departureStation.code },
        arrivalStation: { code: s.arrivalStation.code },
        serviceCode: s.serviceCode ? { code: s.serviceCode.code, designation: s.serviceCode.designation } : undefined,
      })),
      seatOptions: null,
      lang: "PT",
    },
  });
  const saleID = Number(sale?.saleID);
  const clientID = String(sale?.clientData?.clientID ?? "");
  if (!saleID || !clientID) throw new CpError("UPSTREAM_BAD_RESPONSE", "CP did not return a sale");
  const H = { headers: { "x-cp-client-id": clientID } };
  log.info(`pay: sale ${saleID} created (${sale.totalAmount}) trains ${tripTrains(trip).join("+")}`);

  try {
    await http.gateway("ticketing", `/sale/${saleID}/passengers`, {
      method: "PUT",
      ...W,
      ...H,
      // As cp.pt does: only passengers with an ID document are listed (it filters out idtype === null);
      // CP fails with SIV:SLE:01 on an entry without one. Names otherwise go in the client data.
      body: {
        salePassengers: input.passengers
          .filter((p) => p.idType)
          .map((p) => ({
            idtype: { code: p.idType!, designation: ID_TYPES[p.idType!] },
            passengerID: String(p.idNumber).trim(),
            passengerName: p.name.trim(),
          })),
      },
    });
    await http.gateway("ticketing", `/sale/${saleID}/client`, {
      method: "PUT",
      ...W,
      ...H,
      body: { clientEmail: input.email.trim(), clientID, clientMobile: input.mobile?.trim() || null, clientName: input.passengers[0].name.trim() },
    });
  } catch (err) {
    log.warn(`pay: sale ${saleID} details rejected (${(err as Error).message}); releasing`);
    await release(cp, saleID, clientID);
    throw err;
  }

  const token = sealToken({ saleID, clientID, reference: String(sale.reference ?? "") });
  return {
    token,
    reference: sale.reference,
    total: sale.totalAmount,
    expires_in_min: 15,
    // Trains with seat reservation (AP, IC, ...) come with the seats CP assigned; others have none.
    trains: trainsOf(sale),
  };
}

/** Open CP's Checkout.com payment session for a sale whose details (and seats) are settled. */
export async function openPayment(cp: CpService, token: string, baseUrl: string) {
  const t = openToken(token);
  const H = { headers: { "x-cp-client-id": t.clientID } };
  const state = await saleState(cp, t);
  if (state.status !== "PENDING") throw new CpError("INVALID_STATE", `This purchase can no longer be paid (state ${state.status})`, 409);
  // CP refuses a second payment session for the same sale ("sessão de pagamento em duplicado").
  const existing = await paymentStatus(cp, t);
  if (existing.status) throw new CpError("INVALID_STATE", "Payment was already opened for this purchase; reload the page to continue it, or cancel", 409);
  // CP stores inboundURL in a column that truncates past ~255 characters (SQLServerException), so the
  // token is not put in it; the page keeps the token in sessionStorage across the redirect.
  const inboundURL = `${baseUrl}/comprar/retorno`;
  let pay: any;
  let paymentSession: unknown;
  try {
    pay = await cp.http.gateway<any>("ticketing", `/sale/${t.saleID}/payment`, {
      method: "PUT",
      ...W,
      ...H,
      body: { systemID: "CHECKOUT", inboundURL, useGWProxy: false, createToken: false, removeToken: false, channel: "BO" },
    });
    paymentSession = JSON.parse(pay.session);
  } catch (err) {
    log.warn(`pay: sale ${t.saleID} payment session failed (${(err as Error).message}); releasing`);
    await release(cp, t.saleID, t.clientID);
    throw err instanceof SyntaxError ? new CpError("UPSTREAM_BAD_RESPONSE", "CP did not return a payment session") : err;
  }
  log.info(`pay: sale ${t.saleID} payment session opened`);
  return { total: state.total, checkout: { publicKey: pay.key, paymentSession, environment: "production" } };
}

// ---------------------------------------------------------------- seats

export interface TrainSeats {
  train: number;
  from: string | null;
  to: string | null;
  dep: string | null;
  arr: string | null;
  seats: { carriage: number; seat: number }[];
}

/** Trains of a sale with their assigned seats (empty for trains without seat reservation). */
export function trainsOf(sale: any): TrainSeats[] {
  return (sale?.travelData?.outwardTrip ?? []).map((tr: any) => ({
    train: Number(tr?.trainNumber),
    from: tr?.departureStation?.designation ?? null,
    to: tr?.arrivalStation?.designation ?? null,
    dep: tr?.departureTime ?? null,
    arr: tr?.arrivalTime ?? null,
    seats: (tr?.seatData ?? []).map((x: any) => ({ carriage: Number(x?.carriageNumber), seat: Number(x?.seatNumber) })),
  }));
}

const SEAT_STATUS: Record<number, string> = { 0: "free", 1: "occupied", 2: "mine", 3: "blocked" };

export type SeatCell =
  | { kind: "seat"; seat: number; status: string; facing: "a" | "b"; table: boolean; plug: boolean; wheelchair: boolean; bike: boolean; changeable: boolean }
  | { kind: "gap" }
  | { kind: "empty" };

/** CP's seat map reduced to what the page draws. placeType: 1/2 seats facing either way, 6/7 wheelchair, 8/9 bike, 3–5 gaps, 0 empty. */
export function compactSeatMap(raw: any) {
  return {
    train: Number(raw?.trainNumber),
    carriages: (raw?.carriages ?? []).map((c: any) => ({
      number: Number(c?.number),
      occupancy: Number(c?.occupancyRate ?? 0),
      attributes: Array.isArray(c?.attributes) ? c.attributes : [],
      rows: trimLeadingEmpty((c?.rows ?? []).map((r: any) =>
        (r?.places ?? []).map((p: any): SeatCell => {
          const t = Number(p?.placeType);
          if (typeof p?.seatNumber !== "number") return [3, 4, 5].includes(t) ? { kind: "gap" } : { kind: "empty" };
          return {
            kind: "seat",
            seat: p.seatNumber,
            status: SEAT_STATUS[Number(p?.statusCode)] ?? "blocked",
            facing: [2, 7, 9].includes(t) ? "b" : "a",
            table: Boolean(p?.withTable),
            plug: p?.plugType === 1 || p?.plugType === 2,
            wheelchair: t === 6 || t === 7,
            bike: t === 8 || t === 9,
            changeable: p?.changeable !== false,
          };
        }),
      )),
    })),
  };
}

/** CP pads every row on the left with empty cells; drop the columns that are empty in all rows. */
function trimLeadingEmpty(rows: SeatCell[][]): SeatCell[][] {
  const lead = (r: SeatCell[]) => { const i = r.findIndex((x) => x.kind !== "empty"); return i < 0 ? Infinity : i; };
  const n = Math.min(...rows.map(lead));
  return Number.isFinite(n) && n > 0 ? rows.map((r) => r.slice(n)) : rows;
}

async function assertBeforePayment(cp: CpService, t: SaleToken) {
  const state = await saleState(cp, t);
  if (state.status !== "PENDING") throw new CpError("INVALID_STATE", `Seats can no longer be changed (state ${state.status})`, 409);
  const p = await paymentStatus(cp, t);
  if (p.status) throw new CpError("INVALID_STATE", "Seats cannot be changed after payment was opened", 409);
  return state;
}

export async function seatMap(cp: CpService, token: string, train: number) {
  const t = openToken(token);
  if (!Number.isInteger(train) || train <= 0) throw new CpError("INVALID_INPUT", "Invalid train number");
  try {
    const raw = await cp.http.gateway<any>("ticketing", `/train-seats/${t.saleID}/trains/${train}`, { headers: { "x-cp-client-id": t.clientID } });
    return compactSeatMap(raw);
  } catch (e) {
    if (/sem reserva|não tem reserva|vazia/i.test((e as Error).message)) throw new CpError("NO_SEAT_RESERVATION", "This train has no seat reservation (any free seat)", 404);
    throw e;
  }
}

/** Change this sale's seats on one train. Allowed only before payment is opened. */
export async function changeSeats(cp: CpService, token: string, train: number, requested: { carriage: number; seat: number }[]) {
  const t = openToken(token);
  const state = await assertBeforePayment(cp, t);
  const current = state.trains.find((x) => x.train === train);
  if (!current || !current.seats.length) throw new CpError("NO_SEAT_RESERVATION", "This train has no seat reservation", 404);
  const wanted = (Array.isArray(requested) ? requested : []).map((r) => ({ carriage: Number(r?.carriage), seat: Number(r?.seat) }));
  if (wanted.length !== current.seats.length || wanted.some((r) => !Number.isInteger(r.carriage) || !Number.isInteger(r.seat))) {
    throw new CpError("INVALID_INPUT", `Choose exactly ${current.seats.length} seat(s) on train ${train}`);
  }
  if (new Set(wanted.map((r) => `${r.carriage}-${r.seat}`)).size !== wanted.length) throw new CpError("INVALID_INPUT", "Choose different seats");
  const r = await cp.http.gateway<any>("ticketing", `/train-seats/${t.saleID}`, {
    method: "PUT",
    ...W,
    headers: { "x-cp-client-id": t.clientID },
    body: {
      originalSeats: current.seats.map((x) => ({ carriageNumber: x.carriage, seatNumber: x.seat, trainNumber: train })),
      requestedSeats: wanted.map((x) => ({ carriageNumber: x.carriage, seatNumber: x.seat, trainNumber: train })),
    },
  });
  log.info(`pay: sale ${t.saleID} seats changed on train ${train}`);
  return { trains: trainsOf(r?.travelData ? r : r?.data ?? r), total: r?.totalAmount ?? state.total };
}

/** Release a sale for which no payment can have started (before or when opening payment fails). */
async function release(cp: CpService, saleID: number, clientID: string): Promise<void> {
  try {
    await cp.http.gateway("ticketing", `/sale/${saleID}`, { method: "DELETE", ...W, headers: { "x-cp-client-id": clientID } });
    log.info(`pay: sale ${saleID} released`);
  } catch (e) {
    log.warn(`pay: sale ${saleID} could not be released (${(e as Error).message}); CP will expire it`);
  }
}

// ---------------------------------------------------------------- status / confirm / cancel / ticket

async function paymentStatus(cp: CpService, t: SaleToken): Promise<{ status?: string; error?: string }> {
  try {
    const r = await cp.http.gateway<any>("ticketing", `/sale/${t.saleID}/payment`, { headers: { "x-cp-client-id": t.clientID } });
    return { status: typeof r === "string" ? r : JSON.stringify(r) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

async function saleState(cp: CpService, t: SaleToken) {
  const s = await cp.http.gateway<any>("ticketing", `/sales/${t.saleID}`, { headers: { "x-cp-client-id": t.clientID } });
  return {
    reference: s?.reference ?? t.reference,
    status: s?.status?.code ?? null,
    status_text: s?.status?.designation ?? null,
    total: s?.totalAmount ?? null,
    trains: trainsOf(s),
    tickets: (s?.travelData?.ticketData ?? []).map((x: any) => ({ ticketID: x?.ticketID ?? null, status: x?.status?.code ?? null })),
  };
}

export async function purchaseStatus(cp: CpService, token: string) {
  const t = openToken(token);
  const [sale, payment] = await Promise.all([saleState(cp, t), paymentStatus(cp, t)]);
  return { ...sale, payment: payment.status ?? null };
}

export async function confirmPurchase(cp: CpService, token: string) {
  const t = openToken(token);
  const before = await saleState(cp, t);
  if (isPaidStatus(before.status)) return { confirmed: true, already: true, ...before };
  const payment = await paymentStatus(cp, t);
  if (payment.status === "RETRY") return { confirmed: false, waiting: true, ...before, payment: payment.status };
  try {
    const r = await cp.http.gateway<any>("ticketing", `/sale/${t.saleID}/confirm`, { method: "PUT", ...W, headers: { "x-cp-client-id": t.clientID } });
    log.info(`pay: sale ${t.saleID} confirm -> ${r?.status?.code}`);
  } catch (e) {
    log.error(`pay: sale ${t.saleID} confirm failed: ${(e as Error).message}`);
    return {
      confirmed: false,
      needs_attention: true,
      message: "CP did not confirm the sale. Do not pay again. If you were charged, contact CP with the reference.",
      ...before,
      payment: payment.status ?? null,
    };
  }
  const after = await saleState(cp, t);
  return { confirmed: isPaidStatus(after.status), ...after, payment: payment.status ?? null };
}

export async function cancelPurchase(cp: CpService, token: string) {
  const t = openToken(token);
  const sale = await saleState(cp, t);
  const payment = await paymentStatus(cp, t);
  const noPayment = payment.status === "RETRY" || /payment not found/i.test(payment.error ?? "");
  if (isPaidStatus(sale.status) || !noPayment) {
    throw new CpError("CANNOT_CANCEL", "A payment may exist for this sale, so it was not cancelled. Check the status or contact CP.", 409);
  }
  await cp.http.gateway("ticketing", `/sale/${t.saleID}`, { method: "DELETE", ...W, headers: { "x-cp-client-id": t.clientID } });
  log.info(`pay: sale ${t.saleID} cancelled`);
  return { cancelled: true };
}

export async function ticketPdf(cp: CpService, token: string, ticketID: string): Promise<{ status: number; type: string; body: Buffer }> {
  const t = openToken(token);
  if (!/^[0-9A-Za-z-]{1,40}$/.test(ticketID)) throw new CpError("INVALID_INPUT", "Invalid ticket id");
  const cfg = (await cp.http.config.get()).config;
  const r = await fetch(`${cfg.ticketingApiUrl}/e-ticket/${t.saleID}/${encodeURIComponent(t.reference)}/${encodeURIComponent(ticketID)}`, {
    headers: {
      ...(cfg.ticketingApiKey ? { "X-Api-Key": cfg.ticketingApiKey } : {}),
      "x-cp-connect-id": cfg.xcck,
      "x-cp-connect-secret": cfg.xccs,
      "x-cp-client-id": t.clientID,
      Accept: "application/pdf",
    },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: r.status, type: r.headers.get("content-type") ?? "application/pdf", body: Buffer.from(await r.arrayBuffer()) };
}
