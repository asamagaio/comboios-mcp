import { CpError } from "./errors.js";

/**
 * Phase 2 hands the user a cp.pt search link instead of a prepared sale: cp.pt keeps sales in its own
 * browser storage, so an API-created sale cannot be opened from a link (docs/deeplink.md). The results
 * page rebuilds the search from these query parameters (verified 2026-11-22). This server never creates
 * a sale, holds seats or handles personal or payment data.
 */
export const CP_ORIGIN = "https://www.cp.pt";

export interface SearchLinkParams {
  from: string; // CP code
  to: string; // CP code
  date: string;
  returnDate?: string | null;
  travelClass: number;
  passengers: number;
  lang: "pt" | "en";
}

export function buildSearchUrl(p: SearchLinkParams): string {
  const q = new URLSearchParams({
    passageiros: String(p.passengers),
    selectedClass: String(p.travelClass),
    startDate: p.date,
    departureStation: p.from,
    arrivalStation: p.to,
  });
  if (p.returnDate) q.set("endDate", p.returnDate);
  return assertCpUrl(`${CP_ORIGIN}/${p.lang}/resultado-pesquisa?${q.toString()}`);
}

/** Refuse to hand out any link that is not on https://www.cp.pt/. */
export function assertCpUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new CpError("UNSAFE_LINK", "Refusing to return an invalid URL");
  }
  if (u.protocol !== "https:" || u.host !== "www.cp.pt" || u.username || u.password) {
    throw new CpError("UNSAFE_LINK", `Refusing to return a link outside ${CP_ORIGIN}/`);
  }
  return u.toString();
}
