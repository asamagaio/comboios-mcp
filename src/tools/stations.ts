import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService } from "../cp.js";
import { handler, num, READ_ONLY, str } from "./common.js";

export async function searchStations(cp: CpService, a: { query: string; limit?: number }) {
  const index = await cp.stations();
  return {
    results: index.search(a.query, a.limit ?? 5).map((r) => ({ code: r.code, name: r.name, lat: r.lat, lon: r.lon, score: r.score })),
  };
}

export async function stationInfo(cp: CpService, a: { station: string }) {
  const st = (await cp.stations()).resolve(a.station);
  const info = await cp.stationInfo(st.code);
  return {
    code: st.code,
    name: str(info?.designation) ?? st.name,
    line: str(info?.trainLine),
    address: str(info?.address),
    mobilityAccess: str(info?.mobilityAccess),
    lat: num(info?.latitude) ?? st.lat,
    lon: num(info?.longitude) ?? st.lon,
    services: Array.isArray(info?.services) ? info.services : [],
  };
}

export function registerStationTools(server: McpServer, cp: CpService) {
  server.registerTool(
    "procurar_estacao",
    {
      title: "Search stations",
      description:
        "Find CP stations by name (accent-insensitive, fuzzy). Returns a ranked list with CP station codes (94-xxxx) to use in other tools.",
      inputSchema: {
        query: z.string().min(2).describe("Station name or part of it, e.g. 'Campanhã', 'sao bento', 'coimbra'"),
        limit: z.number().int().min(1).max(20).default(5),
      },
      annotations: READ_ONLY,
    },
    handler((a: { query: string; limit?: number }) => searchStations(cp, a)),
  );

  server.registerTool(
    "info_estacao",
    {
      title: "Station info",
      description: "Details for one station: line, address, step-free access and facilities (ticket office, WC, parking, metro, ...).",
      inputSchema: { station: z.string().min(1).describe("Station code (94-xxxx) or name") },
      annotations: READ_ONLY,
    },
    handler((a: { station: string }) => stationInfo(cp, a)),
  );
}
