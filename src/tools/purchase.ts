import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService } from "../cp.js";
import { CpError } from "../errors.js";
import { handler, hhmm, num, str } from "./common.js";
import { prepareSearch, pricesForClass, resolveOption } from "./journeys.js";
import { buildSearchUrl } from "../cplink.js";

function instructions(lang: "pt" | "en", selected: { departure: string | null; trains: (number | null)[] } | null, passengers: number) {
  const pick = selected?.departure
    ? lang === "en"
      ? ` Select the train departing at ${selected.departure}${selected.trains.length ? ` (train ${selected.trains.join(" + ")})` : ""}.`
      : ` Selecione o comboio das ${selected.departure}${selected.trains.length ? ` (comboio ${selected.trains.join(" + ")})` : ""}.`
    : "";
  const totals =
    passengers > 1
      ? lang === "en"
        ? ` cp.pt shows prices for all ${passengers} passengers together.`
        : ` O cp.pt mostra o preço total para os ${passengers} passageiros.`
      : "";
  return lang === "en"
    ? `Open the link to see this search on cp.pt.${pick} Passenger details and payment are entered on cp.pt; nothing is reserved until then.${totals}`
    : `Abra a ligação para ver esta pesquisa no cp.pt.${pick} Os dados dos passageiros e o pagamento são feitos no cp.pt; nada fica reservado até lá.${totals}`;
}

export interface LinkArgs {
  option_id?: string;
  from?: string;
  to?: string;
  date?: string;
  return_date?: string;
  travel_class?: number;
  passengers?: number;
  lang?: "pt" | "en";
}

export async function purchaseLink(cp: CpService, a: LinkArgs) {
  const lang = a.lang ?? "pt";
  if (a.option_id) {
    const { search, trip, direction } = await resolveOption(cp, a.option_id);
    const sections: any[] = Array.isArray(trip?.travelSections) ? trip.travelSections : [];
    const selected = {
      direction: direction === "out" ? "outward" : "return",
      departure: hhmm(trip?.departureTime),
      arrival: hhmm(trip?.arrivalTime),
      trains: sections.map((s) => num(s?.trainNumber)),
      services: typeof trip?.services === "string" ? trip.services.split("|").filter(Boolean) : [],
      prices_eur_per_passenger: pricesForClass(trip?.basePrices, search.travelClass),
      saleable_online: trip?.saleableOnline === true,
    };
    return {
      url: buildSearchUrl({
        from: search.from.code,
        to: search.to.code,
        date: search.date,
        returnDate: search.returnDate,
        travelClass: search.travelClass,
        passengers: search.passengers,
        lang,
      }),
      from: { code: search.from.code, name: search.from.name },
      to: { code: search.to.code, name: search.to.name },
      date: search.date,
      ...(search.returnDate ? { return_date: search.returnDate } : {}),
      travel_class: search.travelClass,
      passengers: search.passengers,
      selected,
      instructions: instructions(lang, selected, search.passengers),
      ...(selected.saleable_online
        ? {}
        : { warning: "CP does not sell this journey online; buy it at a ticket office or ticket machine." }),
    };
  }

  if (!a.from || !a.to) throw new CpError("INVALID_INPUT", "Give option_id, or from and to");
  const p = await prepareSearch(cp, { from: a.from, to: a.to, date: a.date, return_date: a.return_date, passengers: a.passengers });
  const travelClass = a.travel_class ?? 2;
  return {
    url: buildSearchUrl({ from: p.from.code, to: p.to.code, date: p.date, returnDate: p.returnDate, travelClass, passengers: p.passengers, lang }),
    from: { code: p.from.code, name: str(p.from.name) },
    to: { code: p.to.code, name: str(p.to.name) },
    date: p.date,
    ...(p.returnDate ? { return_date: p.returnDate } : {}),
    travel_class: travelClass,
    passengers: p.passengers,
    selected: null,
    instructions: instructions(lang, null, p.passengers),
  };
}

export function registerPurchaseTool(server: McpServer, cp: CpService) {
  server.registerTool(
    "link_compra",
    {
      title: "Link to buy on cp.pt",
      description:
        "Returns a cp.pt link that opens the search results for a journey, so the user can pick the train, enter passenger details and pay on cp.pt. " +
        "Pass option_id from horarios to also say which train to select, or from/to/date. " +
        "This does not reserve seats, create a sale or take any personal or payment data; the user completes the purchase on cp.pt.",
      inputSchema: {
        option_id: z.string().optional().describe("Option id from horarios, copied exactly, e.g. '2026-11-30_94-30007_94-2006_c2_p1_out521'"),
        from: z.string().optional().describe("Origin station name or code (when no option_id)"),
        to: z.string().optional().describe("Destination station name or code (when no option_id)"),
        date: z.iso.date().optional().describe("Travel date YYYY-MM-DD, default today"),
        return_date: z.iso.date().optional(),
        travel_class: z.union([z.literal(1), z.literal(2)]).optional().describe("Default 2"),
        passengers: z.number().int().min(1).max(9).optional().describe("Adults, default 1"),
        lang: z.enum(["pt", "en"]).default("pt").describe("cp.pt page language"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    handler((a: LinkArgs) => purchaseLink(cp, a)),
  );
}
