import * as z from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CpService } from "../cp.js";
import { htmlToText } from "../html.js";
import { normalize } from "../stations.js";
import { handler, num, READ_ONLY, str } from "./common.js";
import { log } from "../log.js";

export interface AlertArgs {
  query?: string;
  homepage_only?: boolean;
  include_expired?: boolean;
  include_body?: boolean;
  lang?: "pt" | "en";
}

/**
 * Liferay field names are auto-generated and can change if CP edits the structure.
 * Match by name first, then by label (PT and EN labels).
 */
export const ALERT_FIELDS = {
  title: { names: ["Text48691729"], labels: ["Título conteúdo", "Content title", "Title"] },
  subtitle: { names: ["Campo69402820"], labels: ["Lead"] },
  homepage: { names: ["Checkbox33013581"], labels: ["Destaque", "Highlight", "Featured"] },
  starts: { names: ["Date35268359"], labels: ["Data de início", "Start date"] },
  ends: { names: ["Field40441023"], labels: ["Data de fim", "End date"] },
  body: { names: ["RichText98970637"], labels: ["Texto", "Text"] },
  footnote: { names: ["RichText02523854"], labels: ["Nota de rodapé", "Footnote"] },
  train: { names: ["JournalArticle66157978"], labels: ["Comboio", "Train"] },
} as const;

type FieldKey = keyof typeof ALERT_FIELDS;
const OPTIONAL_FIELDS = new Set<FieldKey>(["train", "footnote"]);
const reportedMisses = new Set<string>();

function findField(fields: any[], key: FieldKey): any | undefined {
  const spec = ALERT_FIELDS[key];
  const byName = fields.find((f) => (spec.names as readonly string[]).includes(f?.name));
  if (byName) return byName;
  const labels = spec.labels.map((l) => normalize(l));
  const byLabel = fields.find((f) => typeof f?.label === "string" && labels.includes(normalize(f.label)));
  if (byLabel) return byLabel;
  if (!OPTIONAL_FIELDS.has(key) && !reportedMisses.has(key)) {
    reportedMisses.add(key);
    log.warn(`alerts: field "${key}" not found by name or label; CP may have changed the content structure`);
  }
  return undefined;
}

function fieldData(f: any): string {
  const d = f?.contentFieldValue?.data;
  return typeof d === "string" ? d : "";
}

/** ISO datetime -> YYYY-MM-DD, or null when empty. */
function isoDate(s: string): string | null {
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

export function mapAlert(item: any, lang: "pt" | "en") {
  const cf = item?.contentFields;
  // contentFields is usually keyed by locale; tolerate a plain array too.
  const pt: any[] = Array.isArray(cf) ? cf : Array.isArray(cf?.["pt-PT"]) ? cf["pt-PT"] : [];
  const en: any[] = !Array.isArray(cf) && Array.isArray(cf?.["en-US"]) ? cf["en-US"] : [];
  const fields = lang === "en" && en.length ? en : pt;
  const get = (k: FieldKey) => {
    const v = fieldData(findField(fields, k));
    if (v || fields === pt) return v;
    return fieldData(findField(pt, k)); // per-field fallback to Portuguese
  };
  const trainField = findField(fields, "train");
  const trainValue = trainField?.contentFieldValue;
  const hasTrain = trainValue && typeof trainValue === "object" && Object.keys(trainValue).length > 0 && JSON.stringify(trainValue) !== '{"data":""}';
  const bodyHtml = get("body");
  const footHtml = get("footnote");
  return {
    id: num(item?.id) ?? item?.id ?? null,
    slug: str(item?.friendlyUrlPath),
    url: str(item?.friendlyUrlPath) ? `https://www.cp.pt/${lang}/detalhe-aviso/${encodeURIComponent(item.friendlyUrlPath)}` : null,
    title: get("title") || str(item?.title) || "",
    subtitle: get("subtitle") || null,
    starts: isoDate(get("starts")),
    ends: isoDate(get("ends")),
    updated: str(item?.dateModified),
    homepage: get("homepage") === "true",
    priority: num(item?.priority),
    language: fields === en ? "en" : "pt",
    _bodyText: htmlToText(bodyHtml),
    _footnoteText: htmlToText(footHtml),
    ...(hasTrain ? { linked_train_raw: trainValue } : {}),
  };
}

export async function listAlerts(cp: CpService, a: AlertArgs) {
  const raw = await cp.alerts();
  const items: any[] = Array.isArray(raw?.item) ? raw.item : Array.isArray(raw?.items) ? raw.items : [];
  const today = cp.now().date;
  const lang = a.lang ?? "pt";
  const q = a.query ? normalize(a.query) : null;
  const alerts = items
    .map((it) => mapAlert(it, lang))
    .filter((al) => a.include_expired || !al.ends || al.ends >= today)
    .filter((al) => !a.homepage_only || al.homepage)
    .filter((al) => !q || normalize(`${al.title} ${al.subtitle ?? ""} ${al._bodyText}`).includes(q))
    .map(({ _bodyText, _footnoteText, ...al }) =>
      a.include_body ? { ...al, body_text: _bodyText, ...(_footnoteText ? { footnote_text: _footnoteText } : {}) } : al,
    );
  return { today, total_upstream: num(raw?.total) ?? items.length, alerts };
}

export function registerAlertsTool(server: McpServer, cp: CpService) {
  server.registerTool(
    "perturbacoes",
    {
      title: "Service alerts and disruptions",
      description:
        "Current CP service alerts (strikes, works, disruptions). Expired alerts are dropped unless include_expired. " +
        "Use include_body for the full text (larger response). query filters title, subtitle and body (accent-insensitive).",
      inputSchema: {
        query: z.string().optional().describe("Text filter, e.g. a line, station, or 'greve'"),
        homepage_only: z.boolean().default(false).describe("Only alerts featured on the cp.pt homepage"),
        include_expired: z.boolean().default(false),
        include_body: z.boolean().default(false).describe("Include the plain-text body and footnote"),
        lang: z.enum(["pt", "en"]).default("pt"),
      },
      annotations: READ_ONLY,
    },
    handler((a: AlertArgs) => listAlerts(cp, a)),
  );
}
