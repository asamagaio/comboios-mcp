import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService, ServiceCode } from "./cp.js";
import { registerJourneyTools } from "./tools/journeys.js";
import { registerStationTools } from "./tools/stations.js";
import { registerBoardTool } from "./tools/board.js";
import { registerTrainTool } from "./tools/train.js";
import { registerAlertsTool } from "./tools/alerts.js";
import { registerCatalogTool } from "./tools/catalog.js";
import { registerPurchaseTool } from "./tools/purchase.js";
import { registerBuyTool } from "./tools/buy.js";
import { paymentsEnabled } from "./public.js";
import { registerUiResources } from "./ui.js";

export const SERVER_INFO = { name: "comboios-mcp", version: "0.1.0" };

export interface ServerContext {
  cp: CpService;
  serviceCodes: ServiceCode[] | null;
}

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "Unofficial access to Comboios de Portugal (CP) data: stations, journeys with fares, live boards, train status and alerts. " +
      "Dates are YYYY-MM-DD and times HH:MM in Europe/Lisbon. Station arguments accept names (fuzzy) or CP codes (94-xxxx); " +
      "if a name is ambiguous the tool returns candidates, so ask the user or call procurar_estacao. Data comes from CP's website " +
      "back end and may be incomplete. " +
      "Answer in text by default. Use mostrar_horarios (interactive cards) only when the user wants to see and compare several trains, " +
      "or to buy; when a sentence or a short list answers the question better, use horarios and reply in text. " +
      (paymentsEnabled()
        ? "To buy a ticket, give the user the buy_url from horarios or the link from comprar_bilhete: they check their details " +
          "and pay CP (card, MB WAY or PayPal) on our page. Each direction of a return trip is a separate ticket. Nothing is reserved until they pay. " +
          "This service is unofficial; tickets are issued and charged by CP."
        : "To buy, give the user the link from link_compra: they choose the train, enter their details and pay on cp.pt. " +
          "This server never reserves seats or handles personal or payment data."),
  });
  const ui = registerUiResources(server);
  registerStationTools(server, ctx.cp);
  registerJourneyTools(server, ctx.cp, ctx.serviceCodes, ui);
  registerBoardTool(server, ctx.cp);
  registerTrainTool(server, ctx.cp);
  registerAlertsTool(server, ctx.cp);
  registerCatalogTool(server, ctx.cp);
  // With the payment page enabled, buying goes through it (comprar_bilhete / buy_url), not cp.pt.
  if (paymentsEnabled()) registerBuyTool(server, ctx.cp);
  else registerPurchaseTool(server, ctx.cp);
  return server;
}
