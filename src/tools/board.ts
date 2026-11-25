import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService } from "../cp.js";
import { CpError } from "../errors.js";
import { addDays, daysBetween, isValidTime, toMinutes } from "../time.js";
import { handler, hhmm, num, READ_ONLY, station, str } from "./common.js";
import { mapMessages } from "./journeys.js";
import { log } from "../log.js";

export interface BoardArgs {
  station: string;
  view?: "departures" | "arrivals";
  date?: string;
  from_time?: string;
  limit?: number;
}

/** Board windows starting at or after this time also pull the next day's first rows. */
const MIDNIGHT_WINDOW_START = 22 * 60;

export function mapBoardRow(r: any, date: string, view: "DEPARTURES" | "ARRIVALS") {
  const dep = view === "DEPARTURES";
  const scheduled = hhmm(dep ? r?.departureTime : r?.arrivalTime) ?? hhmm(dep ? r?.arrivalTime : r?.departureTime);
  const expected = hhmm(dep ? r?.ETD : r?.ETA);
  return {
    train: num(r?.trainNumber),
    service: str(r?.trainService?.code),
    service_name: str(r?.trainService?.designation),
    origin: station(r?.trainOrigin).name,
    destination: station(r?.trainDestination).name,
    date,
    scheduled,
    expected,
    delay_min: num(r?.delay),
    platform: str(r?.platform),
    // `supression` non-null is taken to mean cancelled (inferred, not verified against a known cancellation).
    cancelled: r?.supression != null && r?.supression !== false,
    ...(r?.supression != null ? { suppression_raw: r.supression } : {}),
    ...(r?.occupancy != null ? { occupancy: r.occupancy } : {}),
  };
}

export async function stationBoard(cp: CpService, a: BoardArgs) {
  const view = (a.view ?? "departures").toUpperCase() as "DEPARTURES" | "ARRIVALS";
  const limit = Math.min(a.limit ?? 15, 50);
  if (a.from_time !== undefined && !isValidTime(a.from_time)) throw new CpError("INVALID_INPUT", "from_time must be HH:MM");
  const st = (await cp.stations()).resolve(a.station);
  const date = await cp.validateDate(a.date, { minOffset: -1 });
  const now = cp.now();
  const fromTime = a.from_time ?? (date === now.date ? now.time : "00:00");

  const res = await cp.stationTimetable(st.code, date, view, fromTime);
  const rows = (Array.isArray(res?.stationStops) ? res.stationStops : []).map((r: any) => mapBoardRow(r, date, view));
  const messages = mapMessages(res?.messages);

  if (rows.length < limit && toMinutes(fromTime) >= MIDNIGHT_WINDOW_START) {
    const next = addDays(date, 1);
    const { calendarLimitDays } = await cp.rulesOrDefault();
    if (daysBetween(now.date, next) <= calendarLimitDays) {
      try {
        const res2 = await cp.stationTimetable(st.code, next, view, "00:00");
        for (const r of Array.isArray(res2?.stationStops) ? res2.stationStops : []) rows.push(mapBoardRow(r, next, view));
      } catch (err) {
        log.warn(`next-day board fetch failed (${(err as Error).message})`);
      }
    }
  }

  return {
    station: { code: st.code, name: st.name },
    view: view.toLowerCase(),
    date,
    from_time: fromTime,
    rows: rows.slice(0, limit),
    messages,
  };
}

export function registerBoardTool(server: McpServer, cp: CpService) {
  server.registerTool(
    "partidas_chegadas",
    {
      title: "Live departures/arrivals board",
      description:
        "Live departures or arrivals for a station, with scheduled and expected times, delay in minutes (null = no real-time data yet) and platform. " +
        "Late-evening requests also include the first trains after midnight; each row carries its own date.",
      inputSchema: {
        station: z.string().min(1).describe("Station code (94-xxxx) or name"),
        view: z.enum(["departures", "arrivals"]).default("departures"),
        date: z.iso.date().optional().describe("YYYY-MM-DD, default today (Lisbon)"),
        from_time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("HH:MM, default now"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    handler((a: BoardArgs) => stationBoard(cp, a)),
  );
}
