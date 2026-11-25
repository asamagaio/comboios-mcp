import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService } from "../cp.js";
import { handler } from "./common.js";
import { cleanPrefill, quote, sealPrefill } from "../pay.js";
import { buyUrl } from "../public.js";

export interface BuyArgs {
  option_id: string;
  passenger_names?: string[];
  email?: string;
  mobile?: string;
}

export async function buyLink(cp: CpService, a: BuyArgs) {
  const { _search, _trip, ...q } = await quote(cp, a.option_id);
  const prefill = cleanPrefill({ passengers: a.passenger_names, email: a.email, mobile: a.mobile }, q.passengers);
  // Details travel encrypted (2 h), never in plain text in the URL.
  const url = buyUrl(q.option_id) + (prefill ? `&f=${sealPrefill(prefill)}` : "");
  return {
    url,
    ...q,
    prefilled: prefill ? { passenger_names: prefill.passengers.length, email: Boolean(prefill.email), mobile: Boolean(prefill.mobile) } : null,
    instructions:
      "Give this link to the user. On that page they check the details" +
      (prefill ? " (already filled in)" : " (name and email)") +
      ", tick the consent box, can choose their seat on trains with seat reservation (Alfa Pendular, Intercidades) and pay CP with card, MB WAY or PayPal. Nothing is reserved or charged until they continue. " +
      "The ticket PDF is shown on the page and emailed by CP. This service is unofficial (not CP).",
  };
}

/** Registered by createServer only when PAYMENTS_ENABLED=1. */
export function registerBuyTool(server: McpServer, cp: CpService) {
  server.registerTool(
    "comprar_bilhete",
    {
      title: "Buy a ticket (payment page)",
      description:
        "Returns a link to our page where the user buys and pays for a journey option from horarios (card, MB WAY or PayPal, processed by CP). " +
        "If you know the passenger name(s), email or phone from the conversation, pass them so the page opens pre-filled; the user still reviews them, " +
        "gives consent and pays. Do not invent details, and do not ask for ID document numbers (the user can add one on the page). " +
        "For a return trip, call it once per direction (outward option and return option). Does not reserve seats or charge anything by itself.",
      inputSchema: {
        option_id: z.string().describe("Option id from horarios (outward or return option), copied exactly"),
        passenger_names: z.array(z.string()).optional().describe("Full name of each passenger, in order (optional)"),
        email: z.string().optional().describe("Email where CP sends the ticket (optional)"),
        mobile: z.string().optional().describe("Mobile phone, e.g. +351 912345678 (optional)"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    handler((a: BuyArgs) => buyLink(cp, a)),
  );
}
