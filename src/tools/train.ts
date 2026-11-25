import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService } from "../cp.js";
import { CpError } from "../errors.js";
import { addDays } from "../time.js";
import { handler, hhmm, num, READ_ONLY, station, str } from "./common.js";
import { mapMessages } from "./journeys.js";
import { log } from "../log.js";

export interface TrainArgs {
  train_number: number;
  date?: string;
}

/** Before this local time, a lookup without a date also considers trains that left yesterday. */
const EARLY_MORNING_CUTOFF = 3 * 60;

export function mapCpTrain(raw: any, date: string, stationName: (code: string | null) => string | null) {
  const stopsRaw: any[] = Array.isArray(raw?.trainStops) ? raw.trainStops : [];
  const stops = stopsRaw.map((s, i) => {
    const first = i === 0;
    const last = i === stopsRaw.length - 1;
    let arr = hhmm(s?.arrival);
    let dep = hhmm(s?.departure);
    // "00:00" at the first stop's arrival (or last stop's departure) means "none", not midnight.
    if (first && arr === "00:00") arr = null;
    if (last && dep === "00:00" && stopsRaw.length > 1) dep = null;
    return {
      station: station(s?.station),
      scheduled_arr: arr,
      scheduled_dep: dep,
      expected_arr: hhmm(s?.ETA),
      expected_dep: hhmm(s?.ETD),
      delay_min: num(s?.delay),
      platform: str(s?.platform),
      cancelled: s?.supression != null && s?.supression !== false,
    };
  });
  const lastCode = str(raw?.lastStationCode);
  return {
    source: "cp",
    train: num(raw?.trainNumber),
    date,
    service: str(raw?.serviceCode?.code),
    service_name: str(raw?.serviceCode?.designation),
    status: str(raw?.status),
    delay_min: num(raw?.delay),
    last_station: lastCode ? { code: lastCode, name: stationName(lastCode) } : null,
    has_disruptions: raw?.hasDisruptions === true,
    duration: str(raw?.duration),
    messages: mapMessages(raw?.messages),
    stops,
  };
}

/** Infraestruturas de Portugal NodeID 9402006 -> CP code 94-2006. */
export function nodeIdToCode(nodeId: unknown): string | null {
  const s = String(nodeId ?? "");
  if (!/^94\d+$/.test(s)) return null;
  return `94-${Number(s.slice(2))}`;
}

export function mapIpTrain(raw: any, trainNumber: number, date: string) {
  const r = raw?.response;
  // IP answers 200 with every field null when the train does not run that day.
  if (!r || typeof r !== "object" || !Array.isArray(r.NodesPassagemComboio) || !r.NodesPassagemComboio.length) {
    throw new CpError("NOT_FOUND", `No data for train ${trainNumber} on ${date}`, 404);
  }
  const situation = str(r.SituacaoComboio);
  const delayMatch = situation ? /atraso de (\d+) min/i.exec(situation) : null;
  const nodes: any[] = Array.isArray(r.NodesPassagemComboio) ? r.NodesPassagemComboio : [];
  return {
    source: "infraestruturas_de_portugal",
    note: "CP was unavailable; data from Infraestruturas de Portugal (scheduled times only, expected time where IP reports it).",
    train: trainNumber,
    date,
    service: str(r.TipoServico),
    status: situation,
    delay_min: delayMatch ? Number(delayMatch[1]) : null,
    origin: str(r.Origem),
    destination: str(r.Destino),
    duration: str(r.DuracaoViagem),
    stops: nodes.map((n) => {
      const obs = str(n?.Observacoes);
      const expected = obs ? /(\d{2}:\d{2})/.exec(obs)?.[1] ?? null : null;
      return {
        station: { code: nodeIdToCode(n?.NodeID), name: str(n?.NomeEstacao) },
        scheduled: hhmm(n?.HoraProgramada),
        expected,
        passed: n?.ComboioPassou === true,
        remarks: obs,
      };
    }),
  };
}

function hasStarted(t: ReturnType<typeof mapCpTrain>): boolean {
  return t.status === "IN_TRANSIT";
}

async function lookup(cp: CpService, trainNumber: number, date: string, names: (c: string | null) => string | null) {
  try {
    const raw = await cp.trainTimetable(trainNumber, date);
    return mapCpTrain(raw, date, names);
  } catch (err) {
    if (err instanceof CpError && err.code === "INVALID_INPUT") throw err;
    log.warn(`CP train lookup failed (${(err as Error).message}); trying Infraestruturas de Portugal`);
    try {
      return mapIpTrain(await cp.ipTrain(trainNumber, date), trainNumber, date);
    } catch (ipErr) {
      log.warn(`IP fallback failed (${(ipErr as Error).message})`);
      throw err;
    }
  }
}

export async function trainStatus(cp: CpService, a: TrainArgs) {
  if (!Number.isInteger(a.train_number) || a.train_number <= 0) throw new CpError("INVALID_INPUT", "train_number must be a positive integer");
  // Station names are a nicety; if CP is unavailable, carry on so the IP fallback can answer.
  const index = await cp.stations().catch(() => null);
  const names = (code: string | null) => (code && index ? index.byCode.get(code)?.name ?? null : null);
  const date = await cp.validateDate(a.date, { minOffset: -1 });
  const today = await lookup(cp, a.train_number, date, names);

  const now = cp.now();
  if (a.date !== undefined || now.minutes >= EARLY_MORNING_CUTOFF || today.source !== "cp") return today;
  const cpToday = today as ReturnType<typeof mapCpTrain>;
  if (cpToday.stops.length && hasStarted(cpToday)) return today;

  // Shortly after midnight: the train the user means may have left its origin yesterday.
  try {
    const yesterday = await lookup(cp, a.train_number, addDays(date, -1), names);
    if (yesterday.source === "cp" && hasStarted(yesterday as ReturnType<typeof mapCpTrain>)) {
      return { ...yesterday, note: "Train departed its origin yesterday and is still running." };
    }
    if (!cpToday.stops.length && yesterday.stops.length) return yesterday;
  } catch (err) {
    log.debug(`yesterday lookup failed (${(err as Error).message})`);
  }
  return today;
}

export function registerTrainTool(server: McpServer, cp: CpService) {
  server.registerTool(
    "estado_comboio",
    {
      title: "Live train status",
      description:
        "Live status of a train by number: delay, last station passed, and every stop with scheduled/expected times and platform. " +
        "The date is the departure date at the train's origin (default today; just after midnight it also checks yesterday's run).",
      inputSchema: {
        train_number: z.number().int().positive().describe("Train number, e.g. 521"),
        date: z.iso.date().optional().describe("Departure date at origin, YYYY-MM-DD"),
      },
      annotations: { ...READ_ONLY, idempotentHint: false },
    },
    handler((a: TrainArgs) => trainStatus(cp, a)),
  );
}
