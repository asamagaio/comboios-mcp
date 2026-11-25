import { describe, expect, it } from "vitest";
import { listAlerts, mapAlert } from "../src/tools/alerts.js";
import { htmlToText } from "../src/html.js";
import { lisbon, makeCp, on, fixture } from "./helpers.js";

const real = fixture("alerts");

function field(name: string, label: string, data: string) {
  return { name, label, contentFieldValue: { data } };
}

function alert(id: number, opts: { title: string; ends?: string; starts?: string; homepage?: boolean; body?: string; en?: boolean }) {
  const pt = [
    field("Text48691729", "Título conteúdo", opts.title),
    field("Campo69402820", "Lead", "Sub " + opts.title),
    field("Checkbox33013581", "Destaque", opts.homepage ? "true" : "false"),
    field("Date35268359", "Data de início", opts.starts ?? "2026-11-01T00:00:00Z"),
    field("Field40441023", "Data de fim", opts.ends ?? ""),
    field("RichText98970637", "Texto", opts.body ?? "<p>Corpo</p>"),
  ];
  const contentFields: Record<string, unknown> = { "pt-PT": pt };
  if (opts.en) contentFields["en-US"] = [field("Text48691729", "Content title", `EN ${opts.title}`)];
  return { id, friendlyUrlPath: `a-${id}`, dateModified: "2026-11-21T01:03:44Z", contentFields };
}

describe("html to text", () => {
  it("strips tags, decodes entities and keeps paragraph breaks", () => {
    expect(htmlToText("<p>Greve&nbsp;do SMAQ &amp; outros</p><p>Linha do Norte &ndash; afetada</p><ul><li>A</li><li>B</li></ul>")).toBe(
      "Greve do SMAQ & outros\nLinha do Norte – afetada\n\n- A\n- B",
    );
    expect(htmlToText(undefined)).toBe("");
  });
});

describe("alert field map", () => {
  it("maps the real response fields", () => {
    const a = mapAlert(real.item[0], "pt");
    expect(a.title).toBeTruthy();
    expect(a.starts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof a.homepage).toBe("boolean");
    expect(a._bodyText.length).toBeGreaterThan(0);
    expect(a._bodyText).not.toMatch(/<[a-z]/i);
  });

  it("falls back to the label when a field name changes", () => {
    const item = alert(1, { title: "T" });
    (item.contentFields["pt-PT"] as any[])[0].name = "Text99999999";
    expect(mapAlert(item, "pt").title).toBe("T");
  });

  it("falls back to pt-PT when en-US is missing, per field when partial", () => {
    expect(mapAlert(alert(1, { title: "Obras" }), "en")).toMatchObject({ title: "Obras", language: "pt" });
    expect(mapAlert(alert(2, { title: "Obras", en: true }), "en")).toMatchObject({ title: "EN Obras", subtitle: "Sub Obras", language: "en" });
  });
});

describe("perturbacoes", () => {
  const items = [
    alert(1, { title: "Greve", ends: "2026-11-27T00:00:00Z", homepage: true, body: "<p>Linha de Sintra afetada</p>" }),
    alert(2, { title: "Obras antigas", ends: "2026-11-10T00:00:00Z" }),
    alert(3, { title: "Sem fim", ends: "" }),
  ];
  const routes = [on("getContentsList", { item: items, total: 3 })];

  it("drops expired alerts, keeps open-ended ones", async () => {
    const { cp } = makeCp(routes, lisbon("2026-11-22", "10:00"));
    const out = await listAlerts(cp, {});
    expect(out.alerts.map((a) => a.id)).toEqual([1, 3]);
    expect(out.alerts[0]).toMatchObject({ starts: "2026-11-01", ends: "2026-11-27", homepage: true, slug: "a-1", url: "https://www.cp.pt/pt/detalhe-aviso/a-1" });
    expect(out.alerts[0]).not.toHaveProperty("body_text");
  });

  it("include_expired, homepage_only and include_body", async () => {
    const { cp } = makeCp(routes);
    expect((await listAlerts(cp, { include_expired: true })).alerts.length).toBe(3);
    expect((await listAlerts(cp, { homepage_only: true })).alerts.map((a) => a.id)).toEqual([1]);
    const withBody = await listAlerts(cp, { include_body: true });
    expect(withBody.alerts[0]).toMatchObject({ body_text: "Linha de Sintra afetada" });
  });

  it("query matches title, subtitle and body, accent-insensitive", async () => {
    const { cp } = makeCp(routes);
    expect((await listAlerts(cp, { query: "sintra" })).alerts.map((a) => a.id)).toEqual([1]);
    expect((await listAlerts(cp, { query: "GREVE" })).alerts.map((a) => a.id)).toEqual([1]);
    expect((await listAlerts(cp, { query: "sem fim" })).alerts.map((a) => a.id)).toEqual([3]);
  });

  it("handles the real recorded response", async () => {
    const { cp } = makeCp([on("getContentsList", real)], lisbon("2026-11-22", "10:00"));
    const out = await listAlerts(cp, { include_body: true, include_expired: true });
    expect(out.alerts.length).toBe(real.item.length);
    expect(out.alerts.every((a) => typeof a.title === "string" && a.title.length > 0)).toBe(true);
  });
});
