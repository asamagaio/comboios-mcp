import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService } from "../cp.js";
import { handler, READ_ONLY } from "./common.js";

export async function classesAndRules(cp: CpService) {
  const [classes, rules, services] = await Promise.all([cp.classes(), cp.rules(), cp.serviceCodesOrNull()]);
  return {
    classes,
    calendar_limit_days: rules.calendarLimitDays,
    passengers: { min: rules.minTickets, max: rules.maxTickets },
    service_codes: services,
    rules: rules.raw.filter((r) => r.key !== "wks_username"),
  };
}

export function registerCatalogTool(server: McpServer, cp: CpService) {
  server.registerTool(
    "classes_e_regras",
    {
      title: "Classes, rules and service codes",
      description: "Travel classes, booking horizon (days ahead), passenger limits and the service codes (AP, IC, ...) CP uses.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    handler(() => classesAndRules(cp)),
  );
}
